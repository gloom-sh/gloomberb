import { useCallback, useEffect, useRef } from "react";
import {
  floatAtRect,
  getDockSplitGeometry,
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH,
  getRememberedFloatingRect,
  resizeSplitAtPath,
  simulateDrop,
  type DockGeometryOptions,
  type DockLeafLayout,
  type FloatingRect,
  type LayoutBounds,
  type ResolvedPane,
} from "../../../layout/pane-manager";
import type { LayoutConfig } from "../../../types/config";
import {
  finalizePaneDragRelease,
  freePaneDragRect,
  isMeaningfulPaneDrag,
  JOIN_DWELL_MS,
  makeSnapGuides,
  PANE_DRAG_THRESHOLD,
  PRECISE_PANE_DRAG_THRESHOLD,
  resolveDividerPreviewRect,
  resolveFloatResizeRect,
  resolvePaneDragFloatingRect,
  resolvePaneDropTarget,
  resolveSnapGuide,
  type DragPreview,
} from "./drag";
import type { ShellDragRuntimeState, ShellMouseEvent } from "./drag/runtime";
import type { WindowEditState } from "../window-edit/mode";
import {
  createMagnetPace,
  NO_LATCH,
  snapMovedRect,
  snapResizedRect,
  type MagnetDistances,
  type MagnetLatch,
  type MagnetPace,
} from "./drag/magnets";
import { paneHeaderRows } from "../pane/sizing";

