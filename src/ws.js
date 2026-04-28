/**
 * CharacterBridge Extension - WebSocket Adapter Shim
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
 */

/**
 * Backward-compatibility shim.
 *
 * Previously this module owned the raw WebSocket state (setWs/getWs/safeSend).
 * Variante 3 moves all connection logic into chatroom-client.js; this file
 * re-exports a safeSend wrapper that delegates to chatroom-client.send() so
 * that all existing callers (commands.js, expression-relay.js, image-relay.js,
 * inventory.js, recap.js) continue to work without modification.
 *
 * The raw setWs/getWs API is kept for index.js compatibility but is a no-op:
 * the socket is now managed exclusively by chatroom-client.js.
 */

import { send } from './chatroom-client.js';

/**
 * No-op — socket lifecycle is managed by chatroom-client.js.
 * @deprecated
 */
export function setWs(_socket) {}

/**
 * No-op — direct socket access is no longer needed by callers.
 * @deprecated
 * @returns {null}
 */
export function getWs() { return null; }

/**
 * Sends a JSON payload to the Chatroom backend.
 * Delegates to chatroom-client.send(); silently dropped when not connected.
 *
 * @param {object} payload
 */
export function safeSend(payload) {
  send(payload);
}
