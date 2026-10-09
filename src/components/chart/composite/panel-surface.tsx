import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  ChartSurface,
  Text,
  useNativeRenderer,
  useUiCapabilities,
  type BoxRenderable,
  type ChartSurfaceProps,
} from "../../../ui";
import { colors as themeColors } from "../../../theme/colors";
import { consumeChartMouseEvent, getGlobalMouseX, getLocalPlotPointer, type ChartMouseEvent } from "../core/pointer";
import { useStaticChartBitmapSize } from "./bitmap";
import { PriceAxisLabels } from "./price-axis-labels";
import { formatCompositeCursorValue, type CompositeAxisValueFormatter } from "./format";
import {
  compositeViewportPositions,
  resolveCompositeWheelPan,
  resolveCompositeWheelZoom,
  type CompositeNavigationFrame,
  type CompositeViewportRange,
} from "./interactions";
import { buildCompositeColumnLayout } from "./column-layout";
import {
  fitAxisLabels,
  hitTestLevel,
  levelGrabRatio,
  levelVectors,
  paintLevels,
  projectLevels,
  roundLevelValue,
  writeLevelText,
  type CompositeChartLevels,
  type ProjectedLevel,
} from "./levels";
import {
  buildChartToolVectors,
  countMeasureBars,
  drawChartToolOverlay,
  resolveChartToolKind,
  resolveMeasureAxisDomain,
  resolveMeasureDirection,
  hitTestDrawings,
  isDrawingTool,
  resolveDrawingFromDrag,
  resolveZoomBoxRange,
  shiftDrawing,
  summarizeMeasure,
  summarizeZoomRange,
  summarizeZoomSelection,
  type ChartDrawing,
  type ChartToolDrag,
  type ChartToolKind,
} from "./tools";
import { compositeRightOffsetRatio, unprojectCompositeTimestamp } from "./time-scale";
import { resolveCompositeCursorDate, unprojectCompositeValue } from "./scene";
import { compositeAxisTickLabels, renderCompositeAxisText, renderCompositePanelText } from "./text-renderer";
import type { CompositeChartColors, CompositeChartScene, CompositePanelScene } from "./types";

