import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { setSftpFileDragPreview } from "../../../infrastructure/services/sftpFileDragBridge";
import { joinPath } from "./utils";

export interface LocalDragSource {
  name: string;
  isDirectory: boolean;
  sourcePath?: string;
  sourceConnectionId?: string;
  targetPath?: string;
  side: "left" | "right";
}

interface DragSession {
  requestId: string;
  paneId: string;
  connectionId: string;
  paths: string[];
  sources: LocalDragSource[];
  started?: boolean;
  remote?: boolean;
}

export type StartRemoteFileDrag = (request: {
  requestId: string;
  paneId: string;
  connectionId: string;
  sources: Omit<LocalDragSource, 'side'>[];
  side: 'left' | 'right';
  isCurrent: () => boolean;
}) => Promise<void>;

// Windows separators can differ between the SFTP UI and Electron webUtils.
// POSIX backslashes, whitespace, and case must remain significant.
export function localDragPathKey(value: string): string {
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) {
    return value.replace(/\\/g, "/").replace(/\/$/, "");
  }
  return value.length > 1 ? value.replace(/\/$/, "") : value;
}

class LocalFileDragState {
  session: DragSession | null = null;

  clear(requestId?: string) {
    if (!requestId || this.session?.requestId === requestId) this.session = null;
  }

  take(paths: string[]): LocalDragSource[] | null {
    const session = this.session;
    this.clear();
    if (!session || paths.length === 0 || paths.some((path) => !path)) return null;
    const expected = new Set(session.paths.map(localDragPathKey));
    const actual = new Set(paths.map(localDragPathKey));
    if (expected.size !== actual.size || [...expected].some((path) => !actual.has(path))) return null;
    return session.sources;
  }
}

const state = new LocalFileDragState();
let detach: (() => void) | undefined;

export function clearLocalFileDrag(requestId?: string) {
  if (requestId && state.session?.requestId !== requestId) return;
  const previous = state.session;
  state.clear();
  detach?.();
  detach = undefined;
  if (previous) netcattyBridge.get()?.cancelLocalFileDrag?.(previous.requestId);
  if (previous?.remote) netcattyBridge.get()?.cancelSftpFileDrag?.(previous.requestId);
}

export function clearLocalFileDragForPane(paneId: string) {
  if (state.session?.paneId === paneId) clearLocalFileDrag();
}

