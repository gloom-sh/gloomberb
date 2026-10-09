import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { DockLeafLayout, FloatingRect } from "../../../../layout/pane-manager";
import type { BoxRenderable, LiveBoxFrame } from "../../../../ui";
import type { DividerPreviewState } from "../native/window-state";
import { hoverOverlayForLeaf, sameRect, type DragPreview, type HoverOverlay } from "./index";

/**
 * Where an in-progress drag is right now: the pane on the move, its floating
 * rect, the divider line and the drop target. It lives outside React state,
 * so the shell renders nothing while a drag follows the pointer.
 */
export interface LiveDragGeometry {
  /** The pane being moved, from mouse down to release. */
  paneDrag: { paneId: string; mode: "docked" | "floating" } | null;
  /** The floating pane being resized, from mouse down to release. */
  paneResize: { paneId: string } | null;
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

export const IDLE_DRAG: LiveDragGeometry = {
  paneDrag: null,
  paneResize: null,
  floating: null,
  divider: null,
  hoverTargetId: null,
  dockPreview: null,
};

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
  return a.dx === b.dx && a.dy === b.dy && a.width === b.width && a.height === b.height;
}

/**
 * Desktop: keeps `box` where the drag has it by restyling its element on every
 * move (`setLiveFrame`), with no render. `frameOf` must be stable while its
 * inputs are; a new one redraws the box once. A render of the caller during
 * the drag may write the box's laid-out size again, so it is drawn back after
 * every one.
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
  useLayoutEffect(() => {
    if (drawn.current) box.current?.setLiveFrame?.(drawn.current);
  });
}

/** How often a pane being resized on the desktop draws its content at the new size. */
const RESIZE_CONTENT_INTERVAL_MS = 100;

/**
 * Desktop: the rect a floating pane being resized draws its content at. Its
 * frame follows every move on its own (`useLiveBoxFrame`); the content, which
 * charts and tables lay out for one size, catches up with it at most every
 * `RESIZE_CONTENT_INTERVAL_MS`, and once more after the last move. Null when
 * the pane is not being resized, or has not changed size yet.
 */
export function useLiveResizeRect(store: LiveDragStore, paneId: string, enabled: boolean): FloatingRect | null {
  const [rect, setRect] = useState<FloatingRect | null>(null);
  // What `rect` holds, so a move never queues a state update that changes nothing.
  const shown = useRef<FloatingRect | null>(null);
  useLayoutEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The size the content was last drawn at in this resize; the press's own first.
    let drawn: FloatingRect | null = null;
    const show = (next: FloatingRect | null) => {
      if (shown.current === next) return;
      shown.current = next;
      setRect(next);
    };
    const resizing = () => {
      const { paneResize, floating } = store.get();
      return paneResize?.paneId === paneId && floating?.paneId === paneId ? floating.rect : null;
    };
    const catchUp = () => {
      timer = null;
      const next = resizing();
      if (!next || (drawn && sameRect(next, drawn))) return;
      drawn = next;
      show(next);
    };
    const follow = () => {
      const next = resizing();
      if (!next) {
        // Released or put back: the layout's rect draws it, in the same commit.
        if (timer !== null) clearTimeout(timer);
        timer = null;
        drawn = null;
        show(null);
        return;
      }
      if (!drawn) drawn = next;
      else if (timer === null && !sameRect(next, drawn)) timer = setTimeout(catchUp, RESIZE_CONTENT_INTERVAL_MS);
    };
    const unsubscribe = store.subscribeMotion(follow);
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled, paneId, store]);
  return enabled ? rect : null;
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
