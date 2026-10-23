import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DEFAULT_APP_BACKGROUND } from '../../domain/appBackground';
import { STORAGE_KEY_APP_BACKGROUND } from '../../infrastructure/config/storageKeys';
import { appBackgroundBridge } from '../../infrastructure/services/appBackgroundBridge';
import { getAppBackgroundActions, getAppBackgroundSnapshot, publishAppBackground } from './appBackgroundStore';
import { useAppBackgroundSettings } from './useAppBackgroundSettings';

const firstId = '12345678-1234-1234-1234-123456789abc.png';
const secondId = '12345678-1234-1234-1234-123456789abd.jpg';

test('wallpaper settings handle restore, transactions, failures and cross-window changes', async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const originalBridge = { ...appBackgroundBridge };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: ReactTestRenderer | undefined;
  let incoming: (event: { key: string; value: unknown }) => void;
  const values = new Map([[STORAGE_KEY_APP_BACKGROUND, JSON.stringify({ enabled: true, imageId: firstId, surfaceOpacity: 0.75 })]]);
  let storageFails = false;
  let notifications = 0;
  const removed: string[] = [];
  const fakeWindow = Object.assign(new EventTarget(), {
    location: { hash: '' },
    netcatty: {
      onSettingsChanged: (callback: typeof incoming) => { incoming = callback; return () => {}; },
      notifySettingsChanged: () => { notifications++; },
    },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (storageFails) throw new Error('storage failure'); values.set(key, value); },
  } });
  appBackgroundBridge.load = async (id) => `data:image/png;base64,${id}`;
  appBackgroundBridge.decode = async () => {};
  appBackgroundBridge.importImage = async () => ({ imageId: secondId });
  appBackgroundBridge.remove = async (id) => {
    assert.notEqual(JSON.parse(values.get(STORAGE_KEY_APP_BACKGROUND)!).imageId, id, 'persist the replacement before deleting an asset');
    removed.push(id);
  };
  let ownerRenders = 0;
  function Probe() { ownerRenders++; useAppBackgroundSettings(true); return null; }
  try {
    await t.test('restoration waits for successful decoding', async () => {
      let finish: () => void;
      appBackgroundBridge.decode = () => new Promise<void>((resolve) => { finish = resolve; });
      await act(async () => { renderer = create(React.createElement(Probe)); });
      assert.equal(getAppBackgroundSnapshot().effectiveEnabled, false);
      await act(async () => { finish!(); });
      assert.equal(getAppBackgroundSnapshot().effectiveEnabled, true);
      appBackgroundBridge.decode = async () => {};
    });
    await t.test('import failure preserves the current wallpaper', async () => {
      appBackgroundBridge.decode = async () => { throw new Error('decode failure'); };
      await act(async () => { await getAppBackgroundActions()!.importImage(); });
      assert.equal(getAppBackgroundSnapshot().settings.imageId, firstId);
      assert.equal(getAppBackgroundSnapshot().effectiveEnabled, true);
      assert.deepEqual(removed, [secondId]);
      appBackgroundBridge.decode = async () => {};
    });
    await t.test('failed persistence cleans up the import and keeps the previous asset', async () => {
      storageFails = true;
      await act(async () => { await getAppBackgroundActions()!.importImage(); });
      storageFails = false;
      assert.equal(getAppBackgroundSnapshot().settings.imageId, firstId);
      assert.equal(removed.includes(firstId), false);
    });
    await t.test('successful replacement and live opacity persist before old asset cleanup', async () => {
      await act(async () => { await getAppBackgroundActions()!.importImage(); });
      assert.equal(getAppBackgroundSnapshot().settings.imageId, secondId);
      assert.equal(getAppBackgroundSnapshot().effectiveEnabled, true);
      assert.ok(removed.includes(firstId));
      const rendersBeforeSlider = ownerRenders;
      await act(async () => { getAppBackgroundActions()!.update({ surfaceOpacity: 0.25 }); });
      assert.equal(getAppBackgroundSnapshot().settings.surfaceOpacity, 0.25);
      assert.equal(ownerRenders, rendersBeforeSlider, 'opacity updates must not rerender the settings/AppShell owner');
    });
    await t.test('incoming settings apply without an IPC echo; missing images fall back', async () => {
      const sent = notifications;
      appBackgroundBridge.load = async () => null;
      await act(async () => { incoming!({ key: STORAGE_KEY_APP_BACKGROUND, value: { enabled: true, imageId: firstId, surfaceOpacity: 0.5 } }); });
      assert.equal(getAppBackgroundSnapshot().effectiveEnabled, false);
      assert.equal(getAppBackgroundSnapshot().error, true);
      assert.equal(notifications, sent);
      await act(async () => { await getAppBackgroundActions()!.removeImage(); });
      assert.equal(getAppBackgroundSnapshot().settings.imageId, null);
    });
    await t.test('late image reads cannot replace a more recent cross-window selection', async () => {
      let finishOldRead: (url: string) => void;
      appBackgroundBridge.load = async (id) => id === firstId
        ? new Promise<string>((resolve) => { finishOldRead = resolve; })
        : `data:image/jpeg;base64,${id}`;
      await act(async () => { incoming!({ key: STORAGE_KEY_APP_BACKGROUND, value: { enabled: true, imageId: firstId } }); });
      await act(async () => { incoming!({ key: STORAGE_KEY_APP_BACKGROUND, value: { enabled: true, imageId: secondId } }); });
      assert.equal(getAppBackgroundSnapshot().effectiveEnabled, true);
      await act(async () => { finishOldRead!(`data:image/png;base64,${firstId}`); });
      assert.equal(getAppBackgroundSnapshot().settings.imageId, secondId);
      assert.match(getAppBackgroundSnapshot().imageUrl!, new RegExp(secondId));
    });
    await t.test('independent windows never load or enable wallpaper', async () => {
      await act(async () => renderer!.unmount());
      fakeWindow.location.hash = '#/editor-window';
      values.set(STORAGE_KEY_APP_BACKGROUND, JSON.stringify({ enabled: true, imageId: firstId }));
      appBackgroundBridge.load = async () => { assert.fail('independent editor loaded a wallpaper'); };
      await act(async () => { renderer = create(React.createElement(Probe)); });
      assert.equal(getAppBackgroundActions(), null);
    });
  } finally {
    await act(async () => renderer?.unmount());
    Object.assign(appBackgroundBridge, originalBridge);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
    publishAppBackground({ settings: DEFAULT_APP_BACKGROUND, imageUrl: null, effectiveEnabled: false, busy: false, error: false });
  }
});
