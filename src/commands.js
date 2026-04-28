/**
 * CharacterBridge Extension - Command Handlers
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
 * WebSocket message handlers:
 *   handleUserMessage   - injects a user message into ST, streams the AI reply back
 *   handleExecuteCommand - runs slash commands (switchchar, newchat, etc.)
 *
 * Streaming:
 *   Each character turn gets a unique streamId at GENERATION_STARTED.
 *   STREAM_TOKEN_RECEIVED forwards cumulative text to the bridge for throttled
 *   display. GENERATION_ENDED sends stream_end with the final text and charName.
 *   Group chats include the character name; solo chats do not.
 */

import {
  eventSource,
  event_types,
  sendMessageAsUser,
  doNewChat,
  selectCharacterById,
  openCharacterChat,
  getPastCharacterChats,
  Generate,
  setExternalAbortController,
  deleteLastMessage,
} from "../../../../../script.js";

import { executeSlashCommandsWithOptions } from "../../../../../scripts/slash-commands.js";

import { safeSend } from "./ws.js";
import { sharedState } from "./state.js";
import { sanitizeSlashArg } from "./utils.js";
import {
  sendLastMessageImages,
} from "./image-relay.js";
import {
  resetExpressionSignature,
  scheduleExpressionUpdate,
  clearExpressionCache,
} from "./expression-relay.js";

// String fallback covers older ST versions that don't export this event type.
const GROUP_WRAPPER_FINISHED =
  event_types.GROUP_WRAPPER_FINISHED ?? "group_wrapper_finished";

// ---------------------------------------------------------------------------
// Helper: get active character name
// ---------------------------------------------------------------------------

