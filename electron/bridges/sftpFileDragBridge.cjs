"use strict";

const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

function helperPath(app, resourcesPath = process.resourcesPath, arch = process.arch) {
  return app.isPackaged
    ? path.join(resourcesPath, 'sftpDropTarget', 'NetcattySftpDropTarget.exe')
    : path.join(__dirname, 'sftpDropTarget', 'build', arch, 'NetcattySftpDropTarget.exe');
}

// Capture a destination only. Remote I/O starts later in downloadToLocal.
function createSftpFileDragService({ getWindows, getGesture, app, platform = process.platform,
  run = spawn, getHelperPath = () => helperPath(app), stat = fs.stat }) {
  const pending = new Map();
  const authorized = event => event?.sender && !event.sender.isDestroyed()
    && event.senderFrame && event.senderFrame === event.sender.mainFrame
    && getWindows().some(win => !win.isDestroyed() && win.webContents === event.sender);
  const cancel = (event, { requestId } = {}) => {
    if (!authorized(event)) return;
    const job = pending.get(event.sender);
    if (job?.requestId === requestId) job.cancel();
  };
  const start = async (event, payload) => {
    if (!authorized(event)) throw new Error('Unauthorized SFTP drag sender');
    if (platform !== 'win32') throw new Error('Destination dragging is supported on Windows only');
    if (!payload || typeof payload.requestId !== 'string' || !payload.requestId || payload.requestId.length > 128
        || !Number.isInteger(payload.count) || payload.count < 1 || payload.count > 4096
        || (payload.fileNames !== undefined && (!Array.isArray(payload.fileNames)
          || payload.fileNames.length < 1 || payload.fileNames.length > Math.min(3, payload.count)
          || !payload.fileNames.every(name => typeof name === 'string' && name.length > 0
            && name.length <= 512 && !/[\x00-\x1f\x7f]/.test(name))))
        || !['copyLabel', 'invalidLabel', 'selectionLabel'].every(key => typeof payload[key] === 'string'
          && payload[key].length > 0 && payload[key].length <= 1024 && !/[\0\r\n]/.test(payload[key]))) {
      throw new Error('Invalid SFTP drag request');
    }
    const gesture = getGesture(event.sender);
    if (!gesture) return { status: 'cancelled' };
    pending.get(event.sender)?.cancel();
    const win = getWindows().find(value => value.webContents === event.sender);
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString();
    return new Promise((resolve, reject) => {
      let child;
      let output = '';
      let settled = false;
      let exited = false;
      const restoreCursor = () => {
        if (pending.has(event.sender) && pending.get(event.sender) !== job) return;
        try {
          const recovery = run(getHelperPath(), ['--restore-cursor', hwnd], { windowsHide: true, stdio: 'ignore', shell: false });
          recovery.on('error', () => {});
        } catch { /* The source window/process may already have closed. */ }
      };
      const stopHelper = () => {
        if (!child || exited) return;
        // Let native code restore its input-queue cursor before exiting.
        // Forced termination is a fallback, followed by explicit recovery.
        if (child.stdin?.writable) child.stdin.end('cancel\n');
        const forcedStop = setTimeout(() => { child.kill(); restoreCursor(); }, 1500);
        forcedStop.unref?.();
        child.once('close', () => clearTimeout(forcedStop));
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        event.sender.removeListener('destroyed', cancelJob);
        if (pending.get(event.sender) === job) pending.delete(event.sender);
        stopHelper();
        if (error) reject(error); else resolve(result);
      };
      const cancelJob = () => finish(null, { status: 'cancelled' });
      const job = { requestId: payload.requestId, cancel: cancelJob };
      const timer = setTimeout(cancelJob, 125000);
      pending.set(event.sender, job);
      event.sender.once('destroyed', cancelJob);
      try {
        child = run(getHelperPath(), [hwnd, String(process.pid), payload.copyLabel, payload.invalidLabel,
          payload.selectionLabel, '120000', (payload.fileNames || []).join('\n'), String(payload.count)],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
        child.once('close', () => { exited = true; });
        child.stdin?.on('error', () => {});
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', data => {
          output += data;
          if (output.length > 65536) finish(new Error('Invalid SFTP drop helper response'));
        });
        child.on('error', error => finish(new Error(`Unable to start SFTP destination drag: ${error.message}`)));
        child.on('close', async code => {
          if (code !== 0) restoreCursor();
          if (settled) return;
          try {
            if (code !== 0) throw new Error('SFTP destination drag stopped unexpectedly');
            const result = JSON.parse(output);
            if (result.status === 'cancelled') return finish(null, { status: 'cancelled' });
            if (result.status !== 'dropped' || !['desktop', 'explorer', 'folder'].includes(result.kind)
                || typeof result.directory !== 'string' || result.directory.includes('\0')
                || !path.win32.isAbsolute(result.directory)
                || !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(result.directory)
                || /^[\\/]{2}[?.][\\/]/.test(result.directory)) {
              throw new Error('Unable to identify the destination folder');
            }
            const info = await stat(result.directory);
            if (!info.isDirectory()) throw new Error('The drop destination is no longer a folder');
            if (!authorized(event) || pending.get(event.sender) !== job) return cancelJob();
            const latest = getGesture(event.sender);
            if (latest && latest !== gesture) return cancelJob();
            finish(null, { status: 'dropped', directory: result.directory });
          } catch (error) { finish(error); }
        });
      } catch (error) { finish(error); }
    });
  };
  return { start, cancel, dispose: () => { for (const job of [...pending.values()]) job.cancel(); } };
}

function registerHandlers(ipcMain, dependencies) {
  const service = createSftpFileDragService(dependencies);
  ipcMain.handle('netcatty:sftp:drag-start', service.start);
  ipcMain.on('netcatty:sftp:drag-cancel', service.cancel);
  dependencies.app?.once?.('before-quit', service.dispose);
}
module.exports = { createSftpFileDragService, registerHandlers, helperPath };
