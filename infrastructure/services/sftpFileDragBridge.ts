import { netcattyBridge } from './netcattyBridge';

// Use a text-only browser preview so row/file icons do not follow the cursor
// outside the window. This changes no HTML payload or drop negotiation.
export function setSftpFileDragPreview(transfer: DataTransfer, names: string[]) {
  if (!transfer.setDragImage || typeof document === 'undefined' || !document.body || !names.length) return;
  const preview = document.createElement('div');
  preview.textContent = names[0] + (names.length > 1 ? `  +${names.length - 1}` : '');
  preview.style.cssText = 'position:fixed;left:-10000px;top:0;max-width:360px;padding:7px 12px;'
    + 'border-radius:8px;background:#181e29;color:#f7faff;font:600 14px/20px "Segoe UI",sans-serif;'
    + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;';
  document.body.append(preview);
  try { transfer.setDragImage(preview, 0, 0); }
  finally { setTimeout(() => preview.remove(), 0); }
}

export const sftpFileDragBridge = {
  start(payload: Parameters<NonNullable<NetcattyBridge['startSftpFileDrag']>>[0]) {
    const start = netcattyBridge.get()?.startSftpFileDrag;
    if (!start) throw new Error('SFTP destination drag is unavailable. Restart Netcatty after updating.');
    return start(payload);
  },
  stat: (sftpId: string, path: string, encoding?: Parameters<NonNullable<NetcattyBridge['statSftp']>>[2]) =>
    netcattyBridge.require().statSftp!(sftpId, path, encoding),
  list: (sftpId: string, path: string, encoding?: Parameters<NetcattyBridge['listSftp']>[2]) =>
    netcattyBridge.require().listSftp(sftpId, path, encoding),
};