function observeGestureEnd() {
  let dropCleanupTimer: ReturnType<typeof setTimeout> | undefined;
  // Electron has no cross-platform native-drag completion callback. A canceled
  // HTML drag's dragend is not a native completion signal. Clear on drop and
  // on the next physical input/focus transition, including Escape and returning
  // after a drop outside the window. Never retain state into a new gesture.
  const clear = () => clearLocalFileDrag();
  // Destination gestures must remain active while crossing external windows.
  const blur = () => { if (!state.session?.remote) clear(); };
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
  const move = (event: MouseEvent) => { if (state.session?.started && event.buttons === 0) clear(); };
  const drop = () => {
    const requestId = state.session?.requestId;
    // Native event dispatch can run microtasks BETWEEN capture and React's
    // bubble listener. Use a macrotask so the row/pane can consume the gesture.
    dropCleanupTimer = setTimeout(() => { if (requestId) clearLocalFileDrag(requestId); }, 0);
  };
  // preventDefault() on dragstart produces a synthetic mouseup in Chromium.
  // It must not cancel the native handoff. Observe later input instead.
  window.addEventListener("mousedown", clear, true);
  window.addEventListener("mousemove", move, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", blur);
  window.addEventListener("pagehide", clear);
  window.addEventListener("drop", drop, true);
  detach = () => {
    if (dropCleanupTimer !== undefined) clearTimeout(dropCleanupTimer);
    window.removeEventListener("mousedown", clear, true);
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", blur);
    window.removeEventListener("pagehide", clear);
    window.removeEventListener("drop", drop, true);
  };
}

type DragEventLike = Pick<DragEvent, "dataTransfer" | "preventDefault"> & { shiftKey?: boolean };

export function startSftpFileDrag({ event, paneId, connection, sources, side, onRemoteDrag, onStartRemoteDrag, onError }: {
  event: DragEventLike;
  paneId: string;
  connection?: { id: string; isLocal?: boolean } | null;
  sources: Omit<LocalDragSource, "side">[];
  side: "left" | "right";
  onRemoteDrag: (sources: Omit<LocalDragSource, "side">[], side: "left" | "right") => void;
  onStartRemoteDrag?: StartRemoteFileDrag;
  onError: (message: string) => void;
}) {
  clearLocalFileDrag();
  const remote = connection?.isLocal !== true;
  if (remote) {
    event.dataTransfer!.effectAllowed = "copyMove";
    event.dataTransfer!.setData("text/plain", sources.map((file) => file.name).join("\n"));
    onRemoteDrag(sources, side);
    if (!onStartRemoteDrag) return;
    setSftpFileDragPreview(event.dataTransfer!, sources.map(source => source.name));
  } else {
    event.preventDefault();
  }
  const bridge = netcattyBridge.get();
  if (!remote && !bridge?.startLocalFileDrag) {
    onError("Native file drag is unavailable. Restart Netcatty after updating.");
    return;
  }
  const files = sources.filter((source) => source.name !== "..");
  if (!connection || !files.length || files.some((file) => !file.sourcePath || file.sourceConnectionId !== connection.id)) {
    onError("The file selection is no longer available.");
    return;
  }
  const requestId = crypto.randomUUID();
  const paths = remote ? [] : [...new Set(files.map((file) => joinPath(file.sourcePath!, file.name)))];
  state.session = { requestId, paneId, connectionId: connection.id, paths, sources: files.map((file) => ({ ...file, side })), remote };
  observeGestureEnd();
  const startNative = () => bridge!.startLocalFileDrag!({ requestId, paths: state.session!.paths }).then((result) => {
    if (result.started && state.session?.requestId === requestId) state.session.started = true;
    if (!result.started && state.session?.requestId === requestId) {
      clearLocalFileDrag(requestId);
      if (result.error) onError(result.error);
    }
  });
  const fail = (error: unknown) => {
    if (state.session?.requestId !== requestId) return;
    clearLocalFileDrag(requestId);
    onError(error instanceof Error ? error.message : 'Unable to drag files');
  };
  // Remote HTML dragging remains owned by the official pane callbacks. The
  // helper only watches for an external destination; it does not replace or
  // cancel the browser drag. A drop inside the app cancels this observer.
  try {
    if (remote) {
      void onStartRemoteDrag!({ requestId, paneId, connectionId: connection.id, sources: files, side,
        isCurrent: () => state.session?.requestId === requestId,
      }).then(() => clearLocalFileDrag(requestId)).catch(fail);
    } else {
      void startNative().catch(fail);
    }
  } catch (error) {
    fail(error);
  }
}

export function getLocalFileDragSources(dataTransfer: DataTransfer): LocalDragSource[] | null {
  return dataTransfer.types.includes("Files") ? state.session?.sources ?? null : null;
}

export function localFileDragMoveEffect(dataTransfer: Pick<DataTransfer, "effectAllowed">): "copy" | "move" {
  // Electron's Windows/Linux native source advertises COPY | LINK, not MOVE.
  // Negotiate an allowed transport effect; our existing same-pane callback is
  // responsible for the actual local move (the OS must not delete originals).
  return ["all", "copyMove", "linkMove", "move"].includes(dataTransfer.effectAllowed) ? "move" : "copy";
}

export function takeLocalFileDragSources(dataTransfer: DataTransfer): LocalDragSource[] | null {
  if (!state.session) return null;
  const bridge = netcattyBridge.get();
  const session = state.session;
  try {
    return state.take(Array.from(dataTransfer.files).map((file) => bridge?.getPathForFile?.(file) ?? ""));
  } catch {
    state.clear();
    return null;
  } finally {
    detach?.();
    detach = undefined;
    bridge?.cancelLocalFileDrag?.(session.requestId);
  }
}
