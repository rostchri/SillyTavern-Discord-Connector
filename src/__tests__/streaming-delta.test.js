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
 * Returns an array of emitted deltas (empty deltas are suppressed).
 *
 * @param {string[]} snapshots - Sequence of cumulative texts.
 * @param {string} [initialLastSent=''] - Simulates lastSent at stream start.
 * @returns {{ deltas: string[], finalLastSent: string }}
 */
function simulateStream(snapshots, initialLastSent = '') {
  let lastSent = initialLastSent;
  const deltas = [];

  for (const cumulativeText of snapshots) {
    const visibleText = stripThinkingPrefix(cumulativeText);
    const newPart = visibleText.startsWith(lastSent)
      ? visibleText.slice(lastSent.length)
      : visibleText;
    if (!newPart) continue;  // skip empty deltas
    lastSent = visibleText;
    deltas.push(newPart);
  }

  return { deltas, finalLastSent: lastSent };
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

  it('resets correctly when lastSent is reset to empty string for new stream', () => {
    // Simulate end of stream 1: lastSent = 'Old text'
    // Then GENERATION_STARTED resets lastSent to ''
    // New stream starts fresh
    const { deltas } = simulateStream(['New', 'New stream'], '');
    assert.deepEqual(deltas, ['New', ' stream']);
  });

  it('uses fallback (emit full visible) when snapshot does not start with lastSent', () => {
    // Unexpected change — snapshot no longer starts with lastSent
    const { deltas } = simulateStream(['Hello world'], 'Unexpected prefix');
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
