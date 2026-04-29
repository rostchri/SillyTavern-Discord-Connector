/**
 * chatroom-client.test.js — Unit tests for src/chatroom-client.js
 *
 * Run from repo root:
 *   node --test src/chatroom-client.test.js
 *
 * Strategy:
 *   - chatroom-client.js uses the Browser WebSocket API (global WebSocket).
 *   - We polyfill global.WebSocket with the ws-lib client class so the module
 *     can run in Node without modification.
 *   - A real ws.WebSocketServer is spun up on a random port per test so that
 *     connect/auth/heartbeat/reconnect flows use actual socket I/O.
 *   - Settings are shimmed via globalThis.SillyTavern before each test.
 *   - The module exposes _resetForTest() to clear singleton state between tests.
 */

import { createServer } from 'node:http';
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket as WsClient, WebSocketServer } from '../node_modules/ws/wrapper.mjs';

// ---------------------------------------------------------------------------
// Global shims (Browser APIs expected by chatroom-client.js and its deps)
// ---------------------------------------------------------------------------

globalThis.WebSocket = WsClient;

// Persistent extensionSettings object — MUST be the same reference on every
// getContext() call, because settings.js caches MODULE_NAME into this object
// and reads it back by reference on subsequent calls.
const _extensionSettings = {
  'characterbridge-extension': {
    chatroomUrl: '',
    chatroomSharedSecret: '',
    chatroomAutoConnect: false,
    bridgeUrl: '',
    sharedSecret: '',
    autoConnect: false,
    expressionMode: 'status',
  },
};

// Persistent context object — same reference on every call.
const _stContext = {
  extensionSettings: _extensionSettings,
  saveSettingsDebounced: () => {},
};

globalThis.SillyTavern = {
  getContext: () => _stContext,
};

// DOM shim: updateStatus uses document.getElementById
globalThis.document = { getElementById: () => null };

// ---------------------------------------------------------------------------
// Import SUT (after globals are set)
// ---------------------------------------------------------------------------

import {
  connect,
  disconnect,
  onMessage,
  send,
  sendStreamEnd,
  sendStreamChunk,
  sendUserMessageReply,
  sendExpression,
  sendAvatar,
  sendInventory,
  sendInventoryUpdate,
  sendTypingAction,
  isConnected,
  _getSocket,
  _isAuthenticated,
  _resetForTest,
} from './chatroom-client.js';

import { chatroomConnectionState } from './state.js';
import { getSettings } from './settings.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a ws WebSocketServer on a random port.
 * Returns { wss, port, close() }.
 */
function createTestServer() {
  return new Promise((resolve) => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      resolve({
        wss,
        port,
        close: () =>
          new Promise((res) => {
            wss.clients.forEach((c) => c.terminate());
            wss.close(() => httpServer.close(res));
          }),
      });
    });
  });
}

/**
 * Waits up to `ms` ms for predicate() to return true, polling every `interval` ms.
 */
async function waitFor(predicate, ms = 2000, interval = 20) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}

