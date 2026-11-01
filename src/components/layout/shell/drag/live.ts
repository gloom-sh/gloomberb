import { startTransition, useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { FloatingRect, LayoutBounds } from "../../../../layout/pane-manager";
import type { BoxRenderable, LiveBoxFrame } from "../../../../ui";
import type { DividerPreviewState } from "../native/window-state";
import { sameRect, type DragPreview } from "./index";

/** Desktop divider drag: where the panes and dividers under the split are this frame. */
export interface LiveDockGeometry {
  /** By pane instance id. */
  leaves: ReadonlyMap<string, LayoutBounds>;
  /** By divider path ("0.1"). */
  dividers: ReadonlyMap<string, LayoutBounds>;
}

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
  /** Desktop divider drag: the panes and dividers it resizes, where the pointer has them. */
  dock: LiveDockGeometry | null;
  /** Where the release would dock or snap. */
  dockPreview: DragPreview | null;
}

/**
 * Two kinds of change. `set` is something React draws: a drag starting or
 * ending, or a new drop target; it reaches every subscriber. `move` is the
 * desktop following the pointer: it reaches only the elements that restyle
 * themselves to follow it (`subscribeMotion`), so a move renders nothing. The
 * terminal redraws cells, so it sends every change through `set`.
 *
 * A desktop resize adds a third: `catchUp`, a few times a second, tells the
 * content of the frames being resized to render at the size they have now
 * (`useLiveCatchUp`); every listener runs in the same task, so it is one commit.
 */
export interface LiveDragStore {
  get(): LiveDragGeometry;
  set(patch: Partial<LiveDragGeometry>): void;
  move(patch: Partial<LiveDragGeometry>): void;
  catchUp(): void;
  subscribe(listener: () => void): () => void;
  subscribeMotion(listener: () => void): () => void;
  subscribeCatchUp(listener: () => void): () => void;
}

export const IDLE_DRAG: LiveDragGeometry = {
  paneDrag: null,
  paneResize: null,
  floating: null,
  divider: null,
  dock: null,
  dockPreview: null,
};

export function createLiveDragStore(): LiveDragStore {
  let geometry = IDLE_DRAG;
  const listeners = new Set<() => void>();
  const motionListeners = new Set<() => void>();
  const catchUpListeners = new Set<() => void>();
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
    catchUp() {
      notify(catchUpListeners);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribeMotion(listener) {
      motionListeners.add(listener);
      return () => { motionListeners.delete(listener); };
    },
    subscribeCatchUp(listener) {
      catchUpListeners.add(listener);
      return () => { catchUpListeners.delete(listener); };
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
  return a.dx === b.dx && a.dy === b.dy && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
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

/**
 * Desktop: the rect a frame being resized draws its content at. The frame
 * follows every move on its own (`useLiveBoxFrame`); the content, which
 * charts and tables lay out for one size, renders at the frame's size only
 * when the drag runtime calls a catch-up: a few times a second while the
 * pointer moves, and once after it stops. A catch-up renders as a transition,
 * in slices between the frames the resize draws, and a newer one replaces it
 * if it has not finished. `select` names the rect to catch up with, or null
 * when it has nothing to catch up with (not being resized, or back at its
 * laid-out size); null shows at once, so a release or a put-back draws the
 * layout's rect in the commit that lays it out.
 */
export function useLiveCatchUp(
  store: LiveDragStore,
  select: ((geometry: LiveDragGeometry) => LayoutBounds | null) | null,
): LayoutBounds | null {
  const [rect, setRect] = useState<LayoutBounds | null>(null);
  // What `rect` holds, so a catch-up never queues a state update that changes nothing.
  const shown = useRef<LayoutBounds | null>(null);
  useLayoutEffect(() => {
    if (!select) return;
    const show = (next: LayoutBounds | null) => {
      const current = shown.current;
      if (current === next || (current && next && sameRect(current, next))) return false;
      shown.current = next;
      return true;
    };
    const stopCatchUp = store.subscribeCatchUp(() => {
      const next = select(store.get());
      if (show(next)) startTransition(() => setRect(next));
    });
    const stopMotion = store.subscribeMotion(() => {
      if (shown.current && !select(store.get()) && show(null)) setRect(null);
    });
    return () => {
      stopCatchUp();
      stopMotion();
    };
  }, [select, store]);
  return select ? rect : null;
}
