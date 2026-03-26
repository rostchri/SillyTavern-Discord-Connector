/**
 * CharacterBridge Extension - Character Inventory
 * Based on SillyTavern-Discord-Connector by senjinthedragon (AGPL-3.0)
 *
 * Collects all bots (characters) and personas from SillyTavern
 * and sends them as character_inventory / character_update packets
 * to the CharacterBridge middleware.
 */

import { safeSend } from "./ws.js";
import { fetchLocalImageAsBase64 } from "./image-relay.js";

// ---------------------------------------------------------------------------
// Inventory collection
// ---------------------------------------------------------------------------

/**
 * Fetches the avatar for a character as base64, or returns null on failure.
 *
 * @param {object} character - ST character object with an .avatar property
 * @returns {Promise<string|null>} base64-encoded avatar data, or null
 */
async function fetchAvatarBase64(character) {
  if (!character?.avatar) return null;
  const src = `/characters/${encodeURIComponent(character.avatar)}`;
  const result = await fetchLocalImageAsBase64(src);
  return result ? result.data : null;
}

/**
 * Fetches a user avatar (persona) as base64.
 *
 * @param {string} avatarFile - filename of the user avatar
 * @returns {Promise<string|null>}
 */
async function fetchUserAvatarBase64(avatarFile) {
  if (!avatarFile) return null;
  const src = `/User Avatars/${encodeURIComponent(avatarFile)}`;
  const result = await fetchLocalImageAsBase64(src);
  return result ? result.data : null;
}

/**
 * Collects the full character inventory from SillyTavern's context.
 * Returns bots (AI characters), personas (user identities), and metadata
 * about the active chat state.
 *
 * @returns {Promise<{bots: Array, personas: Array, metadata: object}>}
 */
export async function collectInventory() {
  const ctx = SillyTavern.getContext();
  const characters = ctx.characters || [];
  const powerUser = ctx.powerUserSettings || {};

  // Collect bots (AI characters)
  const bots = await Promise.all(
    characters
      .filter((c) => c.name?.trim())
      .map(async (c) => {
        let avatar_b64 = null;
        try {
          avatar_b64 = await fetchAvatarBase64(c);
        } catch (err) {
          console.warn(
            `[CharacterBridge] Failed to fetch avatar for ${c.name}:`,
            err,
          );
        }
        const description = c.description || "";
        return {
          name: c.name,
          avatar_b64,
          description: description.length > 500 ? description.slice(0, 500) : description,
        };
      }),
  );

  // Collect personas (user identities)
  const personaMap = powerUser.personas || {};
  const personaDescriptions = powerUser.persona_descriptions || {};
  const personas = await Promise.all(
    Object.entries(personaMap)
      .filter(([, name]) => name?.trim())
      .map(async ([id, name]) => {
        let avatar_b64 = null;
        try {
          avatar_b64 = await fetchUserAvatarBase64(id);
        } catch (err) {
          console.warn(
            `[CharacterBridge] Failed to fetch persona avatar for ${name}:`,
            err,
          );
        }
        return {
          id,
          name,
          avatar_b64,
          description: personaDescriptions[id]?.description || "",
        };
      }),
  );

  // Metadata about active state
  const activeGroup = ctx.groupId
    ? (ctx.groups || []).find((g) => g.id === ctx.groupId)
    : null;

  const groupMembers = activeGroup
    ? (activeGroup.members || [])
        .map((id) => characters.find((ch) => ch.id === id)?.name?.trim())
        .filter(Boolean)
    : [];

  const activeCharName =
    ctx.characterId !== undefined
      ? characters[ctx.characterId]?.name || null
      : null;

  const metadata = {
    activeCharacter: activeCharName,
    activeGroup: activeGroup?.name || null,
    groupMembers,
    activeChat: ctx.chatId || null,
  };

  return { bots, personas, metadata };
}

// ---------------------------------------------------------------------------
// Inventory watcher (polling-based change detection)
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 10_000; // 10 seconds

let _watcherTimer = null;
let _lastFingerprint = "";

/**
 * Computes a lightweight fingerprint of the character/persona state
 * so we can detect changes without deep-comparing full objects.
 */
function computeFingerprint() {
  try {
    const ctx = SillyTavern.getContext();
    const charNames = (ctx.characters || [])
      .map((c) => c.name || "")
      .sort()
      .join("|");
    const personaNames = Object.values(
      ctx.powerUserSettings?.personas || {},
    )
      .sort()
      .join("|");
    const activeChar =
      ctx.characterId !== undefined
        ? ctx.characters?.[ctx.characterId]?.name || ""
        : "";
    const activeGroup = ctx.groupId || "";
    return `${charNames}::${personaNames}::${activeChar}::${activeGroup}`;
  } catch {
    return "";
  }
}

/**
 * Starts a polling watcher that detects changes in the character/persona
 * roster and sends character_update packets when changes are detected.
 *
 * @param {function} sendFn - function to send a packet (typically safeSend)
 */
export function startInventoryWatcher(sendFn) {
  stopInventoryWatcher();
  _lastFingerprint = computeFingerprint();

  _watcherTimer = setInterval(async () => {
    const newFingerprint = computeFingerprint();
    if (newFingerprint !== _lastFingerprint) {
      _lastFingerprint = newFingerprint;
      try {
        const inventory = await collectInventory();
        sendFn({
          type: "character_update",
          payload: inventory,
        });
      } catch (err) {
        console.warn("[CharacterBridge] Inventory watcher update failed:", err);
      }
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Stops the inventory watcher.
 */
export function stopInventoryWatcher() {
  if (_watcherTimer) {
    clearInterval(_watcherTimer);
    _watcherTimer = null;
  }
}
