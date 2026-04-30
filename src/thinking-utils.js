/**
 * thinking-utils.js — Pure helper functions for reasoning/thinking content.
 *
 * Extracted into a separate module so they can be unit-tested without
 * pulling in SillyTavern's browser-only dependencies.
 *
 * No side effects, no imports.
 */

/**
 * Splits a raw AI message into a visible part and an optional thinking block.
 * Matches only a leading `<think>...</think>` tag.
 *
 * @param {string|null|undefined} raw - The raw message text from ST.
 * @returns {{ thinking: string|null, visible: string }}
 */
export function splitThinking(raw) {
  const m = /^<think>([\s\S]*?)<\/think>\s*/.exec(raw || '');
  if (!m) return { thinking: null, visible: raw || '' };
  return { thinking: m[1].trim(), visible: raw.slice(m[0].length) };
}

/**
 * Strips a still-open or already-closed `<think>...</think>` prefix from
 * cumulative streaming text so live token chunks never expose thinking content.
 *
 * Rules:
 *  - No `<think>` tag present   → return text as-is.
 *  - `<think>` open, not closed → thinking still running; return ''.
 *  - `<think>...</think>` done  → return everything after `</think>`.
 *
 * @param {string} text - Cumulative text from STREAM_TOKEN_RECEIVED.
 * @returns {string}
 */
export function stripThinkingPrefix(text) {
  const open = text.indexOf('<think>');
  if (open === -1) return text;
  const close = text.indexOf('</think>');
  if (close === -1) return '';  // thinking still running
  return text.slice(close + '</think>'.length).trimStart();
}
