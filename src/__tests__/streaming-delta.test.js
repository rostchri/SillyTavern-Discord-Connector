/**
 * streaming-delta.test.js — Unit tests for stream delta computation
 *
 * Tests that cumulative token snapshots from STREAM_TOKEN_RECEIVED are
 * converted to true per-chunk deltas, that lastSent is reset on each new
 * stream, and that empty deltas are suppressed.
 *
 * Run:
 *   cd /tmp/cb-fork/src && node --test __tests__/streaming-delta.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripThinkingPrefix } from '../thinking-utils.js';

// ---------------------------------------------------------------------------
// Pure delta-computation logic extracted from the streamCallback pattern.
// We test the algorithm in isolation so the tests don't need the full ST env.
// ---------------------------------------------------------------------------

/**
 * Simulates the delta-derivation logic from streamCallback.
 * Uses length-based delta tracking (O(1)) matching the production implementation.
 * Returns an array of emitted deltas (empty deltas are suppressed).
 *
 * @param {string[]} snapshots - Sequence of cumulative texts.
 * @param {number} [initialLastSentLength=0] - Simulates lastSentLength at stream start.
 * @returns {{ deltas: string[], finalLastSentLength: number }}
 */
function simulateStream(snapshots, initialLastSentLength = 0) {
  let lastSentLength = initialLastSentLength;
  const deltas = [];

  for (const cumulativeText of snapshots) {
    const visibleText = stripThinkingPrefix(cumulativeText);
    // Length-based delta derivation — O(1) vs O(n) startsWith
    const newPart = visibleText.length >= lastSentLength
      ? visibleText.slice(lastSentLength)
      : visibleText;  // regression fallback: emit full visible
    if (!newPart) continue;  // skip empty deltas
    lastSentLength = visibleText.length;
    deltas.push(newPart);
  }

  return { deltas, finalLastSentLength: lastSentLength };
}

// ---------------------------------------------------------------------------

describe('streaming delta computation', () => {

  it('converts cumulative snapshots to true per-chunk deltas', () => {
    const snapshots = ['He', 'Hello', 'Hello ', 'Hello world'];
    const { deltas } = simulateStream(snapshots);
    assert.deepEqual(deltas, ['He', 'llo', ' ', 'world']);
  });

  it('emits the full first snapshot as the first delta', () => {
    const { deltas } = simulateStream(['Hello']);
    assert.deepEqual(deltas, ['Hello']);
  });

  it('skips empty deltas when snapshot does not advance', () => {
    // Same text twice — second must be suppressed
    const { deltas } = simulateStream(['Hello', 'Hello', 'Hello!']);
    assert.deepEqual(deltas, ['Hello', '!']);
  });

  it('resets correctly when lastSentLength is reset to 0 for new stream', () => {
    // Simulate end of stream 1: lastSentLength was non-zero
    // Then GENERATION_STARTED resets lastSentLength to 0
    // New stream starts fresh
    const { deltas } = simulateStream(['New', 'New stream'], 0);
    assert.deepEqual(deltas, ['New', ' stream']);
  });

  it('uses fallback (emit full visible) when visible text length regresses', () => {
    // Regression: visible text is shorter than what was already sent — emit as-is.
    // initialLastSentLength=17 simulates having already sent 17 chars,
    // then the new snapshot has only 11 visible chars (regression).
    const { deltas } = simulateStream(['Hello world'], 17);
    assert.deepEqual(deltas, ['Hello world']);
  });

  it('produces exactly one delta per distinct snapshot character advance', () => {
    // Single-character advances
    const snapshots = ['a', 'ab', 'abc', 'abcd'];
    const { deltas } = simulateStream(snapshots);
    assert.deepEqual(deltas, ['a', 'b', 'c', 'd']);
  });

  it('suppresses all deltas when every snapshot is identical', () => {
    const { deltas } = simulateStream(['same', 'same', 'same']);
    assert.deepEqual(deltas, ['same']);  // first emits, rest suppressed
  });

  it('strips thinking prefix before deriving delta', () => {
    // Once </think> closes, the visible part starts advancing
    const snapshots = [
      '<think>planning</think>',
      '<think>planning</think>Hello',
      '<think>planning</think>Hello world',
    ];
    const { deltas } = simulateStream(snapshots);
    assert.deepEqual(deltas, ['Hello', ' world']);
  });

  it('suppresses all deltas while thinking block is still open', () => {
    const snapshots = [
      '<think>still',
      '<think>still thinking',
      '<think>still thinking more',
    ];
    const { deltas } = simulateStream(snapshots);
    assert.deepEqual(deltas, []);
  });

  it('emits nothing for empty input snapshots array', () => {
    const { deltas } = simulateStream([]);
    assert.deepEqual(deltas, []);
  });
});
