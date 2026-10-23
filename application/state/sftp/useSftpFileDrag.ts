import { useCallback, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { SftpStateApi } from '../useSftpState';
import { sftpFileDragBridge } from '../../../infrastructure/services/sftpFileDragBridge';
import { assertWindowsDownloadName } from '../../../domain/sftpExternalDownload';
import { joinPath } from './utils';
import { resolveDownloadSourceSnapshot } from './downloadSourceSnapshot';
import { runBoundedConcurrency, DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY } from './transferConcurrency';
import type { StartRemoteFileDrag } from './localFileDrag';

interface Options {
  t: (key: string, values?: Record<string, string | number>) => string;
  onQueued: (directory: string, count: number) => void;
  onError: (message: string) => void;
}

export function useSftpFileDrag(sftpRef: MutableRefObject<SftpStateApi>, options: Options): StartRemoteFileDrag {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  return useCallback(async ({ paneId, connectionId, side, sources, requestId, isCurrent }) => {
    const pane = sftpRef.current.getActivePane(side);
    if (pane?.id !== paneId || pane.connection?.id !== connectionId || pane.connection.isLocal) {
      throw new Error('The remote file selection is no longer available.');
    }
    const connection = { ...pane.connection };
    const encoding = pane.filenameEncoding;
    const sftpId = sftpRef.current.getSftpIdForConnection(connectionId);
    if (!sftpId) throw new Error('SFTP session not found');
    const { t } = optionsRef.current;
    // Nothing is read from the server until the mouse has been released over
    // a confirmed destination. Dragging is just another download command.
    const result = await sftpFileDragBridge.start({ requestId, count: sources.length,
      // eslint-disable-next-line no-control-regex -- render control characters as spaces in the native preview
      fileNames: sources.slice(0, 3).map(source => source.name.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512)),
      copyLabel: t('sftp.drag.copyTo'), invalidLabel: t('sftp.drag.invalidTarget'),
      selectionLabel: t('sftp.drag.selection', { count: sources.length }),
    });
    if (result.status !== 'dropped' || !isCurrent()) return;
    const checkConnection = () => {
      if (sftpRef.current.getSftpIdForConnection(connectionId) !== sftpId) {
        throw new Error('The SFTP connection changed during the drag. Drag again.');
      }
    };
    checkConnection();
    const plans = [];
    for (const source of sources) {
      // Windows download rules apply only after an external drop. Names valid
      // on SSH hosts must remain usable by the official in-app drag handlers.
      assertWindowsDownloadName(source.name);
      if (!source.sourcePath || source.sourceConnectionId !== connectionId) throw new Error('The remote file selection changed');
      const sourcePath = joinPath(source.sourcePath!, source.name);
      const snapshot = await resolveDownloadSourceSnapshot(sftpFileDragBridge.stat, sftpId, sourcePath, encoding, sftpFileDragBridge.list);
      if (!isCurrent()) return;
      checkConnection();
      plans.push({ fileName: source.name, sourcePath, targetPath: joinPath(result.directory, source.name),
        sftpId, connectionId, sourceHostId: connection.hostId, sourceHostLabel: connection.hostLabel,
        sourceEncoding: encoding, isDirectory: snapshot.isDirectory,
        totalBytes: snapshot.isDirectory ? undefined : snapshot.size });
    }
    optionsRef.current.onQueued(result.directory, plans.length);
    // Use exactly the normal SFTP download pipeline (dedicated connections,
    // conflict UI, global transfer center, pause, retry and cancellation).
    void runBoundedConcurrency(plans, DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY, async plan => {
      try {
        checkConnection();
        const status = await sftpRef.current.downloadToLocal(plan);
        if (status === 'failed' || status === 'attention') {
          optionsRef.current.onError(`${optionsRef.current.t('sftp.error.downloadFailed')}: ${plan.fileName}`);
        }
      } catch (error) {
        optionsRef.current.onError(error instanceof Error ? error.message : String(error));
      }
    }).catch(error => optionsRef.current.onError(error instanceof Error ? error.message : String(error)));
  }, [sftpRef]);
}
