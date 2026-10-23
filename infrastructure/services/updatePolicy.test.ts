import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, checkForUpdates, downloadUpdate, installUpdate } from './updateService';
import { netcattyBridge } from './netcattyBridge';

test('custom build never contacts the release feed or renderer update bridge', async () => {
  const fetch = globalThis.fetch;
  const getBridge = netcattyBridge.get;
  globalThis.fetch = async () => { throw new Error('Unexpected release request'); };
  netcattyBridge.get = () => { throw new Error('Unexpected update bridge access'); };
  try {
    assert.deepEqual(await checkForUpdates('0.0.0'), { hasUpdate: false, currentVersion: '0.0.0', latestRelease: null });
    assert.deepEqual(await checkForUpdate(), { available: false, supported: false });
    assert.equal((await downloadUpdate()).success, false);
    installUpdate();
  } finally {
    globalThis.fetch = fetch;
    netcattyBridge.get = getBridge;
  }
});
