const assert = require("node:assert/strict");
const test = require("node:test");
const { createPreloadApi } = require("./api.cjs");

test("local file drag exposes only the dedicated start and cancellation channels", async () => {
  const calls = [];
  const api = createPreloadApi({ ipcRenderer: {
    invoke: async (...args) => { calls.push(args); return { started: true }; },
    send: (...args) => calls.push(args),
  }, webUtils: {} });
  const payload = { requestId: "one", paths: ["/file"] };
  assert.deepEqual(await api.startLocalFileDrag(payload), { started: true });
  api.cancelLocalFileDrag("one");
  assert.deepEqual(calls, [["netcatty:local:drag-start", payload], ["netcatty:local:drag-cancel", { requestId: "one" }]]);
});

test('remote destination drag passes labels and identity without requesting content', async () => {
  const calls = [];
  const api = createPreloadApi({ ipcRenderer: {
    invoke: async (...args) => { calls.push(args); return { status: 'dropped', directory: 'D:\\Desktop' }; },
    send: (...args) => calls.push(args),
  }, webUtils: {} });
  if (process.platform !== 'win32') { assert.equal(api.startSftpFileDrag, undefined); return; }
  const payload = { requestId: 'remote', count: 2, copyLabel: 'Download to', invalidLabel: 'Choose folder', selectionLabel: '2 files' };
  assert.deepEqual(await api.startSftpFileDrag(payload), { status: 'dropped', directory: 'D:\\Desktop' });
  api.cancelSftpFileDrag('remote');
  assert.equal(api.prepareSftpFileDrag, undefined);
  assert.deepEqual(calls, [['netcatty:sftp:drag-start', payload], ['netcatty:sftp:drag-cancel', { requestId: 'remote' }]]);
});
