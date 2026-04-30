/**
 * CharacterBridge Extension - Character Inventory
 * Based on SillyTavern-Discord-Connector by senjinthedragon (AGPL-3.0)
 *
 * Collects all bots (characters) and personas from SillyTavern
 * and sends them as character_inventory / inventory_update packets
 * to the CharacterBridge middleware.
 */

import { sendInventoryUpdate } from "./chatroom-client.js";
import { fetchLocalImageAsBase64 } from "./image-relay.js";

// ---------------------------------------------------------------------------
// Concurrency-limited map (#1818)
// ---------------------------------------------------------------------------

const AVATAR_FETCH_CONCURRENCY = 4;

/**
 * Maps an array of items through an async transform with a bounded concurrency
 * limit. Unlike Promise.all, at most `limit` promises run in parallel at once.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {function(T): Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Avatar cache (#1818)
// ---------------------------------------------------------------------------

/**
 * Cache entry shape: { avatarUrl: string, data: string|null }
 * Keyed by character name (bots) or persona id (personas).
 *
 * @type {Map<string, { avatarUrl: string, data: string|null }>}
 */
const _avatarCache = new Map();

/**
 * Fetches an avatar image as base64, returning the cached value when the URL
 * (or avatar hash) is unchanged.
 *
 * @param {string} cacheKey   Unique identifier (character name or persona id).
 * @param {string|null} avatarId  Raw avatar filename/ID from ST context.
 * @param {string} urlTemplate  URL template with a single `%s` placeholder.
 * @returns {Promise<string|null>}
 */
async function fetchAvatarCached(cacheKey, avatarId, urlTemplate) {
  if (!avatarId) return null;

  const avatarUrl = urlTemplate.replace("%s", encodeURIComponent(avatarId));
  const cached = _avatarCache.get(cacheKey);

  if (cached && cached.avatarUrl === avatarUrl) {
    return cached.data;
  }

  try {
    const result = await fetchLocalImageAsBase64(avatarUrl);
    const data = result ? result.data : null;
    _avatarCache.set(cacheKey, { avatarUrl, data });
    return data;
  } catch (err) {
    console.warn(
      `[CharacterBridge] Failed to fetch avatar for "${cacheKey}":`,
      err,
    );
    return null;
  }
}

/**
 * Clears the avatar cache. Call when a full inventory refresh is needed
 * (e.g. on reconnect).
 */
export function clearAvatarCache() {
  _avatarCache.clear();
}

// ---------------------------------------------------------------------------
// Inventory collection
// ---------------------------------------------------------------------------

/**
 * Collects the full character inventory from SillyTavern's context.
 * Returns bots (AI characters), personas (user identities), and metadata
 * about the active chat state.
 *
 * Avatar fetches are rate-limited to AVATAR_FETCH_CONCURRENCY parallel
 * requests and cached by avatar URL so unchanged avatars skip the network.
 *
 * @returns {Promise<{bots: Array, personas: Array, metadata: object}>}
 */
export async function collectInventory() {
  const ctx = SillyTavern.getContext();
  const characters = ctx.characters || [];
  const powerUser = ctx.powerUserSettings || {};

  // Collect bots (AI characters) — concurrency-limited
  const filteredChars = characters.filter((c) => c.name?.trim());
  const bots = await mapWithConcurrency(
    filteredChars,
    AVATAR_FETCH_CONCURRENCY,
    async (c) => {
      const avatar_b64 = await fetchAvatarCached(
        c.name,
        c.avatar,
        "/characters/%s",
      );
      const description = c.description || "";
      return {
        name: c.name,
        avatar_b64,
        description: description.length > 500 ? description.slice(0, 500) : description,
      };
    },
  );

  // Collect personas (user identities) — concurrency-limited
  const personaMap = powerUser.personas || {};
  const personaDescriptions = powerUser.persona_descriptions || {};
  const personaEntries = Object.entries(personaMap).filter(([, name]) => name?.trim());
  const personas = await mapWithConcurrency(
    personaEntries,
    AVATAR_FETCH_CONCURRENCY,
    async ([id, name]) => {
      const avatar_b64 = await fetchAvatarCached(
        `persona:${id}`,
        id,
        "/User Avatars/%s",
      );
      return {
        id,
        name,
        avatar_b64,
        description: personaDescriptions[id]?.description || "",
      };
    },
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
 * roster and sends inventory_update packets when changes are detected.
 *
 * Uses sendInventoryUpdate from chatroom-client for correct packet type
 * (inventory_update) and snake_case field names (ai_character / personas / metadata).
 */
export function startInventoryWatcher() {
  stopInventoryWatcher();
  _lastFingerprint = computeFingerprint();

  _watcherTimer = setInterval(async () => {
    const newFingerprint = computeFingerprint();
    if (newFingerprint !== _lastFingerprint) {
      _lastFingerprint = newFingerprint;
      try {
        const inventory = await collectInventory();
        sendInventoryUpdate(inventory);
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
