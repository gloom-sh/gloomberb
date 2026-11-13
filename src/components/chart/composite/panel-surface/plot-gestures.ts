import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { useNativeRenderer } from "../../../../ui";
import type { MeasuredCellSize } from "../../../../ui/measured-cells";
import { consumeChartMouseEvent, getGlobalMouseX, type ChartMouseEvent, type LocalPlotPointer } from "../../core/pointer";
import { nextDrawingId, nextLevelId } from "../drawing-store";
import { hitTestLevel, levelGrabRatio, roundLevelValue, type ProjectedLevel } from "../levels";
import {
  AXIS_DOUBLE_PRESS_MS,
  manualValueAxes,
  panReleaseVelocity,
  PLOT_DOUBLE_CLICK_MS,
  releaseEditableFocus,
  startPanGesture,
  type PanGesture,
  type PanSample,
} from "../panel-gestures";
import { resolveCompositeCursorDate, unprojectCompositeValue } from "../scene";
import {
  hitTestDrawings,
  isDrawingTool,
  resolveChartToolKind,
  resolveDrawingFromDrag,
  resolveZoomBoxRange,
  shiftDrawing,
  type ChartToolDrag,
} from "../tools";
import type { CompositeAxisDomain } from "../types";
import { panValueRange } from "../value-scale";
import type { LevelDraft } from "./panel-levels";
import { pointerRow } from "./pointer";
import type { CompositePanelSurfaceProps } from "./props";

/** What a press on the plot is doing until it lets go. */
type PlotDrag =
  | PanGesture
  | {
    kind: "edit";
    drawingId: string;
    pointIndex: number | null;
    lastXRatio: number;
    lastYRatio: number;
  }
  | { kind: "level-move"; id: string }
  | ChartToolDrag;

/**
 * A press on the plot and what it drags: a pan (which coasts on the desktop
 * when let go while moving), a tool in hand, a drawing or a level; with
 * nothing to drag, a pick, or a double press that maximizes the panel.
 */