/** Runs a full test: sets up server, configures settings, runs fn, tears down. */
async function withServer(secret, fn) {
  const srv = await createTestServer();
  // getSettings() initialises the settings object on first call.
  // We must set values on the object it returns (not on _testSettings directly)
  // because getSettings() may have replaced the original object with a merged copy.
  const settings = getSettings();
  settings.chatroomUrl = `ws://127.0.0.1:${srv.port}`;
  settings.chatroomSharedSecret = secret ?? '';
  // Provide room_id whenever a secret is set (required for auth-frame).
  // Empty room_id + empty secret stays in pre-auth test mode.
  settings.chatroomRoomId = secret ? 'test-room' : '';
  try {
    await fn(srv);
  } finally {
    disconnect();
    _resetForTest();
    await srv.close();
    await new Promise((r) => setTimeout(r, 30));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chatroom-client — connect + auth handshake', () => {

  afterEach(() => { _resetForTest(); });

  it('sends auth frame and transitions to connected on auth_ok', async () => {
    await withServer('testsecret', async (srv) => {
      let receivedAuth = null;
      srv.wss.once('connection', (ws) => {
        ws.once('message', (data) => {
          receivedAuth = JSON.parse(data.toString());
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        });
      });

      connect();
      await waitFor(() => isConnected());

      assert.equal(receivedAuth?.type, 'auth');
      assert.equal(receivedAuth?.secret, 'testsecret');
      assert.equal(isConnected(), true);
      assert.equal(chatroomConnectionState.isConnected, true);
    });
  });

  it('sets isConnected=false and suppresses reconnect on auth_failed', async () => {
    await withServer('wrongsecret', async (srv) => {
      srv.wss.once('connection', (ws) => {
        ws.once('message', () => {
          ws.send(JSON.stringify({ type: 'auth_failed', reason: 'bad secret' }));
        });
      });

      connect();
      // Wait for socket to be closed (null) after auth failure
      await waitFor(() => _getSocket() === null, 3000);

      assert.equal(isConnected(), false);
      assert.equal(chatroomConnectionState.isConnected, false);
    });
  });

  it('skips auth frame when no shared secret configured', async () => {
    await withServer('', async (srv) => {
      const serverFrames = [];

      srv.wss.once('connection', (ws) => {
        ws.on('message', (data) => {
          serverFrames.push(JSON.parse(data.toString()));
        });
      });

      connect();
      // Without a secret the client auto-authenticates synchronously in onopen.
      // Wait only on isConnected() — server-side connection callback timing is
      // unpredictable relative to the client onopen event.
      await waitFor(() => isConnected());

      // Short delay to flush any pending I/O before checking serverFrames
      await new Promise((r) => setTimeout(r, 60));

      const authFrames = serverFrames.filter((f) => f.type === 'auth');
      assert.equal(authFrames.length, 0, 'Must not send auth frame without secret');
    });
  });

  it('dispatches _connected synthetic packet after auth', async () => {
    await withServer('', async (srv) => {
      let connectedReceived = false;
      // Register handler BEFORE connect so it catches _connected
      onMessage((pkt) => { if (pkt.type === '_connected') connectedReceived = true; });

      srv.wss.once('connection', () => {});
      connect();
      await waitFor(() => connectedReceived);
      assert.ok(connectedReceived);
    });
  });
});

// ---------------------------------------------------------------------------

describe('chatroom-client — heartbeat', () => {

  afterEach(() => { _resetForTest(); });

  it('responds to server-initiated ping with pong', async () => {
    await withServer('', async (srv) => {
      let serverConn = null;
      const serverReceived = [];
      srv.wss.once('connection', (ws) => {
        serverConn = ws;
        ws.on('message', (data) => {
          serverReceived.push(JSON.parse(data.toString()));
        });
      });

      connect();
      await waitFor(() => isConnected() && serverConn !== null);

      serverConn.send(JSON.stringify({ type: 'ping' }));
      await waitFor(() => serverReceived.some((f) => f.type === 'pong'));

      const pong = serverReceived.find((f) => f.type === 'pong');
      assert.ok(pong, 'Client should reply with pong');
    });
  });

  it('remains connected while server sends pongs', async () => {
    await withServer('', async (srv) => {
      let serverConn = null;
      srv.wss.once('connection', (ws) => { serverConn = ws; });

      connect();
      await waitFor(() => isConnected() && serverConn !== null);

      // Simulate a pong to reset the deadline
      serverConn.send(JSON.stringify({ type: 'pong' }));
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(isConnected(), true);
    });
  });
});

// ---------------------------------------------------------------------------

