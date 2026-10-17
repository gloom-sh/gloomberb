import type {
  DesktopDockPreviewState,
  DesktopSharedStateSnapshot,
  DesktopThemePreviewState,
} from "../../../../types/desktop-window";
import { encodeRpcValue } from "../../shared/rpc-codec";

export interface DesktopStateRpc {
  send: {
    "desktop.state": (payload: { snapshot: DesktopSharedStateSnapshot }) => void;
    "desktop.dockPreview": (payload: { preview: DesktopDockPreviewState }) => void;
    "desktop.themePreview": (payload: { preview: DesktopThemePreviewState }) => void;
  };
}

interface DesktopStateBroadcasterOptions<Rpc extends DesktopStateRpc> {
  forEachReadyWindowRpc: (callback: (rpc: Rpc) => void) => void;
}

/**
 * Equal as the windows compare state: the same data whatever the key order, a
 * key holding undefined counting as absent, dates by time, maps by entries.
 */
function sameStateValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => sameStateValue(entry, right[index]));
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
    for (const [key, value] of left) {
      if (!right.has(key) || !sameStateValue(value, right.get(key))) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  let unmatched = 0;
  for (const key of Object.keys(leftRecord)) {
    if (leftRecord[key] === undefined) continue;
    if (!sameStateValue(leftRecord[key], rightRecord[key])) return false;
    unmatched += 1;
  }
  for (const key of Object.keys(rightRecord)) {
    if (rightRecord[key] !== undefined) unmatched -= 1;
  }
  return unmatched === 0;
}

/** The parts of a snapshot a window applies; the revision and layout flag only qualify them. */
function sameDesktopState(left: DesktopSharedStateSnapshot, right: DesktopSharedStateSnapshot): boolean {
  return sameStateValue(left.focusedPaneId, right.focusedPaneId)
    && sameStateValue(left.statusBarVisible, right.statusBarVisible)
    && sameStateValue(left.paneState, right.paneState)
    && sameStateValue(left.config, right.config);
}

/** The snapshot without one pane's state, here and in the saved layouts' copies. */
function withoutPaneState(snapshot: DesktopSharedStateSnapshot, paneId: string): DesktopSharedStateSnapshot {
  const { [paneId]: _paneState, ...paneState } = snapshot.paneState;
  return {
    ...snapshot,
    paneState,
    config: {
      ...snapshot.config,
      layouts: snapshot.config.layouts.map((entry) => {
        if (!entry.paneState || !(paneId in entry.paneState)) return entry;
        const { [paneId]: _saved, ...saved } = entry.paneState;
        return { ...entry, paneState: saved };
      }),
    },
  };
}

export class DesktopStateBroadcaster<Rpc extends DesktopStateRpc> {
  private dockPreview: DesktopDockPreviewState = { paneId: null, edge: null };
  private themePreview: DesktopThemePreviewState = { theme: null };
  /** The state each window holds, as far as this process knows: what it last sent here or was sent. */
  private readonly heldStates = new WeakMap<Rpc, DesktopSharedStateSnapshot>();

  constructor(private readonly options: DesktopStateBroadcasterOptions<Rpc>) {}

  get currentDockPreview(): DesktopDockPreviewState {
    return this.dockPreview;
  }

  get currentThemePreview(): DesktopThemePreviewState {
    return this.themePreview;
  }

  resetDockPreview(): void {
    this.dockPreview = { paneId: null, edge: null };
  }

  /** A window that sent its whole state holds it, and is not sent it back. */
  noteWindowState(rpc: Rpc, snapshot: DesktopSharedStateSnapshot): void {
    this.heldStates.set(rpc, snapshot);
  }

  /**
   * A popped-out window that sent its pane's state holds the result too, when
   * nothing else differs from what it was last sent.
   */
  notePaneState(rpc: Rpc, paneId: string, snapshot: DesktopSharedStateSnapshot): void {
    const held = this.heldStates.get(rpc);
    if (!held || !(paneId in snapshot.paneState)) return;
    if (sameDesktopState(withoutPaneState(held, paneId), withoutPaneState(snapshot, paneId))) {
      this.heldStates.set(rpc, snapshot);
    }
  }

  /** A window that starts over (a load or reload) gets the next state in full. */
  forgetWindowState(rpc: Rpc): void {
    this.heldStates.delete(rpc);
  }

  /**
   * Sends the state to every ready window that does not already hold it, in
   * the order the changes happen. A window comparing an equal state with its
   * own would drop it, after paying to decode and compare it.
   */
  sendDesktopState(snapshot: DesktopSharedStateSnapshot | null): void {
    if (!snapshot) return;
    let encodedSnapshot: DesktopSharedStateSnapshot | null = null;
    this.options.forEachReadyWindowRpc((rpc) => {
      const held = this.heldStates.get(rpc);
      if (held && sameDesktopState(held, snapshot)) return;
      this.heldStates.set(rpc, snapshot);
      encodedSnapshot ??= encodeRpcValue(snapshot) as DesktopSharedStateSnapshot;
      rpc.send["desktop.state"]({
        snapshot: encodedSnapshot,
      });
    });
  }

  sendDockPreview(preview: DesktopDockPreviewState): void {
    if (this.dockPreview.paneId === preview.paneId && this.dockPreview.edge === preview.edge) {
      return;
    }
    this.dockPreview = preview;
    const encodedPreview = encodeRpcValue(preview) as DesktopDockPreviewState;
    this.options.forEachReadyWindowRpc((rpc) => {
      rpc.send["desktop.dockPreview"]({
        preview: encodedPreview,
      });
    });
  }

  sendThemePreview(preview: DesktopThemePreviewState): void {
    if (this.themePreview.theme === preview.theme) return;
    this.themePreview = preview;
    const encodedPreview = encodeRpcValue(preview) as DesktopThemePreviewState;
    this.options.forEachReadyWindowRpc((rpc) => {
      rpc.send["desktop.themePreview"]({
        preview: encodedPreview,
      });
    });
  }

  clearDockPreview(paneId?: string): void {
    if (paneId && this.dockPreview.paneId && this.dockPreview.paneId !== paneId) return;
    this.sendDockPreview({ paneId: null, edge: null });
  }
}
