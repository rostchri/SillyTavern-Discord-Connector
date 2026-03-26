/**
 * CharacterBridge Extension - Settings
 * Based on SillyTavern-Discord-Connector by senjinthedragon (AGPL-3.0)
 *
 * Extension settings - name, defaults, accessor, and status indicator.
 */

export const MODULE_NAME = "SillyTavern-CharacterBridge";

export const DEFAULT_SETTINGS = {
  bridgeUrl: "ws://localhost:2333",
  sharedSecret: "",
  autoConnect: true,
  expressionMode: "status",
};

let _initialized = false;

export function getSettings() {
  const { extensionSettings } = SillyTavern.getContext();
  if (!_initialized) {
    extensionSettings[MODULE_NAME] = {
      ...DEFAULT_SETTINGS,
      ...(extensionSettings[MODULE_NAME] || {}),
    };
    _initialized = true;
  }

  const s = extensionSettings[MODULE_NAME];
  if (!["off", "status", "full"].includes(s.expressionMode)) {
    s.expressionMode = DEFAULT_SETTINGS.expressionMode;
  }
  return s;
}

export function updateStatus(message, color) {
  const el = document.getElementById("discord_connection_status");
  if (el) {
    el.textContent = `Status: ${message}`;
    el.style.color = color;
  }
}
