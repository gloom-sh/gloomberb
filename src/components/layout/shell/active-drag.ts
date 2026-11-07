import { useCallback, useEffect, useRef } from "react";
import {
  floatAtRect,
  floatingSplitRects,
  floatingStackMembers,
  getDockSplitGeometry,
  getRememberedFloatingRect,
  hiddenFloatingTabIds,
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH,
  resizeSplitAtPath,
  simulateDrop,
  type DockGeometryOptions,
  type DockLeafLayout,
  type DropTarget,
  type FloatingRect,
  type LayoutBounds,
  type ResolvedPane,
} from "../../../layout/pane-manager";
import type { LayoutConfig } from "../../../types/config";
import {
  constrainFloatingRectToBounds,
  finalizePaneDragRelease,
  isMeaningfulPaneDrag,
  PANE_DRAG_THRESHOLD,
  PRECISE_PANE_DRAG_THRESHOLD,
  resolveDividerPreviewRect,
  resolveFloatResizeRect,
  resolvePaneDragFloatingRect,
  type DragPreview,
  type PaneDragMode,
} from "./drag";
import type { ShellDragRuntimeState, ShellMouseEvent } from "./drag/runtime";
import type { WindowEditState } from "../window-edit/mode";
import {
  createMagnetGlide,
  createMagnetPace,
  NO_GLIDE,
  NO_LATCH,
  snapMovedRect,
  snapResizedRect,
  type MagnetDistances,
  type MagnetGlide,
  type MagnetLatch,
  type MagnetPace,
} from "./drag/magnets";
import { applySharedEdges, NO_SHARED_EDGES, resolveSharedEdges, type SharedEdgeGroups } from "./drag/shared-edges";
import { resolveDropZone, type DropZoneHost, type DropZoneMetrics, type DropZoneState } from "./drag/drop-zones";

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
  /** The size of the drop targets a moving pane is offered, in cells. */
  dropZoneMetrics: DropZoneMetrics;
  nativePaneChrome: boolean;
  paneMap: Map<string, ResolvedPane>;
  persistLayout: (nextLayout: LayoutConfig, options?: { pushHistory?: boolean }) => void;
  precisePointer: boolean | undefined;
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
  dropZoneMetrics,
  nativePaneChrome,
  paneMap,
  persistLayout,
  precisePointer,
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
    updateDragPartners,
    updateDropZone,
  } = dragRuntime;
  // What one drag keeps between moves: a layout pane's floating size, the
  // panes it can land on and the last target it laid out, so a move over the
  // same target computes nothing, the edges its magnets hold, with the other
  // panes' rects they hold to, a resize's windows snapped edge to edge with
  // it, and on the desktop where the pointer has been lately (the magnets wait
  // for it to slow down) with the check that catches once it rests, and where
  // the pane is drawn against where the pointer puts it, with the frame that
  // moves it there while the pointer is still.
  const memoRef = useRef<{
    drag: unknown;
    baseRect: FloatingRect | null;
    hosts: DropZoneHost[] | null;
    dropKey: string | null;
    drop: DragPreview | null;
    latch: MagnetLatch;
    magnetTargets: LayoutBounds[] | null;
    shared: SharedEdgeGroups | null;
    pace: MagnetPace;
    glide: MagnetGlide;
  }>({
    drag: null, baseRect: null, hosts: null, dropKey: null, drop: null, latch: NO_LATCH, magnetTargets: null,
    shared: null, pace: createMagnetPace(), glide: createMagnetGlide(),
  });
  useEffect(() => () => {
    memoRef.current.pace.reset();
    memoRef.current.glide.reset();
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
      memo.shared = null;
      memo.hosts = null;
      memo.pace.reset();
      memo.glide.reset();
    }
    // Any later event supersedes the rest check of an earlier move.
    memo.pace.cancel();
    // Every other pane on screen, docked or floating, whose edges a floating
    // pane's edges stick to. Alt (Option) lets it go anywhere.
    // A resize leaves out the windows it moves along a shared edge.
    const magnetTargets = (paneId: string) => {
      const moving = memo.shared?.ids;
      memo.magnetTargets ??= [
        ...dockLeafLayouts.filter((leaf) => leaf.instanceId !== paneId).map((leaf) => leaf.rect),
        ...baseLayout.floating
          .filter((entry) => entry.instanceId !== paneId && paneMap.has(entry.instanceId) && !moving?.has(entry.instanceId))
          .map(({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h })),
      ];
      return memo.magnetTargets;
    };
    // The windows on screen a resize can share an edge with: each stack once, as the tab it shows.
    const sharedEdgesOf = (paneId: string, origRect: FloatingRect, edges: { x: -1 | 0 | 1; y: -1 | 0 | 1 }) => {
      if (memo.shared) return memo.shared;
      const hidden = hiddenFloatingTabIds(baseLayout.floating);
      const own = baseLayout.floating.find((entry) => entry.instanceId === paneId)?.stack;
      const windows = baseLayout.floating
        .filter((entry) => paneMap.has(entry.instanceId) && !hidden.has(entry.instanceId) && (!own || entry.stack !== own))
        .map((entry) => ({ id: entry.instanceId, rect: { x: entry.x, y: entry.y, width: entry.width, height: entry.height, zIndex: entry.zIndex } }));
      memo.shared = resolveSharedEdges(windows, { id: paneId, rect: origRect }, edges);
      return memo.shared;
    };
    const magnetsOff = event.modifiers?.alt === true;
    // A resize as the pointer has it: the window, and those it moves along a
    // shared edge. Alt (Option) resizes the window alone.
    const resizeWithShared = (paneId: string, origRect: FloatingRect, resized: FloatingRect, edges: { x: -1 | 0 | 1; y: -1 | 0 | 1 }) => {
      const shared = sharedEdgesOf(paneId, origRect, edges);
      if (shared === NO_SHARED_EDGES || magnetsOff) return { rect: resized, partners: null };
      const rects = applySharedEdges(shared, paneId, resized, { width, height: contentHeight });
      const rect = { ...(rects.get(paneId) ?? resized), zIndex: resized.zIndex };
      rects.delete(paneId);
      return { rect, partners: rects };
    };
    const magnetArea = { x: 0, y: 0, width, height: contentHeight };
    // Desktop: past the travel speed a release lands the pane where the
    // pointer puts it, its magnets left out (the rest check runs the last move
    // again once the pointer has stopped, so a release then catches). What
    // they hold to still follows every move, so it rests where it would have.
    const travelling = () => {
      if (!nativePaneChrome || drag.type !== "pane-drag") return false;
      // A release lands where the pane is drawn: no catch after it.
      const rest = event.type === "drag" ? () => { if (dragRef.current === drag) handleRef.current(event); } : undefined;
      return memo.pace.travelling({ t: performance.now(), x: preciseX, y: preciseShellY }, magnetDistances, rest);
    };
    // Where a move lands the pane (`rect`), and where its magnets hold it as
    // the pointer slows down (`snapped`).
    const snapMove = (paneId: string, rect: FloatingRect): { rect: FloatingRect; snapped: FloatingRect } => {
      if (magnetsOff) {
        memo.latch = NO_LATCH;
        return { rect, snapped: rect };
      }
      const snapped = snapMovedRect(rect, magnetTargets(paneId), magnetArea, magnetDistances, memo.latch);
      memo.latch = snapped.latch;
      return { rect: travelling() ? rect : snapped.rect, snapped: snapped.rect };
    };
    // Desktop: the moving pane is drawn under the pointer while it moves, and
    // where its magnets hold it once the pointer slows down to place it,
    // gliding between the two (the frames after the pointer stops carry the
    // glide on). The terminal draws where a release would land it.
    const drawMove = (paneId: string, free: FloatingRect, moved: { rect: FloatingRect; snapped: FloatingRect }) => {
      if (!nativePaneChrome) {
        updateDragFloatingRect({ paneId, rect: moved.rect });
        return;
      }
      const { snapped } = moved;
      let drawn: { x: number; y: number } | null = null;
      memo.glide.follow(() => {
        const now = performance.now();
        const placing = memo.pace.placing(now, magnetDistances);
        const target = placing ? { x: snapped.x - free.x, y: snapped.y - free.y } : NO_GLIDE;
        const offset = memo.glide.step(now, target);
        // A frame that moves nothing (the pointer still, the glide at rest) restyles nothing.
        if (!drawn || drawn.x !== offset.x || drawn.y !== offset.y) {
          drawn = offset;
          updateDragFloatingRect({ paneId, rect: { ...free, x: free.x + offset.x, y: free.y + offset.y } });
        }
        return placing && memo.glide.settled(target);
      });
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
    // The panes a moving pane can land on, front to back, each once: floating
    // windows (a stack as the tab it shows), then the spots of the layout.
    // Its own window or spot is no target, but the other tabs of its stack are.
    const dropHostsOf = (paneId: string, mode: PaneDragMode): DropZoneHost[] => {
      if (memo.hosts) return memo.hosts;
      const hidden = hiddenFloatingTabIds(baseLayout.floating);
      const ownStack = baseLayout.floating.find((entry) => entry.instanceId === paneId)?.stack;
      const floatingHosts = baseLayout.floating
        .filter((entry) => paneMap.has(entry.instanceId) && !hidden.has(entry.instanceId))
        .filter((entry) => (mode === "floating" ? entry.instanceId !== paneId && (!ownStack || entry.stack !== ownStack) : true))
        .sort((a, b) => (b.zIndex ?? 50) - (a.zIndex ?? 50))
        .flatMap((entry): DropZoneHost[] => {
          const rect = constrainFloatingRectToBounds(entry, width, contentHeight);
          if (entry.instanceId !== paneId) return [{ id: entry.instanceId, rect, docked: false }];
          // A tab dragged out of the stack it shows: the stack is still there, as its other tabs.
          const other = floatingStackMembers(baseLayout.floating, paneId).find((member) => member.instanceId !== paneId);
          return other ? [{ id: other.instanceId, rect, docked: false }] : [];
        });
      const dockedHosts = dockLeafLayouts.flatMap((leaf): DropZoneHost[] => {
        const own = leaf.instanceId === paneId || (leaf.stack?.includes(paneId) ?? false);
        const id = !own ? leaf.instanceId : leaf.stack?.find((member) => member !== paneId);
        return id ? [{ id, rect: leaf.rect, docked: true }] : [];
      });
      memo.hosts = [...floatingHosts, ...dockedHosts];
      return memo.hosts;
    };
    // What a release over `zone` lays out, as the preview shows it: its place
    // in the layout, or the floating window's rect or half.
    const previewOfZone = (paneId: string, zone: DropZoneState): DragPreview | null => {
      const key = zone.edge ? `edge:${zone.edge}` : zone.host && zone.side ? `${zone.host.id}:${zone.side}` : null;
      if (!key) return null;
      if (memo.dropKey === key) return memo.drop;
      memo.dropKey = key;
      const dock = (target: DropTarget): DragPreview | null => {
        const simulation = simulateDrop(baseLayout, paneId, target, bounds, dockGeometryOptions);
        return simulation.previewRect ? { kind: "dock", target, rect: simulation.previewRect } : null;
      };
      if (zone.edge) {
        memo.drop = dock({ kind: "frame", edge: zone.edge });
      } else if (zone.host && zone.side) {
        const { host, side } = zone;
        if (host.docked) {
          memo.drop = dock(side === "center" ? { kind: "tab", targetId: host.id } : { kind: "leaf", targetId: host.id, position: side });
        } else if (side === "center") {
          memo.drop = { kind: "float", drop: { type: "tab", targetId: host.id }, rect: host.rect };
        } else {
          memo.drop = { kind: "float", drop: { type: "split", targetId: host.id, side }, rect: floatingSplitRects(host.rect, side)[0] };
        }
      }
      return memo.drop;
    };
    const dragBaseRect = () => {
      if (drag.type !== "pane-drag") return null;
      if (drag.mode === "floating") return drag.origRect;
      // A tab pulled out of a floating stack keeps the stack's size.
      if (drag.mode === "tab") return drag.origRect;
      memo.baseRect ??= getRememberedFloatingRect(baseLayout, drag.paneId, width, contentHeight, paneMap.get(drag.paneId)?.def);
      return memo.baseRect;
    };

    if (event.type === "drag-cancel") {
      // The window lost focus or the system took the pointer: put everything back.
      memo.glide.reset();
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
          memo.glide.reset();
          updateDockPreview(null);
          updateDropZone(null);
          if (drag.mode === "floating") {
            updateDragFloatingRect({ paneId: drag.paneId, rect: drag.origRect });
          }
          event.stopPropagation();
          event.preventDefault();
          return;
        }

        const freeRect = resolvePaneDragFloatingRect(drag, dragBaseRect()!, drawX, drawShellY, width, contentHeight);
        drawMove(drag.paneId, freeRect, snapMove(drag.paneId, freeRect));

        // The targets in sight decide, and nothing else: over a pane, the
        // square of its target under the pointer; along the window's edge,
        // its strip; anywhere else the pane floats where it is drawn.
        const zone = resolveDropZone({
          x: hitX,
          y: hitShellY,
          hosts: dropHostsOf(drag.paneId, drag.mode),
          area: bounds,
          metrics: dropZoneMetrics,
        });
        updateDropZone(zone);
        updateDockPreview(previewOfZone(drag.paneId, zone));
      } else if (drag.type === "float-resize") {
        const edges = drag.edges ?? CORNER_EDGES;
        sharedEdgesOf(drag.paneId, drag.origRect, edges);
        const resized = resizeWithShared(
          drag.paneId,
          drag.origRect,
          snapResize(drag.paneId, resolveFloatResizeRect(drag, preciseX, preciseShellY, width, contentHeight), edges),
          edges,
        );
        updateDragFloatingRect({ paneId: drag.paneId, rect: resized.rect });
        updateDragPartners(resized.partners);
      }
      event.stopPropagation();
      event.preventDefault();
      return;
    }

    if (event.type === "up" || event.type === "drag-end") {
      memo.glide.reset();
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
          updateDropZone(null);
          updateDragFloatingRect(null);
          // A click on a stack's tab shows that pane.
          if (drag.mode !== "floating") focusPane(drag.paneId);
        } else {
          const releaseRect = snapMove(drag.paneId, resolvePaneDragFloatingRect(drag, dragBaseRect()!, preciseX, preciseShellY, width, contentHeight)).rect;
          const nextLayout = finalizePaneDragRelease(baseLayout, drag.paneId, releaseRect, live.get().dockPreview, drag.mode);
          if (windowMode) {
            updateWindowModePreviewLayout(nextLayout, drag.paneId);
          } else {
            persistLayout(nextLayout);
          }
          focusPane(drag.paneId);
          updateDockPreview(null);
          updateDropZone(null);
          updateDragFloatingRect(null);
        }
      } else if (drag.type === "float-resize") {
        const edges = drag.edges ?? CORNER_EDGES;
        sharedEdgesOf(drag.paneId, drag.origRect, edges);
        const released = resizeWithShared(
          drag.paneId,
          drag.origRect,
          snapResize(drag.paneId, resolveFloatResizeRect(drag, preciseX, preciseShellY, width, contentHeight), edges),
          edges,
        );
        let nextLayout = floatAtRect(baseLayout, drag.paneId, released.rect);
        for (const [partnerId, rect] of released.partners ?? []) nextLayout = floatAtRect(nextLayout, partnerId, rect);
        if (windowMode) {
          updateWindowModePreviewLayout(nextLayout, drag.paneId);
        } else {
          persistLayout(nextLayout);
        }
        updateDragFloatingRect(null);
        updateDragPartners(null);
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
    dropZoneMetrics,
    endDrag,
    focusPane,
    live,
    magnetDistances,
    nativePaneChrome,
    paneMap,
    persistLayout,
    precisePointer,
    updateDividerPreview,
    updateDockPreview,
    updateDragFloatingRect,
    updateDragPartners,
    updateDropZone,
    updateWindowModePreviewLayout,
    visibleLayout,
    windowMode,
    width,
  ]);
  handleRef.current = handle;
  return handle;
}
