const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const { createSftpFileDragService, helperPath } = require('./sftpFileDragBridge.cjs');

function setup(t, overrides = {}) {
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
  const event = { sender, senderFrame: sender.mainFrame };
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(123n);
  const children = [], calls = [], inspected = [];
  let gesture = {};
  const service = createSftpFileDragService({
    app: { isPackaged: false }, platform: 'win32', getGesture: () => gesture,
    getWindows: () => [{ isDestroyed: () => false, webContents: sender, getNativeWindowHandle: () => handle }],
    getHelperPath: () => 'C:\\app\\helper.exe',
    stat: async target => { inspected.push(target); return { isDirectory: () => true }; },
    run: (...args) => {
      calls.push(args);
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: () => {} });
      children.push(child); return child;
    }, ...overrides,
  });
  t.after(() => service.dispose());
  const payload = { requestId: 'drag', count: 2, copyLabel: 'Download to', invalidLabel: 'Choose a folder', selectionLabel: '2 selected' };
  const reply = (result, child = children.at(-1)) => { child.stdout.write(JSON.stringify(result)); child.emit('close', 0); };
  return { service, event, sender, payload, calls, inspected, children, reply, setGesture: value => { gesture = value; } };
}

test('a physical drop reports its actual folder without preparing or downloading files', async t => {
  const h = setup(t);
  const running = h.service.start(h.event, h.payload);
  assert.deepEqual(h.inspected, [], 'no filesystem inspection while dragging');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][1][0], '123');
  assert.equal(h.calls[0][2].shell, false);
  h.setGesture(undefined);
  h.reply({ status: 'dropped', directory: 'D:\\Desktop', kind: 'desktop' });
  assert.deepEqual(await running, { status: 'dropped', directory: 'D:\\Desktop' });
  assert.deepEqual(h.inspected, ['D:\\Desktop']);
});

test('cancel, Escape/helper cancellation and replaced gestures cannot reuse old destinations', async t => {
  const h = setup(t);
  const first = h.service.start(h.event, h.payload);
  const oldChild = h.children[0];
  const second = h.service.start(h.event, { ...h.payload, requestId: 'second' });
  assert.deepEqual(await first, { status: 'cancelled' });
  h.reply({ status: 'dropped', directory: 'C:\\old', kind: 'explorer' }, oldChild);
  h.service.cancel(h.event, { requestId: 'wrong' });
  h.reply({ status: 'cancelled', directory: 'C:\\stale', kind: 'explorer' });
  assert.deepEqual(await second, { status: 'cancelled' });
  assert.deepEqual(h.inspected, []);
  const third = h.service.start(h.event, h.payload);
  h.setGesture({});
  h.reply({ status: 'dropped', directory: 'C:\\new-gesture', kind: 'folder' });
  assert.deepEqual(await third, { status: 'cancelled' });
  const fourth = h.service.start(h.event, h.payload);
  h.sender.emit('destroyed');
  assert.deepEqual(await fourth, { status: 'cancelled' });
});

test('unauthorized frames, invalid input, released mouse and unsupported platforms do not launch helpers', async t => {
  const h = setup(t);
  await assert.rejects(h.service.start({ ...h.event, senderFrame: {} }, h.payload), /Unauthorized/);
  await assert.rejects(h.service.start(h.event, { ...h.payload, copyLabel: 'bad\0label' }), /Invalid/);
  await assert.rejects(h.service.start(h.event, { ...h.payload, count: 0 }), /Invalid/);
  h.setGesture(undefined);
  assert.deepEqual(await h.service.start(h.event, h.payload), { status: 'cancelled' });
  assert.equal(h.calls.length, 0);
  const linux = setup(t, { platform: 'linux' });
  await assert.rejects(linux.service.start(linux.event, linux.payload), /Windows only/);
});

test('invalid/missing destinations and native failures never become downloads', async t => {
  for (const result of [
    { status: 'dropped', directory: 'relative', kind: 'folder' },
    { status: 'dropped', directory: '\\root-relative', kind: 'folder' },
    { status: 'dropped', directory: '\\\\?\\C:\\device', kind: 'folder' },
    { status: 'dropped', directory: 'C:\\valid', kind: 'unknown' },
  ]) {
    const h = setup(t);
    const pending = h.service.start(h.event, h.payload);
    h.reply(result);
    await assert.rejects(pending, /identify/);
    assert.deepEqual(h.inspected, []);
  }
  const h = setup(t, { stat: async () => ({ isDirectory: () => false }) });
  const pending = h.service.start(h.event, h.payload);
  h.reply({ status: 'dropped', directory: 'C:\\deleted', kind: 'folder' });
  await assert.rejects(pending, /no longer a folder/);
  const native = setup(t);
  const failed = native.service.start(native.event, native.payload);
  native.children[0].emit('error', new Error('missing binary'));
  await assert.rejects(failed, /missing binary/);
});

test('packaged helper resolves beside resources, outside ASAR', () => {
  assert.equal(helperPath({ isPackaged: true }, 'C:\\app\\resources'), path.join('C:\\app\\resources', 'sftpDropTarget', 'NetcattySftpDropTarget.exe'));
  assert.match(helperPath({ isPackaged: false }, undefined, 'x64'), /sftpDropTarget.*build.*x64/);
});

test('drag preview passes bounded plain file names without shell interpolation', async t => {
  const h = setup(t);
  const fileNames = ['中文 report.txt', 'another & file.txt'];
  const pending = h.service.start(h.event, { ...h.payload, fileNames });
  assert.equal(h.calls[0][1][6], fileNames.join('\n'));
  assert.equal(h.calls[0][1][7], '2');
  assert.equal(h.calls[0][2].shell, false);
  h.reply({ status: 'cancelled' });
  await pending;
  for (const names of [[], ['bad\nname'], ['bad\0name'], ['x'.repeat(513)], ['a','b','c','d']]) {
    await assert.rejects(h.service.start(h.event, { ...h.payload, fileNames: names }), /Invalid/);
  }
  assert.equal(h.calls.length, 1);
});

test('cancel requests native cleanup and native crashes launch cursor recovery', async t => {
  const h = setup(t);
  const pending = h.service.start(h.event, h.payload);
  let input = '';
  h.children[0].stdin.on('data', chunk => { input += chunk; });
  h.service.cancel(h.event, h.payload);
  assert.deepEqual(await pending, { status: 'cancelled' });
  assert.equal(input, 'cancel\n');
  h.children[0].emit('close', 0);
  assert.equal(h.calls.length, 1, 'a clean exit already restored its cursor');
  const crashed = h.service.start(h.event, h.payload);
  h.children[1].emit('close', 1);
  await assert.rejects(crashed, /unexpectedly/);
  assert.deepEqual(h.calls[2][1], ['--restore-cursor', '123']);
});
