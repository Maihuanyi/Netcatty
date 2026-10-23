import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_APP_BACKGROUND, isAppBackgroundWindow, normalizeAppBackground, resolveTerminalBackgroundColor } from './appBackground';

test('wallpaper defaults and normalization preserve backwards compatibility', () => {
  for (const value of [null, undefined, {}, [], 'invalid']) assert.deepEqual(normalizeAppBackground(value), DEFAULT_APP_BACKGROUND);
  assert.deepEqual(normalizeAppBackground({ enabled: 'true', imageId: '../secret.png', surfaceOpacity: NaN }), DEFAULT_APP_BACKGROUND);
  assert.equal(normalizeAppBackground({ surfaceOpacity: -1 }).surfaceOpacity, 0);
  assert.equal(normalizeAppBackground({ surfaceOpacity: 5 }).surfaceOpacity, 1);
  const imageId = '12345678-1234-1234-1234-123456789abc.jpg';
  assert.equal(normalizeAppBackground({ imageId }).imageId, imageId);
});

test('wallpaper is available in the main window and settings only', () => {
  for (const hash of ['', '#/', '#/settings', '#/settings?tab=appearance']) assert.ok(isAppBackgroundWindow(hash));
  for (const hash of ['#/editor-window?id=1', '#/session-window/1', '#/terminal-popup', '#/tray']) assert.equal(isAppBackgroundWindow(hash), false);
});

test('terminal opacity handles short/long hex, existing alpha, RGB and HSL without mutating the palette', () => {
  const state = { effectiveEnabled: true, settings: { ...DEFAULT_APP_BACKGROUND, surfaceOpacity: 0.5 } };
  for (const color of ['#abc', '#abcd', '#aabbcc', '#aabbccff']) assert.equal(resolveTerminalBackgroundColor(color, state), '#aabbcc80');
  assert.equal(resolveTerminalBackgroundColor('rgb(12, 24, 36)', state), 'rgba(12, 24, 36, 0.5)');
  assert.equal(resolveTerminalBackgroundColor('rgba(12 24 36 / 0.2)', state), 'rgba(12, 24, 36, 0.5)');
  assert.equal(resolveTerminalBackgroundColor('hsl(180 50% 50%)', state), 'hsla(180, 50%, 50%, 0.5)');
  assert.equal(resolveTerminalBackgroundColor('#abcd', { ...state, effectiveEnabled: false }), '#abcd');
  assert.equal(resolveTerminalBackgroundColor('invalid', state), 'invalid');
  assert.equal(state.settings.surfaceOpacity, 0.5);
});
