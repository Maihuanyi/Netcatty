import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useSftpFileDrag } from './useSftpFileDrag';
import type { StartRemoteFileDrag } from './localFileDrag';
import type { SftpStateApi } from '../useSftpState';
import { sftpFileDragBridge } from '../../../infrastructure/services/sftpFileDragBridge';

test('destination drag triggers the normal SFTP queue only after a confirmed drop', async t => {
  const previous = { ...sftpFileDragBridge };
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let sessionId = 'session', current = true;
  let finish!: (result: Awaited<ReturnType<typeof sftpFileDragBridge.start>>) => void;
  const downloads: Parameters<SftpStateApi['downloadToLocal']>[0][] = [];
  const inspected: string[] = [], queued: string[] = [], errors: string[] = [];
  let dragPayload: Parameters<typeof sftpFileDragBridge.start>[0];
  sftpFileDragBridge.start = payload => { dragPayload = payload; return new Promise(resolve => { finish = resolve; }); };
  sftpFileDragBridge.stat = async (id, path, encoding) => {
    assert.equal(id, 'session'); assert.equal(encoding, 'gb18030'); inspected.push(path);
    return { type: path.endsWith('folder') ? 'directory' : 'file', size: 7, lastModified: 1 } as SftpStatResult;
  };
  const ref = { current: {
    getActivePane: () => ({ id: 'pane', connection: { id: 'remote', hostId: 'host', hostLabel: 'Test', isLocal: false }, filenameEncoding: 'gb18030' }),
    getSftpIdForConnection: () => sessionId,
    downloadToLocal: async params => { downloads.push(params); return 'completed'; },
  } as unknown as SftpStateApi };
  let start!: StartRemoteFileDrag, renderer: ReactTestRenderer;
  function Probe() {
    start = useSftpFileDrag(ref, { t: key => key, onQueued: directory => { queued.push(directory); }, onError: message => { errors.push(message); } });
    return null;
  }
  t.after(async () => {
    await act(async () => renderer?.unmount()); Object.assign(sftpFileDragBridge, previous);
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
  });
  await act(async () => { renderer = create(React.createElement(Probe)); });
  const request = { requestId: 'request', paneId: 'pane', connectionId: 'remote', side: 'right' as const,
    isCurrent: () => current,
    sources: [{ name: '中文.txt', sourcePath: '/first', sourceConnectionId: 'remote', isDirectory: false },
      { name: 'folder', sourcePath: '/second', sourceConnectionId: 'remote', isDirectory: true }] };
  const pending = start(request);
  assert.equal(dragPayload!.count, 2);
  assert.deepEqual(dragPayload!.fileNames, ['中文.txt', 'folder']);
  assert.equal('files' in dragPayload!, false, 'native helper must not receive remote files or prepare content');
  assert.deepEqual(inspected, []); assert.deepEqual(downloads, []);
  finish({ status: 'dropped', directory: 'D:\\Desktop' }); await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(inspected, ['/first/中文.txt', '/second/folder']);
  assert.equal(downloads.length, 2);
  assert.deepEqual(downloads[0], { fileName: '中文.txt', sourcePath: '/first/中文.txt', targetPath: 'D:\\Desktop\\中文.txt',
    sftpId: 'session', connectionId: 'remote', sourceHostId: 'host', sourceHostLabel: 'Test', sourceEncoding: 'gb18030', isDirectory: false, totalBytes: 7 });
  assert.equal(downloads[1].isDirectory, true);
  assert.deepEqual(queued, ['D:\\Desktop']); assert.deepEqual(errors, []);

  const count = downloads.length, reads = inspected.length;
  const cancelled = start(request); finish({ status: 'cancelled' }); await cancelled;
  assert.equal(downloads.length, count); assert.equal(inspected.length, reads);
  const stale = start(request); current = false; finish({ status: 'dropped', directory: 'C:\\wrong' }); await stale;
  assert.equal(downloads.length, count); assert.equal(inspected.length, reads);
  current = true;
  const reconnected = start(request); sessionId = 'new-session'; finish({ status: 'dropped', directory: 'C:\\wrong' });
  await assert.rejects(reconnected, /connection changed/);
  assert.equal(downloads.length, count);
  await assert.rejects(start({ ...request, paneId: 'disposed' }), /no longer available/);
  sessionId = 'session';
  const internalName = start({ ...request, sources: [{ ...request.sources[0], name: 'CON.txt' }] });
  finish({ status: 'cancelled' });
  await internalName;
  const externalName = start({ ...request, sources: [{ ...request.sources[0], name: 'CON.txt' }] });
  finish({ status: 'dropped', directory: 'D:\\Desktop' });
  await assert.rejects(externalName, /file name/);
});
