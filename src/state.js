/**
 * CharacterBridge Extension - Shared State
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
 * Shared mutable bridge state.
 * Using a single object avoids circular imports when multiple modules need the
 * same mutable values.
 */
export const sharedState = {
  lastActiveChatId: null,
};

/**
 * Chatroom WebSocket connection state.
 * Mutated by chatroom-client.js; readable by settings.js and index.js.
 */
export const chatroomConnectionState = {
  /** True when the socket is open and the auth handshake has succeeded. */
  isConnected: false,
  /** Last error string, or null when healthy. */
  lastError: null,
};
