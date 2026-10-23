"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const temp = require("./tempDirBridge.cjs");
const { createAppBackgroundService, registerAppBackgroundHandlers, inspectImage, MAX_BYTES } = require("./appBackground.cjs");

function png(width = 2, height = 2) {
  const bytes = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
const nativeImage = { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 2, height: 2 }) }) };

test('wallpaper assets are immutable copies independent of the source; load/remove accept internal IDs only', async () => {
  const root = await fs.mkdtemp(`${temp.getTempFilePath("wallpaper-service-test")}-`);
  try {
    const source = path.join(root, "photo.png");
    const bytes = png();
    await fs.writeFile(source, bytes);
    const service = createAppBackgroundService({ directory: path.join(root, "backgrounds"), nativeImage, selectFile: async () => source });
    const first = await service.importImage();
    const second = await service.importImage();
    assert.notEqual(first.imageId, second.imageId);
    await fs.rm(source);
    assert.equal(await service.load(first.imageId), `data:image/png;base64,${bytes.toString("base64")}`);
    for (const id of ['../photo.png', 'C:\\secret.png', 'photo.png', null, 'a'.repeat(36) + '.png']) {
      await assert.rejects(service.load(id), /Invalid background image ID/);
      await assert.rejects(service.remove(id), /Invalid background image ID/);
    }
    await service.remove(first.imageId);
    assert.equal(await service.load(first.imageId), null);
    assert.ok(await service.load(second.imageId));
    await service.remove(first.imageId);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('cancel, invalid formats, undecodable files, byte and pixel limits never publish an asset', async () => {
  const root = await fs.mkdtemp(`${temp.getTempFilePath("wallpaper-limits-test")}-`);
  try {
    const source = path.join(root, "source.png");
    const directory = path.join(root, "backgrounds");
    let selected = null;
    let decoded = 0;
    const service = createAppBackgroundService({ directory, nativeImage: {
      createFromBuffer: () => { decoded++; return { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }; },
    }, selectFile: async () => selected });
    assert.equal(await service.importImage(), null);
    selected = source;
    for (const bytes of [Buffer.from('<svg/>'), Buffer.alloc(MAX_BYTES + 1), png(8000, 8000)]) {
      await fs.writeFile(source, bytes);
      await assert.rejects(service.importImage());
    }
    assert.equal(decoded, 0, 'reject huge images before the native decoder allocates pixels');
    await fs.writeFile(source, png());
    await assert.rejects(service.importImage(), /could not be decoded/);
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('JPEG dimensions and malformed segments are bounded', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc2, 0, 8, 8, 0, 20, 0, 30, 0]);
  assert.deepEqual(inspectImage(jpeg), { extension: 'jpg', width: 30, height: 20 });
  assert.throws(() => inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff])));
});

test('wallpaper IPC rejects untrusted senders before opening files or dialogs', async () => {
  const handlers = new Map();
  registerAppBackgroundHandlers({ ipcMain: { handle: (key, handler) => handlers.set(key, handler) },
    app: { getPath: () => 'unused' }, nativeImage, dialog: {}, BrowserWindow: {}, isTrustedSender: () => false });
  assert.equal(handlers.size, 3);
  for (const handler of handlers.values()) await assert.rejects(handler({}, '../file'), /Untrusted/);
});