/** A join the pointer has lined up: armed once it has held for JOIN_DWELL_MS. */
interface PendingJoin {
  key: string;
  armed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

function dropPendingJoin(memo: { join: PendingJoin | null }) {
  if (memo.join?.timer) clearTimeout(memo.join.timer);
  memo.join = null;
}

/** A resize without edges is the bottom-right corner's (the terminal's only one). */
const CORNER_EDGES = { x: 1, y: 1 } as const;

interface UseShellActiveDragOptions {
  appHeaderHeight: number;
  bounds: LayoutBounds;
  contentHeight: number;
  dockGeometryOptions: DockGeometryOptions;
  dockLeafLayouts: DockLeafLayout[];
  dragRuntime: ShellDragRuntimeState;
  focusPane: (paneId: string) => void;
  /** How close a moving or resizing pane's edge comes to another before it sticks, in cells. */
  magnetDistances: MagnetDistances;
  nativePaneChrome: boolean;
  paneMap: Map<string, ResolvedPane>;
  persistLayout: (nextLayout: LayoutConfig, options?: { pushHistory?: boolean }) => void;
  precisePointer: boolean | undefined;
  snapGuides: ReturnType<typeof makeSnapGuides>;
  updateWindowModePreviewLayout: (nextLayout: LayoutConfig, paneId?: string) => void;
  visibleLayout: LayoutConfig;
  width: number;
  windowMode: WindowEditState | null;
}

export function useShellActiveDrag({
  appHeaderHeight,
  bounds,
  contentHeight,
  dockGeometryOptions,
  dockLeafLayouts,
  dragRuntime,
  focusPane,
  magnetDistances,
  nativePaneChrome,
  paneMap,
  persistLayout,
  precisePointer,
  snapGuides,
  updateWindowModePreviewLayout,
  visibleLayout,
  width,
  windowMode,
}: UseShellActiveDragOptions) {
  const {
    cancelActiveDrag,
    dragRef,
    endDrag,
    live,
    updateDividerPreview,
    updateDockPreview,
    updateDragFloatingRect,
  } = dragRuntime;
  // What one drag keeps between moves: a docked pane's floating size, the
  // last drop it simulated, so a move over the same target computes nothing,
  // the edges its magnets hold, with the other panes' rects they hold to, the
  // join it is holding still for, and on the desktop where the pointer has
  // been lately (the magnets wait for it to slow down) with the check that
  // catches once it rests.
  const memoRef = useRef<{
    drag: unknown;
    baseRect: FloatingRect | null;
    dropKey: string | null;
    drop: DragPreview | null;
    latch: MagnetLatch;
    magnetTargets: LayoutBounds[] | null;
    join: PendingJoin | null;
    pace: MagnetPace;
  }>({ drag: null, baseRect: null, dropKey: null, drop: null, latch: NO_LATCH, magnetTargets: null, join: null, pace: createMagnetPace() });
  useEffect(() => () => {
    dropPendingJoin(memoRef.current);
    memoRef.current.pace.reset();
  }, []);
  // The handler as it is now, for the rest check to run again.
  const handleRef = useRef<(event: ShellMouseEvent) => void>(() => {});

  const handle = useCallback((event: ShellMouseEvent) => {
    const shellY = event.y - appHeaderHeight;
    const preciseX = event.preciseX ?? event.x;
    const preciseShellY = (event.preciseY ?? event.y) - appHeaderHeight;
    // Drawn a moment ahead where the host predicts the pointer; hit tests and
    // the release use where it is.
    const drawX = event.predictedX ?? preciseX;
    const drawShellY = event.predictedY != null ? event.predictedY - appHeaderHeight : preciseShellY;
    const hitX = precisePointer ? preciseX : event.x;
    const hitShellY = precisePointer ? preciseShellY : shellY;
    const dragThreshold = precisePointer ? PRECISE_PANE_DRAG_THRESHOLD : PANE_DRAG_THRESHOLD;
    const drag = dragRef.current;
    if (!drag) return;
    const baseLayout = windowMode?.previewLayout ?? visibleLayout;
    const memo = memoRef.current;
    if (memo.drag !== drag) {
      memo.drag = drag;
      memo.baseRect = null;
      memo.dropKey = null;
      memo.drop = null;
      memo.latch = NO_LATCH;
      memo.magnetTargets = null;
      memo.pace.reset();
      dropPendingJoin(memo);
    }
    // Any later event supersedes the rest check of an earlier move.
    memo.pace.cancel();
    // Every other pane on screen, docked or floating, whose edges a floating
    // pane's edges stick to. Alt (Option) lets it go anywhere.
    const magnetTargets = (paneId: string) => {
      memo.magnetTargets ??= [
        ...dockLeafLayouts.filter((leaf) => leaf.instanceId !== paneId).map((leaf) => leaf.rect),
        ...baseLayout.floating
          .filter((entry) => entry.instanceId !== paneId && paneMap.has(entry.instanceId))
          .map(({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h })),
      ];
      return memo.magnetTargets;
    };
    const magnetsOff = event.modifiers?.alt === true;
    const magnetArea = { x: 0, y: 0, width, height: contentHeight };
    // Desktop: while the pointer travels, a moving pane follows it exactly;
    // its magnets catch once it slows down near a line, or rests there (the
    // rest check runs the last move again once the pointer has stopped). What
    // they hold to still follows every move, so it rests where it would have.
    const travelling = () => {
      if (!nativePaneChrome || drag.type !== "pane-drag") return false;
      // A release lands where the pane is drawn: no catch after it.
      const rest = event.type === "drag" ? () => { if (dragRef.current === drag) handleRef.current(event); } : undefined;
      return memo.pace.travelling({ t: performance.now(), x: preciseX, y: preciseShellY }, magnetDistances, rest);
    };
    const snapMove = (paneId: string, rect: FloatingRect): FloatingRect => {
      if (magnetsOff) {
        memo.latch = NO_LATCH;
        return rect;
      }
      const snapped = snapMovedRect(rect, magnetTargets(paneId), magnetArea, magnetDistances, memo.latch);
      memo.latch = snapped.latch;
      return travelling() ? rect : snapped.rect;
    };
    const snapResize = (paneId: string, rect: FloatingRect, edges: { x: -1 | 0 | 1; y: -1 | 0 | 1 }): FloatingRect => {
      if (magnetsOff) {
        memo.latch = NO_LATCH;
        return rect;
      }
      const snapped = snapResizedRect(
        rect,
        edges,
        { width: MIN_FLOAT_WIDTH, height: MIN_FLOAT_HEIGHT },
        magnetTargets(paneId),
        magnetArea,
        magnetDistances,
        memo.latch,
      );
      memo.latch = snapped.latch;
      return snapped.rect;
    };
    const dividerRatioAt = (x: number, y: number) => {
      if (drag.type !== "divider") return 0;
      const total = drag.axis === "horizontal" ? drag.bounds.width : drag.bounds.height;
      const delta = drag.axis === "horizontal" ? x - drag.startX : y - drag.startY;
      return Math.max(0.1, Math.min(0.9, drag.startRatio + (delta / Math.max(1, total))));
    };
    const dragBaseRect = () => {
      if (drag.type !== "pane-drag") return null;
      if (drag.mode === "floating") return drag.origRect;
      memo.baseRect ??= getRememberedFloatingRect(baseLayout, drag.paneId, width, contentHeight, paneMap.get(drag.paneId)?.def);
      return memo.baseRect;
    };

    if (event.type === "drag-cancel") {
      // The window lost focus or the system took the pointer: put everything back.
      dropPendingJoin(memo);
      cancelActiveDrag();
      event.stopPropagation();
      event.preventDefault();
      return;
    }

    if (event.type === "drag") {
      if (drag.type === "divider") {
        // Where the pointer is, not where it is predicted to be: the panes
        // resize to it, and the release lays them out at the same place.
        const nextRatio = dividerRatioAt(preciseX, preciseShellY);
        const pathKey = drag.path.join(".");
        // The desktop lays the split out as the release will, so the panes on
        // both sides follow the pointer with the divider.
        const split = nativePaneChrome ? getDockSplitGeometry(baseLayout, drag.path, drag.bounds, nextRatio, dockGeometryOptions) : null;
        const own = split?.dividers[0];
        if (split && own) {
          updateDividerPreview({ pathKey, rect: own.rect, ratio: nextRatio }, {
            leaves: new Map(split.leaves.map((leaf) => [leaf.instanceId, leaf.rect])),
            dividers: new Map(split.dividers.map((divider) => [divider.path.join("."), divider.rect])),
          });
        } else {
          const nextRect = resolveDividerPreviewRect(drag.axis, drag.bounds, nextRatio, nativePaneChrome === true);
          updateDividerPreview({ pathKey, rect: nextRect, ratio: nextRatio });
        }
      } else if (drag.type === "pane-drag") {
        if (!isMeaningfulPaneDrag(drag.startX, drag.startY, preciseX, preciseShellY, dragThreshold)) {
          updateDockPreview(null);
          if (drag.mode === "floating") {
            updateDragFloatingRect({ paneId: drag.paneId, rect: drag.origRect });
          }
          event.stopPropagation();
          event.preventDefault();
          return;
        }

        const nextRect = snapMove(drag.paneId, resolvePaneDragFloatingRect(drag, dragBaseRect()!, drawX, drawShellY, width, contentHeight));
        updateDragFloatingRect({ paneId: drag.paneId, rect: nextRect });

        // Over a title bar it would be a tab there; pushed against a docked
        // pane's edge it would join the dock on that side.
        const target = resolvePaneDropTarget({
          x: hitX,
          y: hitShellY,
          rect: nextRect,
          free: freePaneDragRect(drag, dragBaseRect()!, drawX, drawShellY, width, contentHeight),
          leaves: dockLeafLayouts,
          paneId: drag.paneId,
          area: bounds,
          flush: { x: magnetDistances.catchX, y: magnetDistances.catchY },
          headerRows: paneHeaderRows(nativePaneChrome),
          join: !magnetsOff,
        });
        const showSnapGuide = () => {
          const snapGuide = resolveSnapGuide(hitX, hitShellY, snapGuides);
          updateDockPreview(snapGuide ? { kind: "snap", position: snapGuide.position, rect: snapGuide.previewRect } : null);
        };
        if (target) {
          const dropKey = target.kind === "tab" ? `tab:${target.targetId}` : target.kind === "leaf" ? `${target.targetId}:${target.position}` : target.edge;
          const showDrop = () => {
            if (memo.dropKey !== dropKey) {
              const simulation = simulateDrop(baseLayout, drag.paneId, target, bounds, dockGeometryOptions);
              memo.dropKey = dropKey;
              memo.drop = simulation.previewRect ? { kind: "dock", target, rect: simulation.previewRect } : null;
            }
            updateDockPreview(memo.drop);
          };
          if (target.kind === "leaf") {
            // A join arms once the edge has held, and shows its preview then:
            // a release before that leaves the pane floating where it is.
            if (memo.join?.key !== dropKey) {
              dropPendingJoin(memo);
              const join: PendingJoin = { key: dropKey, armed: false, timer: null };
              join.timer = setTimeout(() => {
                if (memo.join !== join || dragRef.current !== drag) return;
                join.armed = true;
                join.timer = null;
                showDrop();
              }, JOIN_DWELL_MS);
              memo.join = join;
            }
            if (memo.join?.armed) showDrop();
            else showSnapGuide();
          } else {
            dropPendingJoin(memo);
            showDrop();
          }
        } else {
          dropPendingJoin(memo);
          showSnapGuide();
        }
      } else if (drag.type === "float-resize") {
        updateDragFloatingRect({
          paneId: drag.paneId,
          rect: snapResize(drag.paneId, resolveFloatResizeRect(drag, preciseX, preciseShellY, width, contentHeight), drag.edges ?? CORNER_EDGES),
        });
      }
      event.stopPropagation();
      event.preventDefault();
      return;
    }

    if (event.type === "up" || event.type === "drag-end") {
      dropPendingJoin(memo);
      if (drag.type === "divider") {
        if (live.get().divider) {
          const nextLayout = resizeSplitAtPath(baseLayout, drag.path, dividerRatioAt(preciseX, preciseShellY));
          if (windowMode) {
            updateWindowModePreviewLayout(nextLayout);
          } else {
            persistLayout(nextLayout);
          }
        }
        updateDividerPreview(null);
      } else if (drag.type === "pane-drag") {
        const movedEnough = isMeaningfulPaneDrag(drag.startX, drag.startY, preciseX, preciseShellY, dragThreshold);
        if (!movedEnough) {
          updateDockPreview(null);
          updateDragFloatingRect(null);
          // A click on a stack's tab shows that pane.
          if (drag.mode === "docked") focusPane(drag.paneId);
        } else {
          const releaseRect = snapMove(drag.paneId, resolvePaneDragFloatingRect(drag, dragBaseRect()!, preciseX, preciseShellY, width, contentHeight));
          const nextLayout = finalizePaneDragRelease(baseLayout, drag.paneId, releaseRect, live.get().dockPreview);
          if (windowMode) {
            updateWindowModePreviewLayout(nextLayout, drag.paneId);
          } else {
            persistLayout(nextLayout);
          }
          focusPane(drag.paneId);
          updateDockPreview(null);
          updateDragFloatingRect(null);
        }
      } else if (drag.type === "float-resize") {
        const releaseRect = snapResize(drag.paneId, resolveFloatResizeRect(drag, preciseX, preciseShellY, width, contentHeight), drag.edges ?? CORNER_EDGES);
        const nextLayout = floatAtRect(baseLayout, drag.paneId, releaseRect);
        if (windowMode) {
          updateWindowModePreviewLayout(nextLayout, drag.paneId);
        } else {
          persistLayout(nextLayout);
        }
        updateDragFloatingRect(null);
      }
      endDrag();
      event.stopPropagation();
      event.preventDefault();
    }
  }, [
    appHeaderHeight,
    bounds,
    cancelActiveDrag,
    contentHeight,
    dockGeometryOptions,
    dockLeafLayouts,
    dragRef,
    endDrag,
    focusPane,
    live,
    magnetDistances,
    nativePaneChrome,
    paneMap,
    persistLayout,
    precisePointer,
    snapGuides,
    updateDividerPreview,
    updateDockPreview,
    updateDragFloatingRect,
    updateWindowModePreviewLayout,
    visibleLayout,
    windowMode,
    width,
  ]);
  handleRef.current = handle;
  return handle;
}
