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
  /**
   * Which state a window draws: windows with the same view share one key.
   * Without it every window gets the shared state.
   */
  viewKey?: (rpc: Rpc) => string;
  /** The state for a view key, from the shared one; null sends that window nothing. */
  project?: (viewKey: string, shared: DesktopSharedStateSnapshot) => DesktopSharedStateSnapshot | null;
  /** Each state sent to a window, with the number it carries, which the window's next sync names as its base. */
  delivered?: (rpc: Rpc, snapshot: DesktopSharedStateSnapshot) => void;
}

interface ProjectedState {
  snapshot: DesktopSharedStateSnapshot | null;
  key?: string;
  encoded?: DesktopSharedStateSnapshot;
}

/**
 * The parts of a snapshot a window applies, as the text the windows compare;
 * the revision and layout flag only qualify them. Being text, it keeps no
 * reference to objects this process may change later.
 */
function desktopStateKey(snapshot: DesktopSharedStateSnapshot): string {
  return JSON.stringify({
    config: snapshot.config,
    paneState: snapshot.paneState,
    focusedPaneId: snapshot.focusedPaneId,
    statusBarVisible: snapshot.statusBarVisible,
    brokerSyncErrors: snapshot.brokerSyncErrors ?? {},
    linkedTickers: snapshot.linkedTickers ?? {},
  });
}

export class DesktopStateBroadcaster<Rpc extends DesktopStateRpc> {
  private dockPreview: DesktopDockPreviewState = { paneId: null, edge: null };
  private themePreview: DesktopThemePreviewState = { theme: null };
  /** The state held by each window that sends its whole state: what it last sent here or was sent. */
  private readonly heldStateKeys = new WeakMap<Rpc, string>();
  private seq = 0;

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

  /** Numbers a state handed to a window outside a broadcast (its `init`), in the same series. */
  stamp(snapshot: DesktopSharedStateSnapshot): DesktopSharedStateSnapshot {
    this.seq += 1;
    return { ...snapshot, stateSeq: this.seq };
  }

  /** A window that sent its whole state holds it, and is not sent it back. */
  noteWindowState(rpc: Rpc, snapshot: DesktopSharedStateSnapshot): void {
    this.heldStateKeys.set(rpc, desktopStateKey(snapshot));
  }

  /** A window that starts over (a load or reload) gets every state until it sends its own. */
  forgetWindowState(rpc: Rpc): void {
    this.heldStateKeys.delete(rpc);
  }

  /**
   * Sends the state to every ready window in the order the changes happen,
   * except a window that sent its whole state and already holds this one: it
   * would decode and compare the state only to drop it. A popped-out window
   * gets every state. It applies one only when the part for its own pane
   * changed, and then whole, so the state its own change produces is what
   * brings its copy of the tabs and settings up to date.
   */
  sendDesktopState(snapshot: DesktopSharedStateSnapshot | null): void {
    if (!snapshot) return;
    this.seq += 1;
    const seq = this.seq;
    const views = new Map<string, ProjectedState>();
    const { viewKey, project, delivered } = this.options;
    this.options.forEachReadyWindowRpc((rpc) => {
      const view = viewKey?.(rpc) ?? "";
      let projected = views.get(view);
      if (!projected) {
        const shown = project ? project(view, snapshot) : snapshot;
        projected = { snapshot: shown ? { ...shown, stateSeq: seq } : null };
        views.set(view, projected);
      }
      if (!projected.snapshot) return;
      const heldKey = this.heldStateKeys.get(rpc);
      if (heldKey !== undefined) {
        projected.key ??= desktopStateKey(projected.snapshot);
        if (heldKey === projected.key) return;
        this.heldStateKeys.set(rpc, projected.key);
      }
      projected.encoded ??= encodeRpcValue(projected.snapshot) as DesktopSharedStateSnapshot;
      delivered?.(rpc, projected.snapshot);
      rpc.send["desktop.state"]({
        snapshot: projected.encoded,
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

  /** Every window but the one previewing (`fromRpc`) previews the theme too. */
  sendThemePreview(preview: DesktopThemePreviewState, fromRpc?: Rpc): void {
    if (this.themePreview.theme === preview.theme) return;
    this.themePreview = preview;
    const encodedPreview = encodeRpcValue(preview) as DesktopThemePreviewState;
    this.options.forEachReadyWindowRpc((rpc) => {
      if (rpc === fromRpc) return;
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
