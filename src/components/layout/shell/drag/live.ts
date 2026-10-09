import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import type { DockLeafLayout, FloatingRect } from "../../../../layout/pane-manager";
import type { BoxRenderable, LiveBoxFrame } from "../../../../ui";
import type { DividerPreviewState } from "../native/window-state";
import { hoverOverlayForLeaf, type DragPreview, type HoverOverlay } from "./index";

/**
 * Where an in-progress drag is right now: the pane on the move, its floating
 * rect, the divider line and the drop target. It lives outside React state,
 * so the shell renders nothing while a drag follows the pointer.
 */
export interface LiveDragGeometry {
  /** The pane being moved, from mouse down to release. */
  paneDrag: { paneId: string; mode: "docked" | "floating" } | null;
  /** The floating rect being moved or resized, already kept inside the shell. */
  floating: { paneId: string; rect: FloatingRect } | null;
  divider: DividerPreviewState | null;
  /** The tiled pane whose drop grid is under the pointer during a pane move. */
  hoverTargetId: string | null;
  /** Where the release would dock or snap. */
  dockPreview: DragPreview | null;
}

/**
 * Two kinds of change. `set` is something React draws: a drag starting or
 * ending, or a new drop target; it reaches every subscriber. `move` is the
 * desktop following the pointer: it reaches only the elements that restyle
 * themselves to follow it (`subscribeMotion`), so a move renders nothing. The
 * terminal redraws cells, so it sends every change through `set`.
 */
export interface LiveDragStore {
  get(): LiveDragGeometry;
  set(patch: Partial<LiveDragGeometry>): void;
  move(patch: Partial<LiveDragGeometry>): void;
  subscribe(listener: () => void): () => void;
  subscribeMotion(listener: () => void): () => void;
}

export const IDLE_DRAG: LiveDragGeometry = { paneDrag: null, floating: null, divider: null, hoverTargetId: null, dockPreview: null };

export function createLiveDragStore(): LiveDragStore {
  let geometry = IDLE_DRAG;
  const listeners = new Set<() => void>();
  const motionListeners = new Set<() => void>();
  const apply = (patch: Partial<LiveDragGeometry>): boolean => {
    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof LiveDragGeometry>) {
      if (patch[key] !== geometry[key]) changed = true;
    }
    if (changed) geometry = { ...geometry, ...patch };
    return changed;
  };
  const notify = (targets: Set<() => void>) => {
    for (const listener of targets) listener();
  };
  return {
    get: () => geometry,
    set(patch) {
      if (!apply(patch)) return;
      notify(motionListeners);
      notify(listeners);
    },
    move(patch) {
      if (apply(patch)) notify(motionListeners);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribeMotion(listener) {
      motionListeners.add(listener);
      return () => { motionListeners.delete(listener); };
    },
  };
}

/** Re-renders the caller only when `select` returns something new; keep its result stable. */
export function useLiveDrag<T>(store: LiveDragStore, select: (geometry: LiveDragGeometry) => T): T {
  const getSnapshot = useCallback(() => select(store.get()), [select, store]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

function sameFrame(a: LiveBoxFrame | null, b: LiveBoxFrame | null): boolean {
  if (a === null || b === null) return a === b;
  return a.dx === b.dx && a.dy === b.dy;
}

/**
 * Desktop: keeps `box` where the drag has it by restyling its element on every
 * move (`setLiveFrame`), with no render. `frameOf` must be stable while its
 * inputs are; a new one redraws the box once.
 */
export function useLiveBoxFrame(
  store: LiveDragStore,
  box: RefObject<BoxRenderable | null>,
  frameOf: ((geometry: LiveDragGeometry) => LiveBoxFrame | null) | null,
): void {
  // What the element carries now, across re-subscriptions.
  const drawn = useRef<LiveBoxFrame | null>(null);
  useLayoutEffect(() => {
    if (!frameOf) return;
    const follow = () => {
      const next = frameOf(store.get());
      if (sameFrame(drawn.current, next)) return;
      drawn.current = next;
      box.current?.setLiveFrame?.(next);
    };
    follow();
    return store.subscribeMotion(follow);
  }, [box, frameOf, store]);
}

/** The drop grid under the pointer during a pane move. Re-renders only when the pointer enters another pane's grid. */
export function useLiveHoverOverlay(store: LiveDragStore, leaves: DockLeafLayout[]): HoverOverlay | null {
  const targetId = useLiveDrag(store, selectHoverTarget);
  return useMemo(() => {
    const leaf = targetId ? leaves.find((entry) => entry.instanceId === targetId) : undefined;
    return leaf ? hoverOverlayForLeaf(leaf) : null;
  }, [leaves, targetId]);
}

const selectHoverTarget = (geometry: LiveDragGeometry) => (geometry.paneDrag ? geometry.hoverTargetId : null);