describe('chatroom-client — packet sending (typed senders)', () => {
  // Shared server for all send tests — more efficient
  let srv = null;
  let serverConn = null;
  let serverReceived = [];

  before(async () => {
    srv = await createTestServer();
    const settings = getSettings();
    settings.chatroomUrl = `ws://127.0.0.1:${srv.port}`;
    settings.chatroomSharedSecret = '';

    srv.wss.once('connection', (ws) => {
      serverConn = ws;
      ws.on('message', (data) => {
        serverReceived.push(JSON.parse(data.toString()));
      });
    });

    connect();
    await waitFor(() => isConnected() && serverConn !== null);
  });

  afterEach(() => { serverReceived = []; });

  after(async () => {
    disconnect();
    _resetForTest();
    await srv.close();
  });

  it('sendUserMessageReply sends ai_reply with correct fields', async () => {
    sendUserMessageReply('Hello world', 'Aria');
    await waitFor(() => serverReceived.some((f) => f.type === 'ai_reply'));
    const p = serverReceived.find((f) => f.type === 'ai_reply');
    assert.equal(p.text, 'Hello world');
    assert.equal(p.char_name, 'Aria');
  });

  it('sendStreamChunk sends stream_chunk with correct fields', async () => {
    sendStreamChunk('sid-1', 'partial text', 'Aria');
    await waitFor(() => serverReceived.some((f) => f.type === 'stream_chunk'));
    const p = serverReceived.find((f) => f.type === 'stream_chunk');
    assert.equal(p.stream_id, 'sid-1');
    assert.equal(p.delta, 'partial text');
    assert.equal(p.char_name, 'Aria');
  });

  it('sendStreamEnd preserves null finalText — NOT coerced to empty string', async () => {
    sendStreamEnd('sid-null', null, 'Aria');
    await waitFor(() => serverReceived.some((f) => f.type === 'stream_end' && f.stream_id === 'sid-null'));
    const p = serverReceived.find((f) => f.type === 'stream_end' && f.stream_id === 'sid-null');
    assert.strictEqual(p.final_text, null, 'null MUST be preserved per spec');
    assert.equal(p.char_name, 'Aria');
  });

  it('sendStreamEnd transmits non-null finalText', async () => {
    sendStreamEnd('sid-text', 'Final answer.', 'Aria');
    await waitFor(() => serverReceived.some((f) => f.type === 'stream_end' && f.stream_id === 'sid-text'));
    const p = serverReceived.find((f) => f.type === 'stream_end' && f.stream_id === 'sid-text');
    assert.equal(p.final_text, 'Final answer.');
  });

  it('sendExpression sends expression_update', async () => {
    sendExpression('Aria', 'happy', 'base64data==');
    await waitFor(() => serverReceived.some((f) => f.type === 'expression_update'));
    const p = serverReceived.find((f) => f.type === 'expression_update');
    assert.equal(p.char_name, 'Aria');
    assert.equal(p.emotion, 'happy');
    assert.equal(p.image_b64, 'base64data==');
  });

  it('sendExpression uses null image when none provided', async () => {
    sendExpression('Aria', 'neutral', null);
    await waitFor(() => serverReceived.some((f) => f.type === 'expression_update' && f.emotion === 'neutral'));
    const p = serverReceived.find((f) => f.type === 'expression_update' && f.emotion === 'neutral');
    assert.strictEqual(p.image_b64, null);
  });

  it('sendAvatar sends avatar_update', async () => {
    sendAvatar('Aria', 'avatardata==');
    await waitFor(() => serverReceived.some((f) => f.type === 'avatar_update'));
    const p = serverReceived.find((f) => f.type === 'avatar_update');
    assert.equal(p.char_name, 'Aria');
    assert.equal(p.image_b64, 'avatardata==');
  });

  it('sendInventory uses ai_character field (not "bots")', async () => {
    sendInventory({ bots: [{ name: 'Aria', avatar_b64: null, description: 'Test' }], personas: [], metadata: {} });
    await waitFor(() => serverReceived.some((f) => f.type === 'character_inventory'));
    const p = serverReceived.find((f) => f.type === 'character_inventory');
    assert.ok(Array.isArray(p.ai_character), 'Must use ai_character field per spec');
    assert.equal(p.ai_character[0].name, 'Aria');
    assert.equal(p.bots, undefined, 'bots field must NOT appear in wire format');
  });

  it('sendInventoryUpdate sends inventory_update', async () => {
    sendInventoryUpdate({ bots: [], personas: [{ name: 'User1' }], metadata: {} });
    await waitFor(() => serverReceived.some((f) => f.type === 'inventory_update'));
    const p = serverReceived.find((f) => f.type === 'inventory_update');
    assert.equal(p.personas[0].name, 'User1');
  });

  it('sendTypingAction sends typing_action with strict boolean active', async () => {
    sendTypingAction('Aria', true);
    await waitFor(() => serverReceived.some((f) => f.type === 'typing_action'));
    const p = serverReceived.find((f) => f.type === 'typing_action');
    assert.equal(p.char_name, 'Aria');
    assert.strictEqual(p.active, true, 'active must be boolean true');
  });

  it('send() is a no-op when not connected', () => {
    // We have a connected client here; test the guard by calling send on a
    // temporarily null socket would require breaking the singleton, which
    // _resetForTest does. Instead verify via a fresh disconnected state.
    _resetForTest();
    // After reset, _authenticated is false — send() must not throw
    assert.doesNotThrow(() => send({ type: 'test' }));
  });
});