function getActiveCharName() {
  const ctx = SillyTavern.getContext();
  if (ctx.groupId) {
    return ctx.name2 || null;
  }
  if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) {
    return ctx.characters[ctx.characterId].name || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// handleUserMessage
// ---------------------------------------------------------------------------

/**
 * Handles user_message: injects the text into ST, hooks generation lifecycle
 * events to stream tokens to the bridge, and sends the final reply.
 *
 * All event listeners are registered here and removed in every exit path
 * (normal completion, user stop, error) to prevent leaks across sessions.
 *
 * CharacterBridge protocol additions:
 * - stream_chunk includes charName
 * - stream_end includes charName and finalText
 * - ai_reply includes charName
 * - Supports persona field for user identity switching
 */
export async function handleUserMessage(data) {
  sharedState.lastActiveChatId = data.chatId || sharedState.lastActiveChatId;

  // Auto-switch persona if provided in the message
  if (data.persona) {
    try {
      await executeSlashCommandsWithOptions(
        `/persona-set ${sanitizeSlashArg(data.persona)}`,
      );
    } catch (err) {
      console.warn(
        `[CharacterBridge] Failed to switch persona to "${data.persona}":`,
        err,
      );
    }
  }

  const messageState = {
    chatId: data.chatId,
    isStreaming: false,
    streamedAny: false,
  };

  safeSend({
    type: "typing_action",
    chatId: messageState.chatId,
    charName: getActiveCharName(),
    active: true,
  });

  await sendMessageAsUser(data.text);

  let currentStreamId = null;
  let currentCharacterName = null;

  const streamCallback = (cumulativeText) => {
    if (!currentStreamId) return;
    messageState.isStreaming = true;
    messageState.streamedAny = true;
    safeSend({
      type: "stream_chunk",
      chatId: messageState.chatId,
      streamId: currentStreamId,
      charName: currentCharacterName || getActiveCharName(),
      delta: cumulativeText,
    });
  };
  eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

  const sendStreamEnd = () => {
    if (messageState.isStreaming && currentStreamId) {
      const isGroup = !!SillyTavern.getContext().groupId;
      const charName = currentCharacterName || getActiveCharName();

      // Read chat[i].mes rather than relying on streaming pendingText.
      // ST applies sentence-completion trimming to mes after generation ends.
      let finalText = null;
      try {
        const { chat } = SillyTavern.getContext();
        if (chat?.length) {
          for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg.is_user) break;
            if (
              !isGroup ||
              !currentCharacterName ||
              msg.name === currentCharacterName
            ) {
              if (msg.mes?.trim()) {
                finalText = msg.mes.trim();
                break;
              }
            }
          }
        }
      } catch (err) {
        console.warn(
          "[CharacterBridge] Could not read final text from chat array:",
          err,
        );
      }

      safeSend({
        type: "stream_end",
        chatId: messageState.chatId,
        streamId: currentStreamId,
        charName,
        finalText,
      });
    }
    messageState.isStreaming = false;
    currentStreamId = null;
  };

  // Collects all consecutive AI messages since the last user turn and sends
  // them as a single ai_reply payload. Also forwards any embedded images.
  const collectAndSendReplies = () => {
    if (!messageState.chatId) return;
    const { chat } = SillyTavern.getContext();
    if (!chat || chat.length < 2) return;

    const aiMessages = [];
    for (let i = chat.length - 1; i >= 0; i--) {
      const msg = chat[i];
      if (msg.is_user) break;
      if (msg.mes?.trim())
        aiMessages.unshift({
          name: msg.name || "",
          text: msg.mes.trim(),
          charName: msg.name || getActiveCharName(),
        });
    }

    if (aiMessages.length > 0) {
      safeSend({
        type: "ai_reply",
        chatId: messageState.chatId,
        messages: aiMessages,
        charName: getActiveCharName(),
      });
    } else if (!messageState.streamedAny) {
      safeSend({
        type: "error_message",
        chatId: messageState.chatId,
        text: "No response generated.",
      });
    }

    // Forward images from the last AI message (post-generation art, etc.)
    sendLastMessageImages(messageState.chatId).catch((err) =>
      console.warn("[CharacterBridge] sendLastMessageImages failed:", err),
    );
  };

  // True while a background (quiet) generation such as memory consolidation is
  // in flight. GENERATION_STARTED/ENDED for quiet runs must be ignored so they
  // don't prematurely close the listeners before the real generation completes.
  let isQuietGeneration = false;

  // Assigns a new streamId at the start of each character turn.
  // Quiet generations (type === 'quiet') are background tasks like memory
  // consolidation - ignore them so they don't reset state or close listeners.
  const onGenerationStarted = (type) => {
    isQuietGeneration = type === 'quiet';
    if (isQuietGeneration) return;
    currentStreamId = `${messageState.chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const ctx = SillyTavern.getContext();
    currentCharacterName = ctx.groupId ? ctx.name2 || null : null;
  };
  eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

  const removeAllListeners = () => {
    eventSource.removeListener(
      event_types.STREAM_TOKEN_RECEIVED,
      streamCallback,
    );
    eventSource.removeListener(
      event_types.GENERATION_STARTED,
      onGenerationStarted,
    );
    eventSource.removeListener(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.removeListener(GROUP_WRAPPER_FINISHED, onGroupFinished);
    eventSource.removeListener(
      event_types.GENERATION_STOPPED,
      onGenerationStopped,
    );
  };

  // Fires once per character turn. Closes their stream.
  // In solo chat also triggers the final ai_reply.
  const onGenerationEnded = () => {
    if (isQuietGeneration) {
      isQuietGeneration = false;
      return;
    }
    sendStreamEnd();
    if (!SillyTavern.getContext().groupId) {
      removeAllListeners();
      collectAndSendReplies();
    }
  };
  eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

  // Fires once after all group members have finished generating.
  const onGroupFinished = () => {
    removeAllListeners();
    collectAndSendReplies();
  };
  eventSource.on(GROUP_WRAPPER_FINISHED, onGroupFinished);

  // User aborted - clean up without sending a reply.
  const onGenerationStopped = () => {
    if (isQuietGeneration) {
      isQuietGeneration = false;
      return;
    }
    removeAllListeners();
    sendStreamEnd();
  };
  eventSource.once(event_types.GENERATION_STOPPED, onGenerationStopped);

  try {
    const abortController = new AbortController();
    setExternalAbortController(abortController);
    await Generate("normal", { signal: abortController.signal });
  } catch (error) {
    console.error("[CharacterBridge] Generation error:", error);
    await deleteLastMessage();
    safeSend({
      type: "error_message",
      chatId: messageState.chatId,
      text: `Generation failed: ${error.message || "Unknown"}`,
    });
    removeAllListeners();
    sendStreamEnd();
  }
}

// ---------------------------------------------------------------------------
// handleExecuteCommand
// ---------------------------------------------------------------------------

/**
 * Handles execute_command: runs the requested command against SillyTavern's
 * APIs and sends an ai_reply with the result text.
 *
 * Stripped down from the Discord version: no Discord-specific commands
 * (image generation, personas saving to Discord, /sd, etc.)
 * Keeps: newchat, switchchar, switchgroup, listchars, listgroups, listchats,
 *        switchchat, continue, persona
 */
export async function handleExecuteCommand(data) {
  sharedState.lastActiveChatId = data.chatId || sharedState.lastActiveChatId;
  safeSend({
    type: "typing_action",
    chatId: data.chatId,
    charName: getActiveCharName(),
    active: true,
  });

  let replyText = null;
  const context = SillyTavern.getContext();

  try {
    switch (data.command) {
      case "newchat":
        await doNewChat({ deleteCurrentChat: false });
        clearExpressionCache();
        replyText = "New chat started.";
        break;

      case "listchars": {
        const characters = context.characters.filter((c) => c.name?.trim());
        replyText =
          characters.length === 0
            ? "No characters available."
            : "Characters:\n" +
              characters.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
        break;
      }

      case "switchchar": {
        if (!data.args?.length) {
          replyText = "Usage: switchchar <name>";
          break;
        }
        const targetName = data.args.join(" ");
        const target = context.characters.find((c) => c.name === targetName);
        if (target) {
          await selectCharacterById(context.characters.indexOf(target));
          replyText = `Switched to ${targetName}.`;
        } else {
          replyText = `Character "${targetName}" not found.`;
        }
        break;
      }

      case "listgroups": {
        const allGroups = context.groups || [];
        replyText =
          allGroups.length === 0
            ? "No groups available."
            : "Groups:\n" +
              allGroups.map((g, i) => `${i + 1}. ${g.name}`).join("\n");
        break;
      }

      case "switchgroup": {
        if (!data.args?.length) {
          replyText = "Usage: switchgroup <name>";
          break;
        }
        const targetName = data.args.join(" ");
        const target = (context.groups || []).find(
          (g) => g.name === targetName,
        );
        if (target) {
          await executeSlashCommandsWithOptions(
            `/go ${sanitizeSlashArg(target.name)}`,
          );
          replyText = `Switched to group "${targetName}".`;
        } else {
          replyText = `Group "${targetName}" not found.`;
        }
        break;
      }

      case "listchats": {
        if (context.characterId === undefined) {
          replyText = "No character selected.";
          break;
        }
        const chatFiles = await getPastCharacterChats(context.characterId);
        replyText =
          chatFiles.length === 0
            ? "No chats available."
            : "Chats:\n" +
              chatFiles
                .map(
                  (c, i) =>
                    `${i + 1}. ${c.file_name.replace(".jsonl", "")}`,
                )
                .join("\n");
        break;
      }

      case "switchchat": {
        if (!data.args?.length) {
          replyText = "Usage: switchchat <name>";
          break;
        }
        const targetChatFile = data.args.join(" ");
        try {
          await openCharacterChat(targetChatFile);
          replyText = `Switched to chat "${targetChatFile}".`;
        } catch {
          replyText = `Failed to switch to chat "${targetChatFile}".`;
        }
        break;
      }

      case "continue": {
        try {
          executeSlashCommandsWithOptions("/continue").catch(() => {});
        } catch (_) {}
        break;
      }

      case "persona": {
        const personaName = sanitizeSlashArg(data.args?.[0] ?? "");
        if (!personaName) {
          replyText = "Usage: persona <name>";
          break;
        }
        await executeSlashCommandsWithOptions(`/persona-set ${personaName}`);
        replyText = `Switched to persona "${personaName}".`;
        break;
      }

      default:
        replyText = `Unknown command: ${data.command}`;
    }
  } catch (error) {
    console.error("[CharacterBridge] Command error:", error);
    const msg =
      error instanceof Error ? error.message : String(error ?? "Unknown error");
    replyText = `Command error: ${msg}`;
  }

  if (replyText) {
    safeSend({
      type: "ai_reply",
      chatId: data.chatId,
      text: replyText,
      charName: getActiveCharName(),
    });
  }
}