import { useCompositePanelBitmap } from "./panel-bitmap";
import { nextDrawingId, nextLevelId } from "./drawing-store";
import {
  COMPOSITE_PANEL_ROLE,
  isVerticalWheelDirection,
  startPanGesture,
  releaseEditableFocus,
  type PanGesture,
  type PendingWheel,
} from "./panel-gestures";
import { resolvePanelCrosshair, axisLabelRows, cursorAxisLabel, resolveSeriesCursorYRatio } from "./panel-labels";
import type { ChartToolSpan } from "./tools";
import type { KeyboardToolDrag } from "./composite-chart";
const webFrame = globalThis as typeof globalThis & {
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

const NO_LEVELS: readonly ProjectedLevel[] = [];

interface CompositePanelSurfaceProps {
  panel: CompositePanelScene;
  scene: CompositeChartScene;
  plotWidth: number;
  leftAxisWidth: number;
  rightAxisWidth: number;
  axisGap: number;
  colors: CompositeChartColors;
  interactive: boolean;
  /** False keeps the hover cursor but removes pan, zoom, and the tools. */
  navigable: boolean;
  formatAxisValue?: CompositeAxisValueFormatter;
  remoteKind?: string;
  viewport: CompositeViewportRange;
  frame: CompositeNavigationFrame;
  armedTool: ChartToolKind | null;
  drawings: readonly ChartDrawing[];
  selectedDrawingId: string | null;
  drawColor: string;
  onDraw: (drawing: ChartDrawing) => void;
  onEditDrawing: (id: string, update: (drawing: ChartDrawing) => ChartDrawing) => void;
  onSelectDrawing: (id: string | null) => void;
  onActivate?: () => void;
  onCursorDateChange: (date: Date | null) => void;
  /** Positive positions move toward older observations. A gesture supplies the frame and origin it started from. */
  onPanViewport: (
    deltaPositions: number,
    gesture?: { frame: CompositeNavigationFrame; from: CompositeViewportRange },
  ) => void;
  onZoomViewport: (zoomFactor: number, anchorRatio: number) => void;
  onSetViewport: (range: CompositeViewportRange) => void;
  onToolSpanChange: (span: ChartToolSpan | null) => void;
  /** The tool being placed from the keyboard, when it lives in this panel. */
  keyboardToolDrag: KeyboardToolDrag | null;
  /** A press on the plot: the pointer takes over from a keyboard placement. */
  onPointerPress: () => void;
  showTextFallback: boolean;
  /** Set while the owner is picking a bar: a press picks instead of panning. */
  onPickTime?: (date: Date) => void;
  /** The chart's levels when they draw on this panel. */
  levels: CompositeChartLevels | null;
  selectedLevelId: string | null;
  onSelectLevel: (id: string | null) => void;
}

export function CompositePanelSurface({
  panel,
  scene,
  plotWidth,
  leftAxisWidth,
  rightAxisWidth,
  axisGap,
  colors,
  interactive,
  navigable,
  formatAxisValue,
  remoteKind,
  viewport,
  frame,
  armedTool,
  drawings,
  selectedDrawingId,
  drawColor,
  onDraw,
  onEditDrawing,
  onSelectDrawing,
  onActivate,
  onCursorDateChange,
  onPanViewport,
  onZoomViewport,
  onSetViewport,
  onToolSpanChange,
  keyboardToolDrag,
  onPointerPress,
  showTextFallback,
  onPickTime,
  levels,
  selectedLevelId,
  onSelectLevel,
}: CompositePanelSurfaceProps) {
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const { cellHeightPx = 18, cellWidthPx = 8, fractionalViewport = false } = useUiCapabilities();
  const renderer = useNativeRenderer();
  const plotRef = useRef<BoxRenderable | null>(null);
  const [cursorYRatio, setCursorYRatio] = useState<number | null>(null);
  const [toolDrag, setToolDrag] = useState<ChartToolDrag | null>(null);
  // A pointer drag owns the plot while it lasts; otherwise a tool placed from
  // the keyboard draws and reads out exactly like one.
  const keyboardDrag = toolDrag ? null : keyboardToolDrag;
  const activeDrag = toolDrag ?? keyboardDrag?.drag ?? null;
  // A keyboard placement's end sits at the level the user put it, so it
  // draws a level line where otherwise only the pointer would.
  const heldCursorYRatio = keyboardDrag ? keyboardDrag.drag.endYRatio : cursorYRatio;
  const seriesCursorYRatio = useMemo(
    () => resolveSeriesCursorYRatio(panel, scene),
    [panel, scene],
  );
  const activeCursorYRatio = scene.cursorXRatio === null
    ? null
    : heldCursorYRatio ?? seriesCursorYRatio;
  const dragRef = useRef<
    | PanGesture
    | {
      kind: "edit";
      drawingId: string;
      pointIndex: number | null;
      lastXRatio: number;
      lastYRatio: number;
    }
    | { kind: "level-move"; id: string }
    | ChartToolDrag
    | null
  >(null);
  const plotAspect = (plotWidth * cellWidthPx) / Math.max(panel.height * cellHeightPx, 1);
  // The plot is wider than the viewport by the reserved right offset. Gestures
  // read the pointer in plot space, so they convert through this.
  const plotSpanFactor = 1 + compositeRightOffsetRatio(scene.timeScale);
  const bitmapSize = useStaticChartBitmapSize(plotWidth, panel.height);
  const bitmap = useCompositePanelBitmap({ panel, bitmapSize, colors, isDesktopWeb });
  const columnLayout = useMemo(() => buildCompositeColumnLayout(panel), [panel]);
  // The level line follows the pointer only. A keyboard or shared cursor knows
  // its column, and the series markers and axis readout already say the value.
  // A tool placed from the keyboard is the exception: its end is a level.
  const pointerCursorYRatio = scene.cursorXRatio === null ? null : heldCursorYRatio;
  const crosshair = useMemo(
    () => resolvePanelCrosshair(panel, columnLayout, bitmap, scene.cursorXRatio, pointerCursorYRatio, colors.crosshair),
    [bitmap, colors.crosshair, columnLayout, panel, pointerCursorYRatio, scene.cursorXRatio],
  );
  const measureDomain = useMemo(() => resolveMeasureAxisDomain(panel), [panel]);
  const toolReadout = useMemo(() => {
    if (!activeDrag) return null;
    // A keyboard placement knows its data points exactly, even off screen; a
    // pointer drag reads them back from the plot.
    const startTime = keyboardDrag?.start.time
      ?? unprojectCompositeTimestamp(scene.timeScale, activeDrag.startXRatio);
    const endTime = keyboardDrag?.end.time
      ?? unprojectCompositeTimestamp(scene.timeScale, activeDrag.endXRatio);
    if (activeDrag.kind === "zoom") {
      return {
        direction: "up" as const,
        summary: keyboardDrag
          ? summarizeZoomRange(scene, startTime, endTime)
          : summarizeZoomSelection(scene, activeDrag),
        startTime,
        startValueLabel: null,
        endValueLabel: null,
      };
    }
    const startValue = keyboardDrag
      ? keyboardDrag.start.value
      : measureDomain ? unprojectCompositeValue(activeDrag.startYRatio, measureDomain) : null;
    const endValue = keyboardDrag
      ? keyboardDrag.end.value
      : measureDomain ? unprojectCompositeValue(activeDrag.endYRatio, measureDomain) : null;
    return {
      direction: resolveMeasureDirection(startValue, endValue),
      summary: summarizeMeasure({
        startValue,
        endValue,
        startTime,
        endTime,
        // Cross-market cursor stops include every listing's observations;
        // measured bars still follow the primary market's session scale.
        bars: countMeasureBars(scene.timeScale.kind === "market"
          ? scene.timeScale.anchors.map(({ timestamp }) => new Date(timestamp))
          : scene.dates, startTime, endTime),
        domain: measureDomain,
      }),
      startTime,
      startValueLabel: measureDomain && startValue !== null
        ? formatCompositeCursorValue(startValue, measureDomain)
        : null,
      endValueLabel: measureDomain && endValue !== null
        ? formatCompositeCursorValue(endValue, measureDomain)
        : null,
    };
  }, [activeDrag, keyboardDrag, measureDomain, scene]);
  const toolSummary = toolReadout?.summary ?? null;
  const toolStartTime = toolReadout?.startTime ?? null;
  const toolSpan = useMemo(() => {
    if (!activeDrag || !toolSummary || toolStartTime === null) return null;
    return {
      startXRatio: activeDrag.startXRatio,
      endXRatio: activeDrag.endXRatio,
      startTime: toolStartTime,
      color: activeDrag.kind === "zoom"
        ? colors.crosshair
        : toolReadout?.direction === "down" ? colors.negative : themeColors.positive,
    };
  }, [activeDrag, colors.crosshair, colors.negative, toolReadout?.direction, toolStartTime, toolSummary]);
  useEffect(() => {
    onToolSpanChange(toolSpan);
  }, [onToolSpanChange, toolSpan]);
  const panelDrawings = useMemo(
    () => drawings.filter((drawing) => drawing.panelId === panel.id),
    [drawings, panel.id],
  );
  // A dragged level moves here and is saved once, when the pointer lets go.
  const [levelDraft, setLevelDraft] = useState<{ id: string; value: number } | null>(null);
  const levelDraftRef = useRef(levelDraft);
  levelDraftRef.current = levelDraft;
  const levelDomain = useMemo(() => {
    const series = levels ? panel.series.find((entry) => entry.source.id === levels.seriesId) : undefined;
    return series ? panel.axes[series.source.axis] ?? null : null;
  }, [levels, panel]);
  const projectedLevels = useMemo(
    () => levels && levelDomain ? projectLevels(levels.items, levelDomain, levelDraft) : NO_LEVELS,
    [levelDomain, levelDraft, levels],
  );
  const bitmapLayers = useMemo(() => {
    if (!bitmap) return null;
    // The desktop composites overlays as vectors, so the plot raster stays put
    // while a tool drags. Copying and reblending it per frame is what made the
    // ruler feel heavy.
    if (isDesktopWeb) return [bitmap];
    const base = !activeDrag && panelDrawings.length === 0 ? bitmap : drawChartToolOverlay(
      bitmap,
      activeDrag,
      {
        positive: themeColors.positive,
        negative: colors.negative,
        zoom: colors.crosshair,
        draw: drawColor,
      },
      toolReadout?.direction ?? "up",
      { scene, panel, items: panelDrawings, selectedId: selectedDrawingId },
    );
    return [projectedLevels.length > 0 ? paintLevels(base, projectedLevels, selectedLevelId) : base];
  }, [
    activeDrag,
    bitmap,
    colors.crosshair,
    colors.negative,
    drawColor,
    isDesktopWeb,
    panel,
    panelDrawings,
    projectedLevels,
    scene,
    selectedDrawingId,
    selectedLevelId,
    toolReadout?.direction,
  ]);
  const vectors = useMemo<ChartSurfaceProps["vectors"]>(() => {
    if (!isDesktopWeb) return null;
    const shapes = [...levelVectors(projectedLevels, selectedLevelId), ...buildChartToolVectors({
      scene,
      panel,
      drawings: panelDrawings,
      selectedId: selectedDrawingId,
      drag: activeDrag,
      colors: {
        positive: themeColors.positive,
        negative: colors.negative,
        zoom: colors.crosshair,
        draw: drawColor,
      },
      direction: toolReadout?.direction ?? "up",
    })];
    return shapes.length > 0 ? shapes : null;
  }, [
    activeDrag,
    colors.crosshair,
    colors.negative,
    drawColor,
    isDesktopWeb,
    panel,
    panelDrawings,
    projectedLevels,
    scene,
    selectedDrawingId,
    selectedLevelId,
    toolReadout?.direction,
  ]);
  const textLines = useMemo(
    () => isDesktopWeb || !showTextFallback
      ? []
      : writeLevelText(
        renderCompositePanelText(panel, plotWidth, scene.cursorXRatio, pointerCursorYRatio),
        projectedLevels,
        selectedLevelId,
      ),
    [isDesktopWeb, panel, plotWidth, pointerCursorYRatio, projectedLevels, scene.cursorXRatio, selectedLevelId, showTextFallback],
  );
  const leftAxisLabels = useMemo(
    () => axisLabelRows(
      renderCompositeAxisText(panel.axes.left, panel.height, leftAxisWidth, "left", formatAxisValue),
    ),
    [formatAxisValue, leftAxisWidth, panel],
  );
  const rightAxisLabels = useMemo(
    () => axisLabelRows(
      renderCompositeAxisText(panel.axes.right, panel.height, rightAxisWidth, "right", formatAxisValue),
    ),
    [formatAxisValue, panel, rightAxisWidth],
  );
  const leftAxisTicks = useMemo(
    () => compositeAxisTickLabels(panel.axes.left, leftAxisWidth, formatAxisValue),
    [formatAxisValue, leftAxisWidth, panel],
  );
  const rightAxisTicks = useMemo(
    () => compositeAxisTickLabels(panel.axes.right, rightAxisWidth, formatAxisValue),
    [formatAxisValue, panel, rightAxisWidth],
  );
  const cursorRow = activeCursorYRatio === null
    ? null
    : Math.round(activeCursorYRatio * Math.max(panel.height - 1, 0));
  const cursorPixelY = activeCursorYRatio === null
    ? null
    : activeCursorYRatio * Math.max(panel.height * cellHeightPx - 1, 0);
  const leftCursorLabel = cursorAxisLabel(panel, "left", activeCursorYRatio, formatAxisValue);
  const rightCursorLabel = cursorAxisLabel(panel, "right", activeCursorYRatio, formatAxisValue);
  const measureReadout = useMemo(() => {
    if (!activeDrag || !toolReadout?.summary) return null;
    const text = toolReadout.summary;
    const centreX = (activeDrag.startXRatio + activeDrag.endXRatio) / 2;
    const centreY = activeDrag.kind === "zoom"
      ? 0.5
      : (activeDrag.startYRatio + activeDrag.endYRatio) / 2;
    const width = Math.min([...text].length, plotWidth);
    return {
      text,
      width,
      color: activeDrag.kind === "zoom"
        ? colors.text
        : toolReadout.direction === "down" ? colors.negative : themeColors.positive,
      left: leftAxisWidth + (leftAxisWidth ? axisGap : 0)
        + Math.max(0, Math.min(plotWidth - width, Math.round(centreX * plotWidth - width / 2))),
      top: Math.max(0, Math.min(panel.height - 1, Math.round(centreY * (panel.height - 1)))),
    };
  }, [
    activeDrag,
    axisGap,
    colors.negative,
    colors.text,
    leftAxisWidth,
    panel.height,
    plotWidth,
    toolReadout,
  ]);
  const axisMarkers = useMemo(() => {
    // The crosshair already marks the moving end, so the axes only need the
    // anchor the drag started from.
    if (!activeDrag || activeDrag.kind === "zoom" || !toolReadout?.startValueLabel) return null;
    return {
      side: null,
      // A keyboard anchor can leave the value range once the view moves.
      yRatio: Math.max(0, Math.min(1, activeDrag.startYRatio)),
      label: toolReadout.startValueLabel,
      color: toolReadout.direction === "down" ? colors.negative : themeColors.positive,
    };
  }, [activeDrag, colors.negative, toolReadout]);
  const lastPriceMarker = useMemo(() => {
    const marker = panel.lastPrice;
    const domain = marker ? panel.axes[marker.axis] : undefined;
    if (!marker || !domain) return null;
    return {
      side: marker.axis,
      yRatio: marker.yRatio,
      label: formatAxisValue
        ? formatAxisValue(marker.value, domain)
        : formatCompositeCursorValue(marker.value, domain),
      color: marker.color,
    };
  }, [formatAxisValue, panel]);
  const priorCloseMarker = useMemo(() => {
    const marker = panel.priorClose;
    const domain = marker ? panel.axes[marker.axis] : undefined;
    if (!marker || !domain) return null;
    return {
      side: marker.axis,
      yRatio: marker.yRatio,
      label: formatAxisValue ? formatAxisValue(marker.value, domain) : formatCompositeCursorValue(marker.value, domain),
      color: colors.textDim,
    };
  }, [colors.textDim, formatAxisValue, panel]);
  const levelMarkers = useMemo(() => levelDomain ? [...projectedLevels]
    // The picked level's label first, then alerts', when they compete for room.
    .sort((left, right) => Number(right.level.id === selectedLevelId) - Number(left.level.id === selectedLevelId)
      || Number(left.level.editable) - Number(right.level.editable))
    .map(({ level, yRatio }) => ({
      side: levelDomain.side,
      yRatio,
      label: formatAxisValue ? formatAxisValue(level.value, levelDomain) : formatCompositeCursorValue(level.value, levelDomain),
      color: level.color,
    })) : [], [formatAxisValue, levelDomain, projectedLevels, selectedLevelId]);
  const buildAxisMarkers = (side: "left" | "right") => {
    if (!panel.axes[side]) return undefined;
    const toAxisMarker = (marker: { yRatio: number; label: string; color: string }) => ({
      row: Math.round(marker.yRatio * Math.max(panel.height - 1, 0)),
      pixelY: marker.yRatio * Math.max(panel.height * cellHeightPx - 1, 0),
      label: marker.label,
      color: marker.color,
    });
    const onSide = <T extends { side: string | null }>(marker: T | null): marker is T => (
      !!marker && (marker.side === null || marker.side === side)
    );
    const fixed = [lastPriceMarker, axisMarkers].filter(onSide).map(toAxisMarker);
    // The prior close's label yields to every level's.
    const levelLabels = [...levelMarkers, priorCloseMarker].filter(onSide).map(toAxisMarker);
    // A label is a row tall, so close levels would stack into an unreadable
    // pile and hide the last price: each keeps its line, and only the labels
    // with a row to themselves show. Desktop badges sit between rows.
    const markers = [
      ...fitAxisLabels(levelLabels, fixed, (marker) => fractionalViewport ? marker.pixelY / cellHeightPx : marker.row),
      ...fixed,
    ];
    return markers.length > 0 ? markers : undefined;
  };
  const leftAxisMarkers = buildAxisMarkers("left");
  const rightAxisMarkers = buildAxisMarkers("right");

  const pointerRatios = useCallback((event: ChartMouseEvent) => {
    const pointerTarget = plotRef.current as unknown as Parameters<typeof getLocalPlotPointer>[1];
    const pointer = getLocalPlotPointer(event, pointerTarget, renderer);
    if (!pointer) return null;
    return {
      xRatio: plotWidth <= 1 ? 0 : Math.max(0, Math.min(1, pointer.cellX / (plotWidth - 1))),
      yRatio: panel.height <= 1 ? 0.5 : Math.max(0, Math.min(1, pointer.cellY / (panel.height - 1))),
    };
  }, [panel.height, plotWidth, renderer]);
  const updateCursor = useCallback((event: ChartMouseEvent): boolean => {
    const pointerTarget = plotRef.current as unknown as Parameters<typeof getLocalPlotPointer>[1];
    const pointer = getLocalPlotPointer(event, pointerTarget, renderer);
    if (!pointer) return false;
    const nextDate = resolveCompositeCursorDate(scene, pointer.cellX);
    if (!nextDate) return false;
    const nextYRatio = panel.height <= 1
      ? 0.5
      : Math.max(0, Math.min(1, pointer.cellY / (panel.height - 1)));
    setCursorYRatio((current) => current === nextYRatio ? current : nextYRatio);
    onCursorDateChange(nextDate);
    consumeChartMouseEvent(event);
    return true;
  }, [onCursorDateChange, panel.height, renderer, scene]);
  const clearCursor = useCallback(() => {
    setCursorYRatio(null);
    onCursorDateChange(null);
  }, [onCursorDateChange]);
  const startDrag = useCallback((event: ChartMouseEvent) => {
    onActivate?.();
    onPointerPress();
    // The plot consumes the press, so the browser never moves focus off a text
    // field for us. Hand it back, but only for a press that truly landed here:
    // a dialog over the plot must keep the focus it just took.
    if (isDesktopWeb) releaseEditableFocus(event);
    consumeChartMouseEvent(event);
    if (onPickTime) {
      const pointer = getLocalPlotPointer(event, plotRef.current as unknown as Parameters<typeof getLocalPlotPointer>[1], renderer);
      const date = pointer ? resolveCompositeCursorDate(scene, pointer.cellX) : null;
      if (date) onPickTime(date);
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
    if (!updateCursor(event)) return;
    dragRef.current = startPanGesture(
      frame,
      viewport,
      plotWidth,
      getGlobalMouseX(event, renderer),
      plotSpanFactor,
    );
  }, [
    armedTool,
    drawings,
    frame,
    levelDomain,
    levels,
    onActivate,
    onPickTime,
    onPointerPress,
    onSelectDrawing,
    onSelectLevel,
    panel,
    plotAspect,
    projectedLevels,
    plotSpanFactor,
    plotWidth,
    pointerRatios,
    renderer,
    scene,
    updateCursor,
    viewport,
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
      if (value !== null && levelDomain) setLevelDraft({ id: drag.id, value: roundLevelValue(value, levelDomain) });
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
    if (drag.frame !== frame) {
      // Data refreshed mid-drag. The new frame maps positions differently, so
      // continue from where the plot is now instead of replaying the drag.
      Object.assign(drag, startPanGesture(frame, viewport, plotWidth, globalX, plotSpanFactor));
    }
    onPanViewport(
      (globalX - drag.startGlobalX) * drag.positionsPerCell,
      { frame: drag.frame, from: drag.startViewport },
    );
  }, [
    frame,
    levelDomain,
    onEditDrawing,
    onPanViewport,
    panel,
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
    if (dragRef.current?.kind === "pan") {
      dragRef.current = null;
      return;
    }
    finishToolDrag();
  }, [finishToolDrag]);
  const handleMouseMove = useCallback((event: ChartMouseEvent) => {
    // A release over a neighbouring pane never reaches this surface, so treat a
    // plain move, which only fires with no button held, as the missing release.
    finishToolDrag();
    updateCursor(event);
  }, [finishToolDrag, updateCursor]);
  // Trackpads fire wheel events faster than the plot can paint, so one frame
  // absorbs every event that arrived since the last one.
  const pendingWheelRef = useRef<PendingWheel | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const latestWheelStateRef = useRef({ frame, viewport, onPanViewport, onZoomViewport, plotSpanFactor });
  latestWheelStateRef.current = { frame, viewport, onPanViewport, onZoomViewport, plotSpanFactor };
  const flushWheel = useCallback(() => {
    wheelFrameRef.current = null;
    const pending = pendingWheelRef.current;
    pendingWheelRef.current = null;
    if (!pending) return;
    const latest = latestWheelStateRef.current;
    if (pending.panRatio !== 0) {
      const positions = compositeViewportPositions(latest.frame, latest.viewport);
      const span = positions ? Math.max(positions.end - positions.start, Number.EPSILON) : 0;
      latest.onPanViewport(pending.panRatio * span * latest.plotSpanFactor);
    }
    if (pending.zoomLog !== 0) {
      latest.onZoomViewport(Math.exp(pending.zoomLog), pending.anchorRatio);
    }
  }, []);
  useEffect(() => () => {
    pendingWheelRef.current = null;
    if (wheelFrameRef.current !== null) {
      webFrame.cancelAnimationFrame?.(wheelFrameRef.current);
      wheelFrameRef.current = null;
    }
  }, []);
  const panFromWheel = useCallback((event: ChartMouseEvent) => {
    const scroll = event.scroll;
    if (!scroll) return;
    onActivate?.();
    consumeChartMouseEvent(event);
    const pointerTarget = plotRef.current as unknown as Parameters<typeof getLocalPlotPointer>[1];
    const pointer = getLocalPlotPointer(event, pointerTarget, renderer);
    updateCursor(event);
    const pending = pendingWheelRef.current ?? { panRatio: 0, zoomLog: 0, anchorRatio: 0.5 };
    if (event.modifiers.ctrl && pointer && isVerticalWheelDirection(scroll.direction)) {
      pending.zoomLog += Math.log(resolveCompositeWheelZoom(scroll));
      // The anchor is a fraction of the viewport, so a pointer over the empty
      // right offset anchors on the newest observation instead of past it.
      pending.anchorRatio = Math.min(
        1,
        pointer.cellX / Math.max(plotWidth - 1, 1) * plotSpanFactor,
      );
    } else {
      pending.panRatio += resolveCompositeWheelPan(scroll, plotWidth * cellWidthPx);
    }
    pendingWheelRef.current = pending;
    if (!isDesktopWeb || typeof webFrame.requestAnimationFrame !== "function") {
      flushWheel();
      return;
    }
    if (wheelFrameRef.current === null) {
      wheelFrameRef.current = webFrame.requestAnimationFrame(flushWheel);
    }
  }, [
    cellWidthPx,
    flushWheel,
    isDesktopWeb,
    onActivate,
    plotSpanFactor,
    plotWidth,
    renderer,
    updateCursor,
  ]);

  return (
    <Box
      flexDirection="row"
      height={panel.height}
      width={plotWidth + leftAxisWidth + rightAxisWidth + axisGap * ((leftAxisWidth ? 1 : 0) + (rightAxisWidth ? 1 : 0))}
      position="relative"
    >
      {measureReadout ? (
        <Box
          position="absolute"
          left={measureReadout.left}
          top={measureReadout.top}
          width={measureReadout.width}
          height={1}
          zIndex={25}
          backgroundColor={colors.background}
          style={isDesktopWeb
            ? {
              width: "auto",
              paddingInline: 4,
              borderRadius: 4,
              backgroundColor: `color-mix(in srgb, ${colors.background} 82%, transparent)`,
            }
            : undefined}
          data-gloom-role="composite-chart-measure"
        >
          <Text fg={measureReadout.color}>{measureReadout.text}</Text>
        </Box>
      ) : null}
      {leftAxisWidth > 0 ? (
        <>
          <PriceAxisLabels
            axisLabels={leftAxisLabels}
            axisTicks={leftAxisTicks}
            axisWidth={leftAxisWidth}
            axisSectionWidth={leftAxisWidth}
            side="left"
            height={panel.height}
            cursorRow={cursorRow}
            cursorPixelY={cursorPixelY}
            cursorLabel={leftCursorLabel}
            cursorColor={colors.crosshair}
            cursorBackgroundColor={colors.background}
            axisColor={colors.textDim}
            extraMarkers={leftAxisMarkers}
          />
          <Box width={axisGap} />
        </>
      ) : null}
      <ChartSurface
        ref={plotRef}
        width={plotWidth}
        height={panel.height}
        flexDirection="column"
        bitmaps={bitmapLayers}
        crosshair={crosshair}
        vectors={vectors}
        onMouseMove={interactive ? handleMouseMove : undefined}
        onMouseDown={interactive ? navigable ? startDrag : pressCursor : undefined}
        onMouseDrag={interactive && navigable ? dragViewport : undefined}
        onMouseUp={interactive && navigable ? resetDrag : undefined}
        onMouseDragEnd={interactive && navigable ? resetDrag : undefined}
        onMouseScroll={interactive && navigable ? panFromWheel : undefined}
        onMouseOut={interactive ? clearCursor : undefined}
        cursor={interactive ? toolDrag || !navigable || onPickTime ? "crosshair" : "grab" : undefined}
        data-gloom-interactive={interactive ? "true" : undefined}
        data-gloom-role={COMPOSITE_PANEL_ROLE}
        data-gloom-remote-kind={remoteKind}
        data-gloom-label={panel.label ?? panel.id}
      >
        {textLines.map((line, index) => <Text key={index} fg={colors.text}>{line}</Text>)}
      </ChartSurface>
      {rightAxisWidth > 0 ? (
        <>
          <Box width={axisGap} />
          <PriceAxisLabels
            axisLabels={rightAxisLabels}
            axisTicks={rightAxisTicks}
            axisWidth={rightAxisWidth}
            axisSectionWidth={rightAxisWidth}
            side="right"
            height={panel.height}
            cursorRow={cursorRow}
            cursorPixelY={cursorPixelY}
            cursorLabel={rightCursorLabel}
            cursorColor={colors.crosshair}
            cursorBackgroundColor={colors.background}
            axisColor={colors.textDim}
            extraMarkers={rightAxisMarkers}
          />
        </>
      ) : null}
    </Box>
  );
}

