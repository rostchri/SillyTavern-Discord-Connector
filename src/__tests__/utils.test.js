/**
 * utils.test.js — Unit tests for src/utils.js
 *
 * Tests:
 *   - sanitizeSlashArg: existing command-injection sanitization
 *   - sanitizeChatArg: path-traversal prevention (#1811)
 *
 * Run from repo root:
 *   node --test src/__tests__/utils.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSlashArg, sanitizeChatArg } from '../utils.js';

// ---------------------------------------------------------------------------

describe('sanitizeSlashArg', () => {

  it('strips pipe characters', () => {
    assert.equal(sanitizeSlashArg('Alice | /newchat'), 'Alice  /newchat');
  });

  it('strips newline characters', () => {
    assert.equal(sanitizeSlashArg('Alice\n/newchat'), 'Alice/newchat');
    assert.equal(sanitizeSlashArg('Alice\r/newchat'), 'Alice/newchat');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(sanitizeSlashArg('  Alice  '), 'Alice');
  });

  it('caps length at 200 characters', () => {
    const long = 'a'.repeat(300);
    assert.equal(sanitizeSlashArg(long).length, 200);
  });

  it('coerces non-string input', () => {
    assert.equal(sanitizeSlashArg(42), '42');
    assert.equal(sanitizeSlashArg(null), 'null');
  });

  it('returns empty string for empty input', () => {
    assert.equal(sanitizeSlashArg(''), '');
  });
});

// ---------------------------------------------------------------------------

describe('sanitizeChatArg — path traversal prevention (#1811)', () => {

  it('strips double-dot sequences', () => {
    assert.equal(sanitizeChatArg('../secret'), 'secret');
    assert.equal(sanitizeChatArg('../../etc/passwd'), 'etcpasswd');
    assert.equal(sanitizeChatArg('foo/../../bar'), 'foobar');
  });

  it('strips forward slashes', () => {
    assert.equal(sanitizeChatArg('chats/mysession'), 'chatsmysession');
    assert.equal(sanitizeChatArg('/absolute/path'), 'absolutepath');
  });

  it('strips backslashes', () => {
    assert.equal(sanitizeChatArg('..\\windows\\system32'), 'windowssystem32');
    assert.equal(sanitizeChatArg('chat\\file'), 'chatfile');
  });

  it('strips combined traversal sequences', () => {
    assert.equal(sanitizeChatArg('..\\..\\secret'), 'secret');
  });

  it('preserves a clean filename', () => {
    assert.equal(sanitizeChatArg('Aria_2024-01-01'), 'Aria_2024-01-01');
  });

  it('preserves filename with spaces (common in chat names)', () => {
    assert.equal(sanitizeChatArg('My Chat Session'), 'My Chat Session');
  });

  it('also strips pipe and newline (inherits sanitizeSlashArg)', () => {
    assert.equal(sanitizeChatArg('chat|/newchat'), 'chat/newchat'.replace(/\//g, ''));
  });

  it('caps length at 200 characters', () => {
    const long = 'a'.repeat(300);
    assert.equal(sanitizeChatArg(long).length, 200);
  });

  it('returns empty string for a path-only input', () => {
    assert.equal(sanitizeChatArg('../../'), '');
    assert.equal(sanitizeChatArg('/'), '');
    assert.equal(sanitizeChatArg('\\'), '');
  });
});