// ---------------------------------------------------------------------------

describe('chatroom-client — packet receiving', () => {

  afterEach(() => { _resetForTest(); });

  it('dispatches inbound user_message to onMessage handlers', async () => {
    await withServer('', async (srv) => {
      let serverConn = null;
      srv.wss.once('connection', (ws) => { serverConn = ws; });

      const received = [];
      onMessage((pkt) => { if (pkt.type === 'user_message') received.push(pkt); });

      connect();
      await waitFor(() => isConnected() && serverConn !== null);

      serverConn.send(JSON.stringify({ type: 'user_message', text: 'Hi', persona: 'User1' }));
      await waitFor(() => received.length > 0);

      assert.equal(received[0].text, 'Hi');
      assert.equal(received[0].persona, 'User1');
    });
  });

  it('dispatches inbound command packet', async () => {
    await withServer('', async (srv) => {
      let serverConn = null;
      srv.wss.once('connection', (ws) => { serverConn = ws; });

      const received = [];
      onMessage((pkt) => { if (pkt.type === 'command') received.push(pkt); });

      connect();
      await waitFor(() => isConnected() && serverConn !== null);

      serverConn.send(JSON.stringify({ type: 'command', cmd: 'switchchar', args: ['Aria'] }));
      await waitFor(() => received.length > 0);

      assert.equal(received[0].cmd, 'switchchar');
      assert.deepEqual(received[0].args, ['Aria']);
    });
  });

  it('silently ignores malformed JSON frames', async () => {
    await withServer('', async (srv) => {
      let serverConn = null;
      srv.wss.once('connection', (ws) => { serverConn = ws; });

      connect();
      await waitFor(() => isConnected() && serverConn !== null);

      // Send bad JSON — should not crash or disconnect
      serverConn.send('not json {{{{');
      await new Promise((r) => setTimeout(r, 80));

      assert.equal(isConnected(), true, 'Should still be connected after bad frame');
    });
  });

  it('ignores pre-auth frames other than auth_ok/auth_failed', async () => {
    await withServer('secret', async (srv) => {
      let serverConn = null;
      const handlerPackets = [];

      srv.wss.once('connection', (ws) => {
        serverConn = ws;
        ws.once('message', () => {
          // Send a non-auth packet before responding with auth_ok
          ws.send(JSON.stringify({ type: 'user_message', text: 'early' }));
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        });
      });

      onMessage((pkt) => { if (pkt.type === 'user_message') handlerPackets.push(pkt); });

      connect();
      await waitFor(() => isConnected());
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(handlerPackets.length, 0, 'Pre-auth user_message must be ignored');
    });
  });
});

// ---------------------------------------------------------------------------

describe('chatroom-client — disconnect', () => {

  afterEach(() => { _resetForTest(); });

  it('cleanly disconnects and sets isConnected=false', async () => {
    await withServer('', async (srv) => {
      srv.wss.once('connection', () => {});
      connect();
      await waitFor(() => isConnected());

      disconnect();
      await waitFor(() => !isConnected());

      assert.equal(isConnected(), false);
      assert.equal(chatroomConnectionState.isConnected, false);
    });
  });

  it('suppresses reconnect after manual disconnect', async () => {
    await withServer('', async (srv) => {
      srv.wss.once('connection', () => {});
      connect();
      await waitFor(() => isConnected());

      disconnect();
      await waitFor(() => !isConnected());

      // Wait longer than minimum backoff — should NOT reconnect
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(isConnected(), false, 'Must not reconnect after explicit disconnect');
    });
  });
});

// ---------------------------------------------------------------------------

describe('chatroom-client — reconnect', () => {

  afterEach(() => { _resetForTest(); });

  it('goes to disconnected state when server drops connection', async () => {
    await withServer('', async (srv) => {
      srv.wss.once('connection', () => {});
      connect();
      await waitFor(() => isConnected());

      // Force-terminate from server side
      srv.wss.clients.forEach((c) => c.terminate());

      await waitFor(() => !isConnected(), 1000);
      assert.equal(isConnected(), false);
    });
  });
});
