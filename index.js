/**
 * CharacterBridge Extension for SillyTavern
 * Based on SillyTavern-Discord-Connector by senjinthedragon (AGPL-3.0)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * Runs inside SillyTavern as a third-party extension. Connects to the
 * CharacterBridge middleware over WebSocket and acts as the intermediary
 * between external clients and SillyTavern's internals.
 *
 * Streaming:
 *   Each character turn gets a unique streamId at GENERATION_STARTED.
 *   STREAM_TOKEN_RECEIVED forwards cumulative text to the bridge for throttled
 *   display. GENERATION_ENDED sends stream_end with charName and finalText.
 *   Group chats include the character name; solo chats do not.
 *
 * Image relay:
 *   Local ST images (thumbnails, generated art, avatars) are fetched here in
 *   the browser - where same-origin access is always available - and sent as
 *   base64 inline data. External URLs are passed through for the bridge to
 *   fetch directly.
 *
 * Character inventory:
 *   On connect, the full character inventory (bots + personas) is sent to the
 *   bridge. A polling watcher detects roster changes and sends incremental
 *   character_update packets.
 *
 * Expression relay:
 *   Watches #expression-image in the ST DOM and forwards expression updates
 *   to the CharacterBridge, including the expression name and optionally the
 *   expression image as base64.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { setWs, getWs, safeSend } from "./src/ws.js";
import { MODULE_NAME, getSettings, updateStatus } from "./src/settings.js";
import { sharedState } from "./src/state.js";
import {
  resetExpressionSignature,
  setupExpressionObserver,
  scheduleExpressionUpdate,
} from "./src/expression-relay.js";
import {
  handleUserMessage,
  handleExecuteCommand,
} from "./src/commands.js";
import {
  collectInventory,
  startInventoryWatcher,
  stopInventoryWatcher,
} from "./src/inventory.js";

// ---------------------------------------------------------------------------
// Connection state (WebSocket lifecycle only - all other state is in src/)
// ---------------------------------------------------------------------------

let shouldReconnect = true;
let reconnectTimeout = null;
let heartbeatInterval = null;

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connect() {
  const ws = getWs();
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  )
    return;

  shouldReconnect = true;

  const settings = getSettings();
  if (!settings.bridgeUrl) {
    updateStatus("URL not set", "red");
    return;
  }

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  updateStatus("Connecting...", "orange");

  // Build the WebSocket URL, appending shared secret as query param if set
  let wsUrl = settings.bridgeUrl;
  if (settings.sharedSecret) {
    const separator = wsUrl.includes("?") ? "&" : "?";
    wsUrl += `${separator}secret=${encodeURIComponent(settings.sharedSecret)}`;
  }

  const socket = new WebSocket(wsUrl);
  setWs(socket);

  socket.onopen = async () => {
    updateStatus("Connected", "green");
    console.log("[CharacterBridge] Connected to bridge server");
    resetExpressionSignature();
    setupExpressionObserver();
    scheduleExpressionUpdate(sharedState.lastActiveChatId);

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      safeSend({ type: "heartbeat" });
    }, 30000);

    // Send the full character inventory on connect
    try {
      const inventory = await collectInventory();
      safeSend({
        type: "character_inventory",
        ...inventory,
      });
    } catch (err) {
      console.warn("[CharacterBridge] Failed to send initial inventory:", err);
    }

    // Start watching for inventory changes
    startInventoryWatcher(safeSend);
  };

  socket.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);

      if (data.type === "heartbeat") return;

      if (data.type === "user_message") {
        await handleUserMessage(data);
        return;
      }

      if (data.type === "execute_command") {
        await handleExecuteCommand(data);
        return;
      }

      if (data.type === "config_update") {
        // Handle dynamic config updates from CharacterBridge
        if (data.settings) {
          const settings = getSettings();
          if (data.settings.expressionMode) {
            settings.expressionMode = data.settings.expressionMode;
            resetExpressionSignature();
            scheduleExpressionUpdate(sharedState.lastActiveChatId);
          }
          SillyTavern.getContext().saveSettingsDebounced();
        }
        return;
      }

      if (data.type === "system_command") {
        if (data.command === "reload_ui_only")
          setTimeout(() => window.location.reload(), 500);
        return;
      }
    } catch (error) {
      console.error("[CharacterBridge] Message handling error:", error);
      if (data?.chatId) {
        safeSend({
          type: "error_message",
          chatId: data.chatId,
          text: "Internal error processing request.",
        });
      }
    }
  };

  socket.onclose = () => {
    updateStatus("Disconnected", "red");
    setWs(null);
    stopInventoryWatcher();

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    const settings = getSettings();
    if (settings.autoConnect && shouldReconnect) {
      updateStatus("Reconnecting...", "orange");
      if (!reconnectTimeout) {
        reconnectTimeout = setTimeout(() => {
          reconnectTimeout = null;
          connect();
        }, 5000);
      }
    }
  };

  socket.onerror = (error) => {
    console.error("[CharacterBridge] WebSocket error:", error);
    updateStatus("Error", "red");
  };
}

function disconnect() {
  shouldReconnect = false;
  stopInventoryWatcher();
  const ws = getWs();
  if (ws) ws.close();
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  updateStatus("Disconnected", "red");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

jQuery(async () => {
  try {
    const settingsHtml = await $.get(
      `/scripts/extensions/third-party/${MODULE_NAME}/settings.html`,
    );
    const $settings = $(settingsHtml);
    $("#extensions_settings").append($settings);

    const settings = getSettings();
    $("#discord_bridge_url").val(settings.bridgeUrl);
    $("#discord_shared_secret").val(settings.sharedSecret);
    $("#discord_auto_connect").prop("checked", settings.autoConnect);
    $("#discord_expression_mode").val(settings.expressionMode);

    $("#discord_bridge_url").on("input", () => {
      getSettings().bridgeUrl = $("#discord_bridge_url").val();
      SillyTavern.getContext().saveSettingsDebounced();
    });

    $("#discord_shared_secret").on("input", () => {
      getSettings().sharedSecret = $("#discord_shared_secret").val();
      SillyTavern.getContext().saveSettingsDebounced();
    });

    $("#discord_auto_connect").on("change", () => {
      getSettings().autoConnect = $("#discord_auto_connect").prop("checked");
      SillyTavern.getContext().saveSettingsDebounced();
    });

    $("#discord_expression_mode").on("change", () => {
      getSettings().expressionMode = $("#discord_expression_mode").val();
      resetExpressionSignature();
      SillyTavern.getContext().saveSettingsDebounced();
      scheduleExpressionUpdate(sharedState.lastActiveChatId);
    });

    $("#discord_connect_button").on("click", connect);
    $("#discord_disconnect_button").on("click", disconnect);

    // -----------------------------------------------------------------------
    // Global tooltip for .dc-info elements
    // -----------------------------------------------------------------------
    const $tip = $('<div id="dc-tooltip"></div>').appendTo("body");
    let tipTarget = null;

    function showTip(el) {
      const text = el.getAttribute("data-tooltip");
      if (!text) return;
      tipTarget = el;
      $tip.text(text);

      const r = el.getBoundingClientRect();
      const tipW = 240;
      let left = r.left + r.width / 2 - tipW / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));

      $tip.css({ left: left + "px", top: "", bottom: "" });

      $tip.addClass("dc-tooltip-visible");
      const tipH = $tip.outerHeight();
      $tip.removeClass("dc-tooltip-visible");

      if (r.top - tipH - 10 >= 8) {
        $tip.css({ top: r.top - tipH - 10 + "px" });
      } else {
        $tip.css({ top: r.bottom + 8 + "px" });
      }

      $tip.addClass("dc-tooltip-visible");
    }

    function hideTip() {
      tipTarget = null;
      $tip.removeClass("dc-tooltip-visible");
    }

    $(document).on("mouseenter", ".dc-info", function () {
      showTip(this);
    });
    $(document).on("mouseleave", ".dc-info", hideTip);
    $(document).on("focus", ".dc-info", function () {
      showTip(this);
    });
    $(document).on("blur", ".dc-info", hideTip);
    $(document).on("touchstart", ".dc-info", function (e) {
      e.preventDefault();
      if (tipTarget === this) {
        hideTip();
      } else {
        showTip(this);
      }
    });
    $(document).on("touchstart", function (e) {
      if (tipTarget && !$(e.target).closest(".dc-info").length) hideTip();
    });

    if (settings.autoConnect) connect();
  } catch (error) {
    console.error("[CharacterBridge] Failed to load settings UI:", error);
  }
});
