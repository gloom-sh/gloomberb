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
import { Button } from "../../ui/button";
import { clamp } from "../../../utils/math";
import { panValueRange, resolveAxisDragSpanFactor, zoomValueRange, type CompositeValueRange } from "./value-scale";
import { useStaticChartBitmapSize } from "./bitmap";
import { useMeasuredCells } from "../../../ui/measured-cells";
import { PriceAxisLabels, placeAxisTicks } from "./price-axis-labels";
import { layoutLevelLabels, levelLabelStyle, levelLabelText } from "./level-labels";
import { formatCompositeCursorValue, type CompositeAxisValueFormatter } from "./format";
import {
  compositeViewportPositions,
  resolveCompositeWheelPan,
  resolveCompositeWheelZoom,
  type CompositeNavigationFrame,
  type CompositeViewportRange,
} from "./interactions";
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
  type ChartToolSpan,
} from "./tools";
import { compositeRightOffsetRatio, unprojectCompositeTimestamp } from "./time-scale";
import { resolveCompositeCursorDate, unprojectCompositeValue } from "./scene";
import { compositeAxisTickLabels, renderCompositeAxisText, renderCompositePanelText } from "./text-renderer";
import type { CompositeAxisSide, CompositeChartColors, CompositeChartScene, CompositePanelScene } from "./types";
import { useCompositePanelBitmap } from "./panel-bitmap";
import { nextDrawingId, nextLevelId } from "./drawing-store";
import {
  AXIS_DOUBLE_PRESS_MS,
  PLOT_DOUBLE_CLICK_MS,
  COMPOSITE_PANEL_ROLE,
  isVerticalWheelDirection,
  manualValueAxes,
  startPanGesture,
  releaseEditableFocus,
  type PanGesture,
  type PendingAxisWheel,
  type PendingWheel,
  type ValueAxisStart,
} from "./panel-gestures";
import { resolvePanelCrosshair, axisLabelRows, cursorAxisLabel, resolveSeriesCursorYRatio, resolveSeriesAxisTags } from "./panel-labels";
import type { KeyboardToolDrag } from "./use-composite-chart-keyboard";

const webFrame = globalThis as typeof globalThis & {
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

const NO_LEVELS: readonly ProjectedLevel[] = [];

/** The pointer's height in rows, to a fraction of one where the host reports it. */
function pointerRow(event: ChartMouseEvent): number {
  return typeof event.preciseY === "number" ? event.preciseY : event.y;
}

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
  /** The cursor shown is another chart's, so the pointer's level is not part of it. */
  sharedCursor: boolean;
  /** Positive positions move toward older observations. A gesture supplies the frame and origin it started from. */
  onPanViewport: (
    deltaPositions: number,
    gesture?: { frame: CompositeNavigationFrame; from: CompositeViewportRange },
  ) => void;
  onZoomViewport: (zoomFactor: number, anchorRatio: number) => void;
  onSetViewport: (range: CompositeViewportRange) => void;
  onToolSpanChange: (span: ChartToolSpan | null) => void;
  /** A press on the plot started (true) or stopped (false) dragging: a pan, a tool, a drawing or a level. */
  onDragActiveChange?: (dragging: boolean) => void;
  /** The tool being placed from the keyboard, when it lives in this panel. */
  keyboardToolDrag: KeyboardToolDrag | null;
  /** A press on the plot: the pointer takes over from a keyboard placement. */
  onPointerPress: () => void;
  showTextFallback: boolean;
  /** Set while the owner is picking a bar: a press picks instead of panning. */
  onPickTime?: (date: Date) => void;
  /** Set while the owner is picking a price on the levels' series: a press picks the one under it. */
  onPickPrice?: (value: number) => void;
  /** The chart's levels when they draw on this panel. */
  levels: CompositeChartLevels | null;
  selectedLevelId: string | null;
  onSelectLevel: (id: string | null) => void;
  /** The value axes stretch and squeeze under a drag or the wheel, and a double click fits them again. */
  valueScalable: boolean;
  onSetValueScale: (panelId: string, side: CompositeAxisSide, key: string, range: CompositeValueRange) => void;
  onResetValueScale: (panelId: string) => void;
  /** The line above this panel, which a drag moves (desktop and web): null for the top panel. */
  dividerAbove?: { active: boolean; gestures: PanelDividerGestures } | null;
  /** A double click on bare plot gives this panel the whole chart, or gives the others back. */
  onToggleMaximized?: () => void;
}

