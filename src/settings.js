/**
 * CharacterBridge Extension - Settings
 * Based on SillyTavern-Discord-Connector by senjinthedragon (AGPL-3.0)
 *
 * Extension settings - name, defaults, accessor, and status indicator.
 */

export const MODULE_NAME = "SillyTavern-Discord-Connector";

export const DEFAULT_SETTINGS = {
  bridgeUrl: "ws://localhost:2333",
  sharedSecret: "",
  autoConnect: true,
  expressionMode: "status",
  /** Direct Chatroom backend URL (Variante 3 — no middleware). */
  chatroomUrl: "",
  /** Shared secret for the first-frame auth handshake with Chatroom. */
  chatroomSharedSecret: "",
  /** Roleplay-Room-ID die diese ST-Instanz bedient. Pflicht. */
  chatroomRoomId: "",
  /** Optionaler Bridge-Identifier fuer Logging server-seitig. */
  chatroomBridgeId: "",
  /** Whether to auto-connect to Chatroom on page load. */
  chatroomAutoConnect: true,
};

let _initialized = false;

export function getSettings() {
  const { extensionSettings } = SillyTavern.getContext();
  if (!_initialized) {
    extensionSettings[MODULE_NAME] = {
      ...DEFAULT_SETTINGS,
      ...(extensionSettings[MODULE_NAME] || {}),
    };
    _initialized = true;
  }

  const s = extensionSettings[MODULE_NAME];
  if (!["off", "status", "full"].includes(s.expressionMode)) {
    s.expressionMode = DEFAULT_SETTINGS.expressionMode;
  }
  return s;
}

export function updateStatus(message, color) {
  const el = document.getElementById("discord_connection_status");
  if (el) {
    el.textContent = `Status: ${message}`;
    el.style.color = color;
  }
}