export function usePlotGestures({
  panel,
  scene,
  frame,
  viewport,
  armedTool,
  drawings,
  drawColor,
  levels,
  plotWidth,
  onActivate,
  onPointerPress,
  onPickTime,
  onPickPrice,
  onSelectDrawing,
  onEditDrawing,
  onDraw,
  onSelectLevel,
  onPanViewport,
  onSetViewport,
  onSetValueScale,
  onDragActiveChange,
  onToggleMaximized,
  isDesktopWeb,
  renderer,
  plotSize,
  plotAspect,
  plotSpanFactor,
  setToolDrag,
  levelDomain,
  projectedLevels,
  levelDraftRef,
  setLevelDraft,
  plotPointer,
  pointerRatios,
  updateCursor,
  stopCoast,
  startCoast,
}: Pick<
  CompositePanelSurfaceProps,
  | "panel" | "scene" | "frame" | "viewport" | "armedTool" | "drawings" | "drawColor" | "levels" | "plotWidth"
  | "onActivate" | "onPointerPress" | "onPickTime" | "onPickPrice" | "onSelectDrawing" | "onEditDrawing" | "onDraw"
  | "onSelectLevel" | "onPanViewport" | "onSetViewport" | "onSetValueScale" | "onDragActiveChange" | "onToggleMaximized"
> & {
  isDesktopWeb: boolean;
  renderer: ReturnType<typeof useNativeRenderer>;
  plotSize: MeasuredCellSize;
  plotAspect: number;
  plotSpanFactor: number;
  setToolDrag: Dispatch<SetStateAction<ChartToolDrag | null>>;
  levelDomain: CompositeAxisDomain | null;
  projectedLevels: readonly ProjectedLevel[];
  levelDraftRef: RefObject<LevelDraft | null>;
  setLevelDraft: Dispatch<SetStateAction<LevelDraft | null>>;
  plotPointer: (event: ChartMouseEvent) => LocalPlotPointer | null;
  pointerRatios: (event: ChartMouseEvent) => { xRatio: number; yRatio: number } | null;
  updateCursor: (event: ChartMouseEvent) => boolean;
  stopCoast: () => void;
  startCoast: (velocity: number, positionsPerCell: number) => void;
}) {
  // The last press on bare plot, for a double press where the host does not count clicks.
  const lastPlotPressRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const dragRef = useRef<PlotDrag | null>(null);
  // Where the pointer was during a pan, for the speed it lets go at.
  const panSamplesRef = useRef<PanSample[]>([]);
  const startDrag = useCallback((event: ChartMouseEvent) => {
    onActivate?.();
    onPointerPress();
    // The plot consumes the press, so the browser never moves focus off a text
    // field for us. Hand it back, but only for a press that truly landed here:
    // a dialog over the plot must keep the focus it just took.
    if (isDesktopWeb) releaseEditableFocus(event);
    consumeChartMouseEvent(event);
    if (onPickTime) {
      const pointer = plotPointer(event);
      const date = pointer ? resolveCompositeCursorDate(scene, pointer.cellX) : null;
      if (date) onPickTime(date);
      return;
    }
    if (onPickPrice) {
      // Only the levels' own panel has their prices; a press elsewhere picks nothing.
      const ratios = pointerRatios(event);
      const value = ratios && levelDomain ? unprojectCompositeValue(ratios.yRatio, levelDomain) : null;
      if (value !== null && levelDomain) onPickPrice(roundLevelValue(value, levelDomain));
      return;
    }
    // A keyboard-armed tool covers terminals that never forward modifier drags.
    const tool = resolveChartToolKind(event.modifiers) ?? armedTool;
    if (tool === "level" && levels?.onEdit && levelDomain) {
      const ratios = pointerRatios(event);
      if (!ratios) return;
      const hit = hitTestLevel(projectedLevels, ratios.yRatio, levelGrabRatio(panel.height));
      if (hit) {
        onSelectLevel(hit.id);
        if (hit.editable) dragRef.current = { kind: "level-move", id: hit.id };
      } else {
        const value = unprojectCompositeValue(ratios.yRatio, levelDomain);
        if (value !== null) {
          const id = nextLevelId();
          levels.onEdit({ kind: "add", id, value: roundLevelValue(value, levelDomain) });
          onSelectLevel(id);
        }
      }
      updateCursor(event);
      return;
    }
    if (tool) {
      const ratios = pointerRatios(event);
      if (!ratios) return;
      // With a drawing tool in hand, grabbing an existing shape edits it
      // instead of starting a new one on top of it.
      const hit = isDrawingTool(tool)
        ? hitTestDrawings(drawings, scene, panel, ratios, plotAspect)
        : null;
      if (hit) {
        onSelectDrawing(hit.drawing.id);
        dragRef.current = {
          kind: "edit",
          drawingId: hit.drawing.id,
          pointIndex: hit.pointIndex,
          lastXRatio: ratios.xRatio,
          lastYRatio: ratios.yRatio,
        };
        updateCursor(event);
        return;
      }
      const started: ChartToolDrag = {
        kind: tool,
        startXRatio: ratios.xRatio,
        startYRatio: ratios.yRatio,
        endXRatio: ratios.xRatio,
        endYRatio: ratios.yRatio,
        path: [{ xRatio: ratios.xRatio, yRatio: ratios.yRatio }],
      };
      if (isDrawingTool(tool)) onSelectDrawing(null);
      dragRef.current = { ...started, path: [...started.path] };
      setToolDrag(started);
      updateCursor(event);
      return;
    }
    // With no tool in hand, a press on a drawing or a level picks it so Backspace
    // or Delete can remove it; the press still pans, and one on bare plot lets go.
    const ratios = pointerRatios(event);
    let bare = true;
    if (ratios) {
      const drawingHit = drawings.length > 0 ? hitTestDrawings(drawings, scene, panel, ratios, plotAspect) : null;
      const levelHit = !drawingHit && levels?.onEdit && levelDomain
        ? hitTestLevel(projectedLevels, ratios.yRatio, levelGrabRatio(panel.height))
        : null;
      onSelectDrawing(drawingHit ? drawingHit.drawing.id : null);
      onSelectLevel(levelHit?.editable ? levelHit.id : null);
      bare = !drawingHit && !levelHit;
      // An order's line drags without the level tool; other levels keep the press for panning.
      if (levelHit?.editable && levelHit.draggable) {
        dragRef.current = { kind: "level-move", id: levelHit.id };
        lastPlotPressRef.current = null;
        updateCursor(event);
        return;
      }
    }
    // A double click on bare plot gives the panel the whole chart, or the
    // others back (the terminal counts two presses on one spot). Its first
    // press must have landed here too: a double click on a button that goes
    // away under it (All panels) ends on this plot, and is not one of its.
    if (!bare) lastPlotPressRef.current = null;
    if (onToggleMaximized && bare) {
      const now = Date.now();
      const last = lastPlotPressRef.current;
      const double = typeof event.detail === "number"
        ? event.detail >= 2 && !!last && now - last.at < PLOT_DOUBLE_CLICK_MS
        : !!last && now - last.at < AXIS_DOUBLE_PRESS_MS && Math.abs(last.x - event.x) <= 1 && Math.abs(last.y - event.y) <= 1;
      lastPlotPressRef.current = double ? null : { at: now, x: event.x, y: event.y };
      if (double) {
        dragRef.current = null;
        onToggleMaximized();
        return;
      }
    }
    if (!updateCursor(event)) return;
    const values = manualValueAxes(panel);
    panSamplesRef.current = [{ at: performance.now(), x: getGlobalMouseX(event, renderer) }];
    dragRef.current = {
      ...startPanGesture(
        frame,
        viewport,
        plotSize.width,
        getGlobalMouseX(event, renderer),
        plotSpanFactor,
      ),
      // A panel scaled by hand moves up and down with the drag as well.
      ...(values.length > 0 ? { startCellY: pointerRow(event), values } : {}),
    };
  }, [
    armedTool,
    drawings,
    frame,
    levelDomain,
    levels,
    onActivate,
    onPickTime,
    onPickPrice,
    onPointerPress,
    onSelectDrawing,
    onSelectLevel,
    panel,
    plotAspect,
    projectedLevels,
    plotPointer,
    plotSize.width,
    plotSpanFactor,
    plotWidth,
    pointerRatios,
    renderer,
    scene,
    updateCursor,
    viewport,
    onToggleMaximized,
  ]);
  const pressCursor = useCallback((event: ChartMouseEvent) => {
    onActivate?.();
    updateCursor(event);
  }, [onActivate, updateCursor]);
  const dragViewport = useCallback((event: ChartMouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    consumeChartMouseEvent(event);
    updateCursor(event);
    if (drag.kind === "level-move") {
      const ratios = pointerRatios(event);
      const value = ratios && levelDomain ? unprojectCompositeValue(ratios.yRatio, levelDomain) : null;
      if (value === null || !levelDomain) return;
      const draft = { id: drag.id, value: roundLevelValue(value, levelDomain) };
      // The release reads the ref, and a quick drag lets go before the next render.
      levelDraftRef.current = draft;
      setLevelDraft(draft);
      return;
    }
    if (drag.kind === "edit") {
      const ratios = pointerRatios(event);
      if (!ratios) return;
      // Read the deltas before advancing the ref: the state updater runs later,
      // and a mutable capture would hand it a zero move every time.
      const deltaXRatio = ratios.xRatio - drag.lastXRatio;
      const deltaYRatio = ratios.yRatio - drag.lastYRatio;
      const { drawingId, pointIndex } = drag;
      drag.lastXRatio = ratios.xRatio;
      drag.lastYRatio = ratios.yRatio;
      onEditDrawing(
        drawingId,
        (drawing) => shiftDrawing(drawing, scene, panel, deltaXRatio, deltaYRatio, pointIndex),
      );
      return;
    }
    if (drag.kind !== "pan") {
      const ratios = pointerRatios(event);
      if (!ratios) return;
      drag.endXRatio = ratios.xRatio;
      drag.endYRatio = ratios.yRatio;
      if (drag.kind === "pencil") drag.path.push({ xRatio: ratios.xRatio, yRatio: ratios.yRatio });
      setToolDrag({ ...drag, path: [...drag.path] });
      return;
    }
    const globalX = getGlobalMouseX(event, renderer);
    panSamplesRef.current.push({ at: performance.now(), x: globalX });
    if (panSamplesRef.current.length > 12) panSamplesRef.current.shift();
    if (drag.frame !== frame) {
      // Data refreshed mid-drag. The new frame maps positions differently, so
      // continue from where the plot is now instead of replaying the drag.
      Object.assign(drag, startPanGesture(frame, viewport, plotSize.width, globalX, plotSpanFactor));
    }
    onPanViewport(
      (globalX - drag.startGlobalX) * drag.positionsPerCell,
      { frame: drag.frame, from: drag.startViewport },
    );
    if (drag.values && drag.startCellY !== undefined) {
      const deltaRatio = (pointerRow(event) - drag.startCellY) / Math.max(plotSize.height, 1);
      for (const axis of drag.values) {
        onSetValueScale(panel.id, axis.side, axis.key, panValueRange(axis.start, axis.scale, deltaRatio));
      }
    }
  }, [
    frame,
    levelDomain,
    onEditDrawing,
    onPanViewport,
    onSetValueScale,
    plotSize.height,
    panel,
    plotSize.width,
    plotSpanFactor,
    plotWidth,
    pointerRatios,
    renderer,
    scene,
    updateCursor,
    viewport,
  ]);
  const finishToolDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag || drag.kind === "pan") return;
    dragRef.current = null;
    if (drag.kind === "edit") return;
    if (drag.kind === "level-move") {
      const draft = levelDraftRef.current;
      setLevelDraft(null);
      if (draft) levels?.onEdit?.({ kind: "move", id: draft.id, value: draft.value });
      return;
    }
    setToolDrag(null);
    if (isDrawingTool(drag.kind)) {
      const drawing = resolveDrawingFromDrag(scene, panel, drag, drawColor, nextDrawingId());
      if (drawing) onDraw(drawing);
      return;
    }
    if (drag.kind !== "zoom") return;
    const range = resolveZoomBoxRange(scene, drag, frame.minimumSpanMs);
    if (range) onSetViewport(range);
  }, [drawColor, frame.minimumSpanMs, levels, onDraw, onSetViewport, panel, scene]);
  const resetDrag = useCallback(() => {
    const drag = dragRef.current;
    if (drag?.kind === "pan") {
      dragRef.current = null;
      startCoast(panReleaseVelocity(panSamplesRef.current, performance.now()), drag.positionsPerCell);
      return;
    }
    finishToolDrag();
  }, [finishToolDrag, startCoast]);
  // Said once per change, so a pointer move costs the chart nothing.
  const reportedDragRef = useRef(false);
  const reportDrag = useCallback((dragging: boolean) => {
    if (reportedDragRef.current === dragging) return;
    reportedDragRef.current = dragging;
    onDragActiveChange?.(dragging);
  }, [onDragActiveChange]);
  const pressPlot = useCallback((event: ChartMouseEvent) => {
    stopCoast();
    const before = dragRef.current;
    startDrag(event);
    if (dragRef.current !== null && dragRef.current !== before) reportDrag(true);
  }, [reportDrag, startDrag, stopCoast]);
  const releasePlot = useCallback(() => {
    resetDrag();
    reportDrag(false);
  }, [reportDrag, resetDrag]);
  const handleMouseMove = useCallback((event: ChartMouseEvent) => {
    // A release over a neighbouring pane never reaches this surface, so treat a
    // plain move, which only fires with no button held, as the missing release.
    finishToolDrag();
    reportDrag(false);
    updateCursor(event);
  }, [finishToolDrag, reportDrag, updateCursor]);
  return { pressPlot, pressCursor, dragViewport, releasePlot, handleMouseMove };
}