interface PanelDividerGestures {
  onMouseDown: (event: ChartMouseEvent) => void;
  onMouseDrag: (event: ChartMouseEvent) => void;
  onMouseUp: (event: ChartMouseEvent) => void;
  onMouseDragEnd: (event: ChartMouseEvent) => void;
}

const DESKTOP_PLOT_STYLE = { flex: "1 1 0px", width: "auto", minWidth: 0, height: "auto", alignSelf: "stretch" } as const;
/** Over a level that drags, or while one does: it moves up and down only. */
const DESKTOP_PLOT_LEVEL_STYLE = { ...DESKTOP_PLOT_STYLE, cursor: "ns-resize" } as const;
const DESKTOP_PLOT_PICK_STYLE = { ...DESKTOP_PLOT_STYLE, cursor: "crosshair" } as const;
/** The grab strip over the line between two panels: the line and a few pixels either side of it. */
const PANEL_DIVIDER_STYLE = {
  left: 0,
  right: 0,
  width: "auto",
  top: "calc(-1 * var(--gloom-space-xs))",
  height: "calc(2 * var(--gloom-space-xs) + 1px)",
} as const;

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
  sharedCursor,
  onPanViewport,
  onZoomViewport,
  onSetViewport,
  onToolSpanChange,
  onDragActiveChange,
  keyboardToolDrag,
  onPointerPress,
  showTextFallback,
  onPickTime,
  onPickPrice,
  levels,
  selectedLevelId,
  onSelectLevel,
  valueScalable,
  onSetValueScale,
  onResetValueScale,
  dividerAbove = null,
  onToggleMaximized,
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
  const heldCursorYRatio = keyboardDrag ? keyboardDrag.drag.endYRatio : sharedCursor ? null : cursorYRatio;
  const seriesCursorYRatio = useMemo(
    () => resolveSeriesCursorYRatio(panel, scene),
    [panel, scene],
  );
  const activeCursorYRatio = scene.cursorXRatio === null
    ? null
    : heldCursorYRatio ?? seriesCursorYRatio;
  // The last press on bare plot, for a double press where the host does not count clicks.
  const lastPlotPressRef = useRef<{ at: number; x: number; y: number } | null>(null);
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
  // The plot's box as the browser lays it out: on the desktop a chart that
  // fills its box has it a fraction of a cell past its columns and rows. The
  // bitmap is drawn at that size, so it is 1:1 at rest, and the pointer is
  // read back into the scene's columns and rows. Elsewhere, and in the
  // terminal, it is the plot's cells.
  const plotSize = useMeasuredCells(plotRef, { width: plotWidth, height: panel.height });
  const plotAspect = (plotSize.width * cellWidthPx) / Math.max(plotSize.height * cellHeightPx, 1);
  // The plot is wider than the viewport by the reserved right offset. Gestures
  // read the pointer in plot space, so they convert through this.
  const plotSpanFactor = 1 + compositeRightOffsetRatio(scene.timeScale);
  const bitmapSize = useStaticChartBitmapSize(plotSize.width, plotSize.height);
  const bitmap = useCompositePanelBitmap({ panel, bitmapSize, colors, isDesktopWeb, revealed: plotSize.revealed === true });
  // The chart under the pointer draws both lines: the level line follows the
  // pointer, and its value sits on the axes, beside each series' own tag on
  // the desktop and the web. A keyboard or shared cursor knows its column
  // only, so a chart following another chart's cursor draws the time line
  // alone. A tool placed from the keyboard is the exception: its end is a level.
  const pointerCursorYRatio = scene.cursorXRatio === null ? null : heldCursorYRatio;
  const crosshair = useMemo(
    () => resolvePanelCrosshair(panel, bitmap, scene, pointerCursorYRatio, colors.crosshair),
    [bitmap, colors.crosshair, panel, pointerCursorYRatio, scene],
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
  // Over a line a plain drag moves, and while one moves, the pointer says it goes up and down.
  const levelGrab = useMemo(() => {
    if (levelDraft) return true;
    if (!levels?.onEdit || cursorYRatio === null || onPickTime || onPickPrice || (armedTool && armedTool !== "level")) return false;
    const hit = hitTestLevel(projectedLevels, cursorYRatio, levelGrabRatio(panel.height));
    return !!hit?.editable && !!hit.draggable;
  }, [armedTool, cursorYRatio, levelDraft, levels?.onEdit, onPickPrice, onPickTime, panel.height, projectedLevels]);
  // Drawings project through the time scale alone: the crosshair moving,
  // here or on a linked chart, must not repaint the plot, which the terminal's
  // kitty surface would upload whole again.
  const drawingProjection = useMemo(() => ({ timeScale: scene.timeScale }), [scene.timeScale]);
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
      { scene: drawingProjection, panel, items: panelDrawings, selectedId: selectedDrawingId },
    );
    return [projectedLevels.length > 0 ? paintLevels(base, projectedLevels, selectedLevelId) : base];
  }, [
    activeDrag,
    bitmap,
    colors.crosshair,
    colors.negative,
    drawColor,
    drawingProjection,
    isDesktopWeb,
    panel,
    panelDrawings,
    projectedLevels,
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
  // The pointer's value on the axes follows the level line it belongs to.
  const axisCursorYRatio = isDesktopWeb ? pointerCursorYRatio : activeCursorYRatio;
  const leftCursorLabel = cursorAxisLabel(panel, "left", axisCursorYRatio, formatAxisValue);
  const rightCursorLabel = cursorAxisLabel(panel, "right", axisCursorYRatio, formatAxisValue);
  const seriesAxisTags = useMemo(() => isDesktopWeb ? resolveSeriesAxisTags(panel, scene, formatAxisValue) : [], [formatAxisValue, isDesktopWeb, panel, scene]);
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
      id: level.id,
      side: levelDomain.side,
      yRatio,
      label: level.axisLabel ?? (formatAxisValue ? formatAxisValue(level.value, levelDomain) : formatCompositeCursorValue(level.value, levelDomain)),
      color: level.color,
    })) : [], [formatAxisValue, levelDomain, projectedLevels, selectedLevelId]);
  const buildAxisMarkers = (side: "left" | "right") => {
    if (!panel.axes[side]) return undefined;
    const toAxisMarker = (marker: { id?: string; yRatio: number; label: string; color: string }) => ({
      id: marker.id,
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
    const grid = fractionalViewport
      ? placeAxisTicks({ ticks: side === "left" ? leftAxisTicks : rightAxisTicks, height: panel.height, cellHeightPx }).map((tick) => ({
        ...toAxisMarker({ yRatio: tick.ratio, label: tick.label, color: colors.textDim }),
        pixelY: tick.topPercent / 100 * Math.max(panel.height * cellHeightPx - 1, 1),
      }))
      : [...(side === "left" ? leftAxisLabels : rightAxisLabels)].map(([row, label]) => ({ id: undefined, row, pixelY: row * cellHeightPx, label, color: colors.textDim }));
    const markers = [
      ...fitAxisLabels(levelLabels, [...fixed, ...grid], (marker) => fractionalViewport ? marker.pixelY / cellHeightPx : marker.row),
      ...fixed,
    ];
    return markers.length > 0 ? markers : undefined;
  };
  const leftAxisMarkers = buildAxisMarkers("left");
  const rightAxisMarkers = buildAxisMarkers("right");

  /** Where the pointer is over the plot, in the scene's columns and rows. */
  const plotPointer = useCallback((event: ChartMouseEvent) => {
    const pointer = getLocalPlotPointer(event, plotRef.current as unknown as Parameters<typeof getLocalPlotPointer>[1], renderer);
    if (!pointer || (plotSize.width === plotWidth && plotSize.height === panel.height)) return pointer;
    return {
      ...pointer,
      cellX: plotSize.width > 0 ? pointer.cellX * (plotWidth / plotSize.width) : pointer.cellX,
      cellY: plotSize.height > 0 ? pointer.cellY * (panel.height / plotSize.height) : pointer.cellY,
    };
  }, [panel.height, plotSize.height, plotSize.width, plotWidth, renderer]);
  const pointerRatios = useCallback((event: ChartMouseEvent) => {
    const pointer = plotPointer(event);
    if (!pointer) return null;
    return {
      xRatio: plotWidth <= 1 ? 0 : Math.max(0, Math.min(1, pointer.cellX / (plotWidth - 1))),
      yRatio: panel.height <= 1 ? 0.5 : Math.max(0, Math.min(1, pointer.cellY / (panel.height - 1))),
    };
  }, [panel.height, plotPointer, plotWidth]);
  const updateCursor = useCallback((event: ChartMouseEvent): boolean => {
    const pointer = plotPointer(event);
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
  }, [onCursorDateChange, panel.height, plotPointer, scene]);
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
    if (dragRef.current?.kind === "pan") {
      dragRef.current = null;
      return;
    }
    finishToolDrag();
  }, [finishToolDrag]);
  // Said once per change, so a pointer move costs the chart nothing.
  const reportedDragRef = useRef(false);
  const reportDrag = useCallback((dragging: boolean) => {
    if (reportedDragRef.current === dragging) return;
    reportedDragRef.current = dragging;
    onDragActiveChange?.(dragging);
  }, [onDragActiveChange]);
  const pressPlot = useCallback((event: ChartMouseEvent) => {
    const before = dragRef.current;
    startDrag(event);
    if (dragRef.current !== null && dragRef.current !== before) reportDrag(true);
  }, [reportDrag, startDrag]);
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
    const pointer = plotPointer(event);
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
      pending.panRatio += resolveCompositeWheelPan(scroll, plotSize.width * cellWidthPx);
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
    plotPointer,
    plotSize.width,
    plotSpanFactor,
    plotWidth,
    updateCursor,
  ]);

  // A value axis under the pointer: a drag stretches (up) or squeezes (down)
  // it around its middle, the wheel around the pointer, and a double click
  // fits it to the data again. Read through refs, so the handlers stay put.
  const axisGestureRef = useRef<(ValueAxisStart & { startRow: number; moved: boolean }) | null>(null);
  const lastAxisPressRef = useRef<{ side: CompositeAxisSide; at: number } | null>(null);
  const latestAxesRef = useRef({ panel, onSetValueScale, onResetValueScale, onActivate });
  latestAxesRef.current = { panel, onSetValueScale, onResetValueScale, onActivate };
  /** The pointer's height down the panel, 0 at the top and 1 at the bottom. */
  const axisPointerRatio = useCallback((event: ChartMouseEvent): number => {
    const plot = plotRef.current as unknown as { absoluteY?: number; y?: number; height?: number } | null;
    const top = plot?.absoluteY ?? plot?.y;
    const height = plot?.height ?? 0;
    if (top === undefined || height <= 1) return 0.5;
    return clamp((pointerRow(event) - top) / (fractionalViewport ? height : height - 1), 0, 1);
  }, [fractionalViewport]);
  const pressAxis = useCallback((side: CompositeAxisSide, event: ChartMouseEvent) => {
    const latest = latestAxesRef.current;
    const domain = latest.panel.axes[side];
    if (!domain?.scaleKey) return;
    latest.onActivate?.();
    consumeChartMouseEvent(event);
    // The desktop counts clicks; the terminal has two presses close together.
    const now = Date.now();
    const last = lastAxisPressRef.current;
    const double = typeof event.detail === "number"
      ? event.detail >= 2
      : !!last && last.side === side && now - last.at < AXIS_DOUBLE_PRESS_MS;
    if (double) {
      lastAxisPressRef.current = null;
      axisGestureRef.current = null;
      latest.onResetValueScale(latest.panel.id);
      return;
    }
    lastAxisPressRef.current = { side, at: now };
    axisGestureRef.current = {
      side,
      key: domain.scaleKey,
      scale: domain.scale,
      start: { min: domain.min, max: domain.max },
      startRow: pointerRow(event),
      moved: false,
    };
  }, []);
  const dragAxis = useCallback((event: ChartMouseEvent) => {
    const gesture = axisGestureRef.current;
    if (!gesture) return;
    consumeChartMouseEvent(event);
    const deltaPx = (pointerRow(event) - gesture.startRow) * cellHeightPx;
    if (!gesture.moved && Math.abs(deltaPx) < 1) return;
    // A drag is not the first half of a double click.
    gesture.moved = true;
    lastAxisPressRef.current = null;
    const latest = latestAxesRef.current;
    latest.onSetValueScale(
      latest.panel.id,
      gesture.side,
      gesture.key,
      zoomValueRange(gesture.start, gesture.scale, resolveAxisDragSpanFactor(deltaPx), 0.5),
    );
  }, [cellHeightPx]);
  const releaseAxis = useCallback(() => {
    axisGestureRef.current = null;
  }, []);
  const pendingAxisWheelRef = useRef<PendingAxisWheel | null>(null);
  const axisWheelFrameRef = useRef<number | null>(null);
  const flushAxisWheel = useCallback(() => {
    axisWheelFrameRef.current = null;
    const pending = pendingAxisWheelRef.current;
    pendingAxisWheelRef.current = null;
    const latest = latestAxesRef.current;
    const domain = pending ? latest.panel.axes[pending.side] : undefined;
    if (!pending || !domain?.scaleKey || pending.spanLog === 0) return;
    latest.onSetValueScale(
      latest.panel.id,
      pending.side,
      domain.scaleKey,
      zoomValueRange({ min: domain.min, max: domain.max }, domain.scale, Math.exp(pending.spanLog), pending.anchorRatio),
    );
  }, []);
  useEffect(() => () => {
    pendingAxisWheelRef.current = null;
    if (axisWheelFrameRef.current !== null) {
      webFrame.cancelAnimationFrame?.(axisWheelFrameRef.current);
      axisWheelFrameRef.current = null;
    }
  }, []);
  const wheelAxis = useCallback((side: CompositeAxisSide, event: ChartMouseEvent) => {
    const scroll = event.scroll;
    if (!scroll || !latestAxesRef.current.panel.axes[side]?.scaleKey) return;
    latestAxesRef.current.onActivate?.();
    consumeChartMouseEvent(event);
    if (!isVerticalWheelDirection(scroll.direction)) return;
    const pending = pendingAxisWheelRef.current?.side === side
      ? pendingAxisWheelRef.current
      : { side, spanLog: 0, anchorRatio: 0.5 };
    // Up stretches, as Ctrl and the wheel zoom the plot in.
    pending.spanLog -= Math.log(resolveCompositeWheelZoom(scroll));
    pending.anchorRatio = axisPointerRatio(event);
    pendingAxisWheelRef.current = pending;
    if (!isDesktopWeb || typeof webFrame.requestAnimationFrame !== "function") {
      flushAxisWheel();
      return;
    }
    if (axisWheelFrameRef.current === null) {
      axisWheelFrameRef.current = webFrame.requestAnimationFrame(flushAxisWheel);
    }
  }, [axisPointerRatio, flushAxisWheel, isDesktopWeb]);
  const leftAxisGestures = useMemo(() => valueScalable ? {
    onMouseDown: (event: ChartMouseEvent) => pressAxis("left", event),
    onMouseDrag: dragAxis,
    onMouseUp: releaseAxis,
    onMouseDragEnd: releaseAxis,
    onMouseScroll: (event: ChartMouseEvent) => wheelAxis("left", event),
  } : undefined, [dragAxis, pressAxis, releaseAxis, valueScalable, wheelAxis]);
  const rightAxisGestures = useMemo(() => valueScalable ? {
    onMouseDown: (event: ChartMouseEvent) => pressAxis("right", event),
    onMouseDrag: dragAxis,
    onMouseUp: releaseAxis,
    onMouseDragEnd: releaseAxis,
    onMouseScroll: (event: ChartMouseEvent) => wheelAxis("right", event),
  } : undefined, [dragAxis, pressAxis, releaseAxis, valueScalable, wheelAxis]);
  // While the panel is scaled by hand, the foot of the axis scaled says so
  // and is the way back.
  const manuallyScaled = !!panel.axes.left?.manual || !!panel.axes.right?.manual;
  const manualSide: CompositeAxisSide | null = !valueScalable || !manuallyScaled ? null
    : panel.axes.right?.manual && rightAxisWidth > 0 ? "right"
      : panel.axes.left?.manual && leftAxisWidth > 0 ? "left"
        : rightAxisWidth > 0 ? "right" : leftAxisWidth > 0 ? "left" : null;
  const manualLabel = (manualSide === "left" ? leftAxisWidth : rightAxisWidth) >= 4 ? "Auto" : "A";

  return (
    <Box
      flexDirection="row"
      height={panel.height}
      width={plotWidth + leftAxisWidth + rightAxisWidth + axisGap * ((leftAxisWidth ? 1 : 0) + (rightAxisWidth ? 1 : 0))}
      position="relative"
      // Desktop: spans the chart's box and takes its share of the height, so
      // when a resize draws the box at a new size between renders the plot
      // follows it by CSS. At rest, the size the cells give it.
      style={isDesktopWeb ? { width: "100%", flex: `${panel.height} 1 calc(${panel.height} * var(--cell-h))`, height: "auto", minHeight: 0 } : undefined}
    >
      {dividerAbove && isDesktopWeb ? (
        // A line too thin to grab, so the handle straddles it, as a pane
        // sidebar's does; it draws only while the pointer is on it.
        <Box
          position="absolute"
          left={0}
          top={0}
          height={1}
          zIndex={29}
          style={PANEL_DIVIDER_STYLE}
          {...dividerAbove.gestures}
          title="Drag to resize the panels, double-click for the default split"
          data-gloom-interactive="true"
          data-gloom-role="composite-chart-panel-divider"
          data-active={dividerAbove.active ? "true" : undefined}
        />
      ) : null}
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
              paddingInline: "var(--gloom-space-xs)",
              borderRadius: "var(--gloom-radius-sm)",
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
            seriesTags={isDesktopWeb ? seriesAxisTags.filter((tag) => tag.side === "left") : undefined}
            measuredPixelHeight={plotSize.height * cellHeightPx}
            gestures={leftAxisGestures}
            footButton={manualSide === "left"}
          />
          <Box width={axisGap} />
        </>
      ) : null}
      <ChartSurface
        ref={plotRef}
        // Its measured box on the desktop, where pointer bounds read it; CSS lays it out.
        width={plotSize.width}
        height={plotSize.height}
        // Desktop: the width the axes leave, and the row's height.
        style={isDesktopWeb ? levelGrab ? DESKTOP_PLOT_LEVEL_STYLE : onPickPrice ? DESKTOP_PLOT_PICK_STYLE : DESKTOP_PLOT_STYLE : undefined}
        flexDirection="column"
        bitmaps={bitmapLayers}
        crosshair={crosshair}
        vectors={vectors}
        onMouseMove={interactive ? handleMouseMove : undefined}
        onMouseDown={interactive ? navigable ? pressPlot : pressCursor : undefined}
        onMouseDrag={interactive && navigable ? dragViewport : undefined}
        onMouseUp={interactive && navigable ? releasePlot : undefined}
        onMouseDragEnd={interactive && navigable ? releasePlot : undefined}
        onMouseScroll={interactive && navigable ? panFromWheel : undefined}
        onMouseOut={interactive ? clearCursor : undefined}
        cursor={interactive ? levelGrab ? "ns-resize" : toolDrag || !navigable || onPickTime || onPickPrice ? "crosshair" : "grab" : undefined}
        data-gloom-interactive={interactive ? "true" : undefined}
        data-gloom-role={COMPOSITE_PANEL_ROLE}
        data-gloom-remote-kind={remoteKind}
        data-gloom-label={panel.label ?? panel.id}
        data-gloom-value-scale={manuallyScaled ? "manual" : undefined}
      >
        {textLines.map((line, index) => <Text key={index} fg={colors.text}>{line}</Text>)}
      </ChartSurface>
      {(isDesktopWeb
        ? layoutLevelLabels(projectedLevels, plotSize.height * cellHeightPx, cellHeightPx)
        : fitAxisLabels(projectedLevels.filter((entry) => entry.level.label), [], (entry) => entry.yRatio * Math.max(1, panel.height - 1))
      ).map((entry) => {
        const { level, yRatio } = entry;
        const axisWidth = levelDomain?.side === "left" ? leftAxisWidth : rightAxisWidth;
        const axisMarkers = levelDomain?.side === "left" ? leftAxisMarkers : rightAxisMarkers;
        const cursorCovers = activeCursorYRatio !== null && Math.abs(activeCursorYRatio - yRatio) * panel.height < 1;
        const axisVisible = !cursorCovers && (level.axisLabel?.length ?? 0) <= axisWidth && !!axisMarkers?.some((marker) => marker.id === level.id);
        const label = levelLabelText(level, axisVisible);
        const labelStyle = isDesktopWeb ? {
          ...levelLabelStyle(entry, colors.background), left: "auto", right: (rightAxisWidth + (rightAxisWidth ? axisGap : 0) + 1) * cellWidthPx,
          maxWidth: Math.max(1, plotWidth - 2) * cellWidthPx,
        } : undefined;
        const labelWidth = Math.min(plotWidth - 2, label.length + 2);
        return <Box key={`annotation:${level.id}`} position="absolute" left={leftAxisWidth + (leftAxisWidth ? axisGap : 0) + plotWidth - labelWidth - 1} top={yRatio * Math.max(0, panel.height - 1)} height={1}
          width={labelWidth} flexDirection="row" justifyContent="flex-end" backgroundColor={colors.background} zIndex={20}
          style={labelStyle} data-gloom-role="chart-level-label">
          <Text fg={labelStyle?.color ?? level.color} wrapMode="none" style={isDesktopWeb ? { lineHeight: 1 } : undefined}>{label}</Text>
        </Box>;
      })}
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
            seriesTags={isDesktopWeb ? seriesAxisTags.filter((tag) => tag.side === "right") : undefined}
            measuredPixelHeight={plotSize.height * cellHeightPx}
            gestures={rightAxisGestures}
            footButton={manualSide === "right"}
          />
        </>
      ) : null}
      {manualSide ? (
        <Box
          position="absolute"
          left={manualSide === "left"
            ? 0
            : leftAxisWidth + (leftAxisWidth ? axisGap : 0) + plotWidth + axisGap + Math.max(0, rightAxisWidth - manualLabel.length)}
          top={Math.max(0, panel.height - 1)}
          width={manualLabel.length}
          height={1}
          zIndex={26}
          style={isDesktopWeb
            ? {
              left: manualSide === "left" ? 0 : "auto",
              right: manualSide === "right" ? 0 : "auto",
              top: "auto",
              bottom: "var(--gloom-space-xs)",
              width: "auto",
              height: "auto",
            }
            : undefined}
          data-gloom-role="composite-chart-value-scale"
        >
          <Button
            label="Auto Scale"
            displayLabel={manualLabel}
            title="Values scaled by hand. Fit them to the data again (or double-click the axis)."
            variant="secondary"
            compact
            stopPropagation
            onPress={() => onResetValueScale(panel.id)}
          />
        </Box>
      ) : null}
    </Box>
  );
}
