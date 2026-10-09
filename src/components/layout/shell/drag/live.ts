import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { DockLeafLayout, FloatingRect } from "../../../../layout/pane-manager";
import type { DividerPreviewState } from "../native/window-state";
import { hoverOverlayForLeaf, resolveHoverOverlay, type DragPreview, type HoverOverlay } from "./index";

/**
 * Where an in-progress drag is right now: the pane on the move, its floating
 * rect, the pointer, the divider line and the drop target. Most of it changes
 * on every pointer move, so it lives outside React state: the shell renders
 * nothing per move, and only what is drawn at these positions (the dragged
 * pane, the drop outline and grid, the divider) subscribes and redraws.
 */
export interface LiveDragGeometry {
  /** The pane being moved, from mouse down to release. */
  paneDrag: { paneId: string; mode: "docked" | "floating" } | null;
  /** The floating rect being moved or resized, already kept inside the shell. */
  floating: { paneId: string; rect: FloatingRect } | null;
  /** The pointer during a pane move, in the cells hit testing uses. */
  cursor: { x: number; y: number } | null;
  divider: DividerPreviewState | null;
  /** Where the release would dock or snap. */
  dockPreview: DragPreview | null;
}

export interface LiveDragStore {
  get(): LiveDragGeometry;
  set(patch: Partial<LiveDragGeometry>): void;
  subscribe(listener: () => void): () => void;
}

export const IDLE_DRAG: LiveDragGeometry = { paneDrag: null, floating: null, cursor: null, divider: null, dockPreview: null };

export function createLiveDragStore(): LiveDragStore {
  let geometry = IDLE_DRAG;
  const listeners = new Set<() => void>();
  return {
    get: () => geometry,
    set(patch) {
      let changed = false;
      for (const key of Object.keys(patch) as Array<keyof LiveDragGeometry>) {
        if (patch[key] !== geometry[key]) changed = true;
      }
      if (!changed) return;
      geometry = { ...geometry, ...patch };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** Re-renders the caller only when `select` returns something new; keep its result stable. */
export function useLiveDrag<T>(store: LiveDragStore, select: (geometry: LiveDragGeometry) => T): T {
  const getSnapshot = useCallback(() => select(store.get()), [select, store]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** The drop grid under the pointer during a pane move. Re-renders only when the pointer enters another pane's grid. */
export function useLiveHoverOverlay(store: LiveDragStore, leaves: DockLeafLayout[]): HoverOverlay | null {
  const select = useCallback((geometry: LiveDragGeometry) => {
    const { paneDrag, cursor } = geometry;
    if (!paneDrag || !cursor) return null;
    return resolveHoverOverlay(cursor.x, cursor.y, leaves, paneDrag.paneId)?.targetId ?? null;
  }, [leaves]);
  const targetId = useLiveDrag(store, select);
  return useMemo(() => {
    const leaf = targetId ? leaves.find((entry) => entry.instanceId === targetId) : undefined;
    return leaf ? hoverOverlayForLeaf(leaf) : null;
  }, [leaves, targetId]);
}
