import { useCompositeViewport } from "./use-composite-viewport";
import { CompositePanelSurface } from "./panel-surface";
import { MINIMUM_AXIS_LABEL_WIDTH, compositeAxisLabelWidth } from "./panel-labels";
import { isVerticalWheelDirection } from "./panel-gestures";
import type { ChartToolSpan } from "./tools";
import { ChartDrawingStore, NO_DRAWINGS, nextDrawingId, nextLevelId } from "./drawing-store";
import { CompositeLegend } from "./legend";
import { CHART_TOOL_MENU, KEYBOARD_TOOL_HINTS, ARMED_TOOL_BY_INTERACTION } from "./tool-catalog";
import { ChartToolbar, CHART_TOOLBAR_WIDTH } from "./toolbar";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AsciiText, Box, ChartSurface, Text, useUiCapabilities } from "../../../ui";
import { useShortcut } from "../../../react/input";
import {
  usePaneArrowHold,
  usePaneArrowsClaimed,
  usePaneFooter,
  usePaneHasTabStrip,
} from "../../layout/pane/footer/registration";
import type { PaneHint } from "../../layout/pane/footer/model";
import type { ContextMenuItem } from "../../../types/context-menu";
import { useOptionalPaneInstanceId } from "../../../state/app/context";
import { useThemeColors } from "../../../theme/theme-context";
import { chartSurfaceBackground, usePaneSurface } from "../../layout/pane/surface";
import { isPlainKey } from "../../../utils/keyboard";
import { CHART_WATERMARK_ROLE } from "../../../utils/screenshot-watermark";
import type { ResolvedSeries } from "../../../time-series/types";
import { downsampleCompositeChartScene } from "./downsample";
import { reuseResolvedSeriesList } from "./panel-series";
import { consumeChartMouseEvent, type ChartMouseEvent } from "../core/pointer";
import { useShowChartTextFallback } from "../native/use-chart-text-fallback";
import { StaticXAxisLabels, StaticXMarkerLabels, StaticXMarkerOverlay } from "./axis-overlays";
import { formatCompositeTimeAxisDate } from "./format";
import {
  COMPOSITE_KEYBOARD_PAN_RATIO,
  COMPOSITE_ZOOM_STEP_FACTOR,
  resolveCompositeChartInteraction,
  resolveCompositeWheelPan,
  resolveCompositeWheelZoom,
} from "./interactions";
import { levelPanel, roundLevelValue, type CompositeChartLevel } from "./levels";
import {
  CHART_DRAWING_COLORS,
  resolveMeasureAxisDomain,
  resolveMeasureValueAt,
  resolveZoomTimeRange,
  isDrawingTool,
  nextDrawingColor,
  type ChartDrawing,
  type ChartDrawingPoint,
  type ChartToolDrag,
  type ChartToolKind,
} from "./tools";
import { COMPOSITE_RIGHT_OFFSET_RATIO, projectCompositeTimestamp } from "./time-scale";
import {
  allocateCompositePanelHeights,
  applyCompositeChartCursor,
  buildCompositeChartScene,
  projectCompositeValue,
  resizeCompositePanel,
  resolveAdjacentCompositeCursorDate,
  unprojectCompositeValue,
} from "./scene";
import { buildCompositeTimeAxisLayout, buildCompositeViewportTimeAxisLayout } from "./time-axis";
import type {
  CompositeChartColors,
  CompositeChartProps,
  CompositeChartScene,
  CompositeChartXMarker,
  CompositePanelScene,
} from "./types";


/**
 * A tool placed from the keyboard: Enter anchors it at the cursor, the arrows
 * move its end and Enter finishes it. Held in data, so a pan, a zoom or a new
 * bar leaves it on the observations it was placed on.
 */
interface KeyboardToolPlacement {
  kind: ChartToolKind;
  panelId: string;
  start: ChartDrawingPoint;
  end: ChartDrawingPoint;
  /** Every step the end took: the freehand tool's trail. */
  path: ChartDrawingPoint[];
  /** Up or Down set the end's level, so Left and Right stop following the series. */
  freeValue: boolean;
}

/** A keyboard placement projected into the plot of the panel that holds it. */
export interface KeyboardToolDrag {
  panelId: string;
  drag: ChartToolDrag;
  start: ChartDrawingPoint;
  end: ChartDrawingPoint;
}

// Wordmark cell grid at scale 1 (27 columns of 8px, 4 rows of 12px).
const WATERMARK_BASE_WIDTH_PX = 216;
const WATERMARK_BASE_HEIGHT_PX = 48;

/**
 * Size the screenshot wordmark to roughly half the plot width, capped so it
 * stays a mark rather than a poster. Plots too small for a legible mark get
 * none: a clipped wordmark reads as a glitch.
 */
function chartWatermarkScale(plotWidthPx: number, plotHeightPx: number): number | null {
  const scale = Math.min(
    (plotWidthPx * 0.5) / WATERMARK_BASE_WIDTH_PX,
    (plotHeightPx * 0.4) / WATERMARK_BASE_HEIGHT_PX,
    3,
  );
  return scale >= 1 ? Math.round(scale * 4) / 4 : null;
}

/** Shift and a letter, whether or not the terminal reports the shift itself. */
function isShiftedLetter(event: { name?: string; shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean }, letter: string): boolean {
  if (event.ctrl || event.meta || event.alt) return false;
  return event.name === letter.toUpperCase() || (event.shift === true && event.name === letter);
}

const NO_X_MARKERS: readonly CompositeChartXMarker[] = [];
export function CompositeChart({
  series,
  legendSeries,
  timelineSeries,
  panels,
  width,
  height,
  focused = false,
  cursorDate,
  viewport,
  clipToViewport = false,
  viewportResetKey,
  colors,
  interactive = true,
  navigable = true,
  formatAxisValue,
  xAxis,
  remoteKind,
  allowHistoricalBackfill = false,
  axisWidth = 9,
  showLegend = true,
  showLatestChangePercent = false,
  legendAccessory,
  legendAccessoryWidth,
  showTimeAxis = true,
  emptyMessage = "No chart data",
  formatValue,
  onCursorDateChange,
  onViewportChange,
  onActivate,
  onToggleSeries,
  isSeriesToggleable,
  timePick,
  levels,
}: CompositeChartProps) {
  const activeThemeColors = useThemeColors();
  const { cellWidthPx = 8, cellHeightPx = 18, pixelRatio = 1, fractionalViewport = false } = useUiCapabilities();
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const showTextFallback = useShowChartTextFallback();
  const [internalCursorDate, setInternalCursorDate] = useState<Date | null>(null);
  const [legendKeyboardIndex, setLegendKeyboardIndex] = useState<number | null>(null);
  const [toolSpan, setToolSpan] = useState<ChartToolSpan | null>(null);
  const [armedTool, setArmedTool] = useState<ChartToolKind | null>(null);
  const [keyboardPlacement, setKeyboardPlacement] = useState<KeyboardToolPlacement | null>(null);
  // Whether the user moved into the chart from the pane's tab strip; see `inside`.
  const [entered, setEntered] = useState(false);
  const keyboardId = `composite-chart:${useId()}`;
  const paneInstanceId = useOptionalPaneInstanceId();
  const [drawings, setDrawings] = useState<readonly ChartDrawing[]>(NO_DRAWINGS);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [drawColor, setDrawColor] = useState<string>(CHART_DRAWING_COLORS[0]);
  const [selectedLevelId, setSelectedLevelId] = useState<string | null>(null);
  const addDrawing = useCallback((drawing: ChartDrawing) => {
    setDrawings((current) => [...current, drawing]);
    setSelectedDrawingId(drawing.id);
  }, []);
  const editDrawing = useCallback((
    id: string,
    update: (drawing: ChartDrawing) => ChartDrawing,
  ) => {
    setDrawings((current) => current.map((drawing) => drawing.id === id ? update(drawing) : drawing));
  }, []);
  const removeDrawing = useCallback(() => {
    setDrawings((current) => {
      if (current.length === 0) return current;
      const target = selectedDrawingId
        ? current.filter((drawing) => drawing.id !== selectedDrawingId)
        : current.slice(0, -1);
      return target.length === current.length ? current.slice(0, -1) : target;
    });
    setSelectedDrawingId(null);
  }, [selectedDrawingId]);
  const pickDrawColor = useCallback((color: string) => {
    setDrawColor(color);
    if (!selectedDrawingId) return;
    setDrawings((current) => current.map(
      (drawing) => drawing.id === selectedDrawingId ? { ...drawing, color } : drawing,
    ));
  }, [selectedDrawingId]);
  const resolvedCursorDate = cursorDate === undefined ? internalCursorDate : cursorDate;
  const totalWidth = Math.max(1, Math.floor(width));
  const totalHeight = Math.max(1, Math.floor(height));
  const seriesIdentityRef = useRef<ResolvedSeries[]>([]);
  const stableSeries = reuseResolvedSeriesList(seriesIdentityRef.current, series);
  seriesIdentityRef.current = stableSeries;
  const visibleSeries = useMemo(() => stableSeries.filter((entry) => entry.points.length > 0), [stableSeries]);
  // Panel layout follows the authored series so a panel keeps its height while
  // its data loads; only the marks inside it wait for observations.
  const panelSeries = useMemo(() => stableSeries.filter((entry) => !entry.hidden), [stableSeries]);
  const marketTimelineSeries = useMemo(() => {
    const supplied = timelineSeries?.filter((entry) => entry.points.length > 0) ?? [];
    return supplied.some((entry) => entry.timeBasis?.kind === "market")
      ? supplied
      : visibleSeries;
  }, [timelineSeries, visibleSeries]);
  // A series with no observation in this window stays listed. Dropping it made
  // the legend disagree with the series editor and looked like the chart had
  // silently thrown the series away.
  const visibleLegendSeries = useMemo(
    () => legendSeries ?? visibleSeries,
    [legendSeries, visibleSeries],
  );
  const visibleSeriesIds = useMemo(
    () => new Set(visibleSeries.map((entry) => entry.id)),
    [visibleSeries],
  );
  useEffect(() => {
    setLegendKeyboardIndex((current) => (
      current === null || visibleLegendSeries.length === 0
        ? null
        : Math.min(current, visibleLegendSeries.length - 1)
    ));
  }, [visibleLegendSeries.length]);
  const {
    navigationFrame, activeUserViewport, effectiveViewport,
    panViewport, panViewportByRatio, zoomViewport, setViewportRange, resetViewport,
  } = useCompositeViewport({
    viewport, viewportResetKey, visibleSeries, marketTimelineSeries,
    allowHistoricalBackfill, onViewportChange,
  });
  // Sticky while armed: the toolbar chip shows which tool owns the drag, and a
  // one-shot tool would blink off before the user could see it.
  const armTool = useCallback((tool: ChartToolKind | null) => {
    // A tool is placed with the arrows, so picking one moves into the chart.
    if (tool !== null) setEntered(true);
    setArmedTool((current) => current === tool ? null : tool);
    setKeyboardPlacement(null);
    if (tool === null) setSelectedDrawingId(null);
    if (tool !== "level") setSelectedLevelId(null);
  }, []);
  const cancelKeyboardPlacement = useCallback(() => setKeyboardPlacement(null), []);
  const legendRows = showLegend && (visibleSeries.length > 0 || legendAccessory)
    ? 1
    : 0;
  const timeAxisRows = showTimeAxis ? 1 : 0;
  const xMarkers = xAxis?.markers ?? NO_X_MARKERS;
  const xMarkerRows = xMarkers.some((marker) => marker.label) ? 1 : 0;
  const panelCount = new Set(panelSeries.map((entry) => entry.panelId)).size;
  // A forming bar can change its extremes or volume without moving its close.
  const lastTickKey = visibleSeries.map((entry) => {
    const last = entry.points.at(-1);
    if (!last) return entry.id;
    return `${entry.id}:${last.date.getTime()}:${last.close ?? ""}:${last.value ?? ""}:${last.high ?? ""}:${last.low ?? ""}:${last.volume ?? ""}:${entry.latestChangePercent ?? ""}`;
  }).join("|");
  const plotHeight = Math.max(panelCount, totalHeight - legendRows - timeAxisRows - xMarkerRows);
  const paneSurface = usePaneSurface();
  const resolvedColors = useMemo<CompositeChartColors>(() => ({
    background: chartSurfaceBackground(colors?.background, activeThemeColors.bg, paneSurface),
    grid: colors?.grid ?? activeThemeColors.border,
    crosshair: colors?.crosshair ?? activeThemeColors.borderFocused,
    text: colors?.text ?? activeThemeColors.text,
    textDim: colors?.textDim ?? activeThemeColors.textDim,
    negative: colors?.negative ?? activeThemeColors.negative,
  }), [activeThemeColors, colors, paneSurface]);
  // A custom x axis means x is not time: a tenor, a fraction, a return. Its
  // last observation belongs at the right edge, under its own label.
  const rightOffsetRatio = xAxis ? 0 : COMPOSITE_RIGHT_OFFSET_RATIO;
  const projectedScene = useMemo(() => {
    // lastTickKey busts this memo when a live tick mutates series identity in place.
    void lastTickKey;
    return buildCompositeChartScene(panelSeries, panels, {
      width: 1,
      height: Math.max(panelCount, 1),
      viewport: effectiveViewport ?? undefined,
      clipToViewport,
      timelineSeries: marketTimelineSeries,
      rightOffsetRatio,
    });
  }, [
    clipToViewport,
    effectiveViewport,
    lastTickKey,
    marketTimelineSeries,
    panelCount,
    panelSeries,
    panels,
    rightOffsetRatio,
  ]);
  // Gutters follow the axes the scene actually built. Reading the series list
  // instead drops a gutter the moment its series has no observation in view,
  // which is exactly what a zoom does, taking the axis labels with it.
  const scenePanels = projectedScene?.panels;
  const hasLeftAxis = scenePanels
    ? scenePanels.some((panel) => !!panel.axes.left)
    : visibleSeries.some((entry) => entry.axis === "left");
  const hasRightAxis = scenePanels
    ? scenePanels.some((panel) => !!panel.axes.right)
    : visibleSeries.some((entry) => entry.axis === "right");
  const maximumAxisWidth = Math.max(0, Math.floor(axisWidth));
  // Gutters follow their labels. A fixed budget left dead space beside short
  // prices, which costs plot width on every chart that does not need it.
  const axisCount = Number(hasLeftAxis) + Number(hasRightAxis);
  // Keep at least half the chart (and 12 cells on small charts) for the plot.
  const minimumPlotWidth = Math.min(totalWidth, Math.max(12, Math.floor(totalWidth / 2)));
  const availableAxisWidth = axisCount > 0
    ? Math.max(0, Math.floor((totalWidth - minimumPlotWidth) / axisCount) - 1)
    : 0;
  const layoutPanels = useMemo<CompositePanelScene[] | null>(() => {
    if (!projectedScene) return null;
    const panelSpecById = new Map(panels.map((panel) => [panel.id, panel] as const));
    const panelHeights = allocateCompositePanelHeights(
      projectedScene.panels.map((panel) => ({
        id: panel.id,
        height: panelSpecById.get(panel.id)?.height,
      })),
      plotHeight,
    );
    // Terminal labels snap to rows; a fractional viewport places them exactly.
    return projectedScene.panels.map((panel) => resizeCompositePanel(panel, panelHeights.get(panel.id) ?? 1, !fractionalViewport));
  }, [fractionalViewport, panels, plotHeight, projectedScene]);
  // Static overview charts also pin the latest price with cursor precision.
  const includeCursorLabels = interactive || cursorDate !== undefined || !!scenePanels?.some((panel) => panel.lastPrice);
  const resolvedAxisWidth = useMemo(() => maximumAxisWidth === 0 ? 0 : Math.min(
    availableAxisWidth,
    Math.max(
      Math.min(MINIMUM_AXIS_LABEL_WIDTH, maximumAxisWidth),
      ...(layoutPanels ?? []).flatMap((panel) => [
        compositeAxisLabelWidth(panel.axes.left, formatAxisValue, includeCursorLabels),
        compositeAxisLabelWidth(panel.axes.right, formatAxisValue, includeCursorLabels),
      ]).map((width) => includeCursorLabels ? width : Math.min(width, maximumAxisWidth)),
    ),
  ), [availableAxisWidth, formatAxisValue, includeCursorLabels, layoutPanels, maximumAxisWidth]);
  const leftAxisWidth = hasLeftAxis ? resolvedAxisWidth : 0;
  const rightAxisWidth = hasRightAxis ? resolvedAxisWidth : 0;
  const axisGap = resolvedAxisWidth > 0 ? 1 : 0;
  const horizontalReserved = leftAxisWidth + rightAxisWidth
    + axisGap * ((leftAxisWidth ? 1 : 0) + (rightAxisWidth ? 1 : 0));
  const plotWidth = Math.max(1, totalWidth - horizontalReserved);
  const watermarkScale = isDesktopWeb
    ? chartWatermarkScale(plotWidth * cellWidthPx, plotHeight * cellHeightPx)
    : null;
  const downsampleWidth = Math.max(
    1,
    Math.round(plotWidth * cellWidthPx * Math.max(1, pixelRatio)),
  );
  const baseScene = useMemo<CompositeChartScene | null>(() => {
    if (!projectedScene || !layoutPanels) return null;
    const laidOut: CompositeChartScene = {
      ...projectedScene,
      width: plotWidth,
      height: layoutPanels.reduce((sum, panel) => sum + panel.height, 0),
      panels: layoutPanels,
    };
    return downsampleCompositeChartScene(laidOut, downsampleWidth);
  }, [downsampleWidth, layoutPanels, plotWidth, projectedScene]);
  const resolvedCursorTimestamp = resolvedCursorDate?.getTime() ?? null;
  const normalizedCursorTimestamp = resolvedCursorTimestamp !== null && Number.isFinite(resolvedCursorTimestamp)
    ? resolvedCursorTimestamp
    : null;
  const scene = useMemo(() => (
    baseScene
      ? applyCompositeChartCursor(
        baseScene,
        normalizedCursorTimestamp === null ? null : new Date(normalizedCursorTimestamp),
      )
      : null
  ), [baseScene, normalizedCursorTimestamp]);
  // A press, drag or wheel on the chart moves into it, as Down or Enter do.
  const activateFromPointer = useCallback(() => {
    setEntered(true);
    onActivate?.();
  }, [onActivate]);
  const handleEmptyMouseScroll = useCallback((event: ChartMouseEvent) => {
    const scroll = event.scroll;
    if (!interactive || !navigationFrame || !scroll) return;
    activateFromPointer();
    consumeChartMouseEvent(event);
    if (event.modifiers.ctrl && isVerticalWheelDirection(scroll.direction)) {
      const factor = resolveCompositeWheelZoom(scroll);
      if (factor < 1) {
        resetViewport();
        return;
      }
      zoomViewport(factor, 0.5);
      return;
    }
    panViewportByRatio(resolveCompositeWheelPan(scroll, plotWidth * cellWidthPx));
  }, [
    activateFromPointer,
    cellWidthPx,
    interactive,
    navigationFrame,
    panViewportByRatio,
    plotWidth,
    resetViewport,
    zoomViewport,
  ]);
  const levelHost = useMemo(
    () => scene && levels ? levelPanel(scene, levels.seriesId) : null,
    [levels, scene],
  );
  const levelItems = levels?.items ?? [];
  const levelsEditable = !!levels?.onEdit && !!levelHost;
  const selectedLevel = levelItems.find((level) => level.id === selectedLevelId) ?? null;
  useEffect(() => {
    if (selectedLevelId && !selectedLevel) setSelectedLevelId(null);
  }, [selectedLevel, selectedLevelId]);
  const keyboardCursorDateRef = useRef<Date | null>(scene?.cursorDate ?? null);
  keyboardCursorDateRef.current = scene?.cursorDate ?? null;
  const lastCursorTimestampRef = useRef<number | null>(normalizedCursorTimestamp);
  const renderedCursorTimestampRef = useRef<number | null>(normalizedCursorTimestamp);
  if (renderedCursorTimestampRef.current !== normalizedCursorTimestamp) {
    renderedCursorTimestampRef.current = normalizedCursorTimestamp;
    lastCursorTimestampRef.current = normalizedCursorTimestamp;
  }

  const updateCursor = useCallback((date: Date | null) => {
    const timestamp = date?.getTime() ?? null;
    const nextTimestamp = timestamp !== null && Number.isFinite(timestamp) ? timestamp : null;
    if (lastCursorTimestampRef.current === nextTimestamp) return;
    lastCursorTimestampRef.current = nextTimestamp;
    if (cursorDate === undefined) setInternalCursorDate(date);
    onCursorDateChange?.(date);
  }, [cursorDate, onCursorDateChange]);

  // The cursor keys belong to every focused chart; pan, zoom, the tools and
  // their keys only to one that navigates.
  const arrowsClaimed = usePaneArrowsClaimed();
  const keyboardActive = focused && interactive;
  const toolsActive = keyboardActive && navigable;
  // Under a tab strip, a chart you pan and draw on is one focus level down: the
  // strip keeps Left, Right, h and l until Down, Enter, a click or a tool moves
  // into the chart, and Esc or Up hands them back. A pane with no strip (G)
  // leaves the chart its keys throughout.
  const paneHasStrip = usePaneHasTabStrip();
  const zoned = navigable && paneHasStrip;
  const inside = zoned && entered;
  usePaneArrowHold(focused && inside);
  // The next visit to the pane or the tab starts at the strip.
  const wasFocusedRef = useRef(focused);
  useEffect(() => {
    if (wasFocusedRef.current && !focused) setEntered(false);
    wasFocusedRef.current = focused;
  }, [focused]);
  // A time is picked with the arrows and Enter.
  const picking = !!timePick;
  useEffect(() => {
    if (picking) setEntered(true);
  }, [picking]);
  useEffect(() => {
    if (!toolsActive) setKeyboardPlacement(null);
  }, [toolsActive]);
  const legendKeysActive = keyboardActive && showLegend && visibleLegendSeries.length > 0;
  const legendEntry = legendKeyboardIndex === null ? undefined : visibleLegendSeries[legendKeyboardIndex];
  const legendEntryToggleable = !!legendEntry && !!onToggleSeries && (isSeriesToggleable?.(legendEntry) ?? true);
  const anyLegendToggleable = legendKeysActive && !!onToggleSeries
    && visibleLegendSeries.some((entry) => isSeriesToggleable?.(entry) ?? true);
  // With a drawing tool in hand, [ and ] step through the drawings instead of
  // the legend, the way a click with that tool picks one.
  const drawingKeysActive = toolsActive && isDrawingTool(armedTool) && drawings.length > 0 && !keyboardPlacement;
  // Backspace only deletes what the user is working on; otherwise it is the
  // pane's back key.
  const canDeleteDrawing = toolsActive && drawings.length > 0 && (!!selectedDrawingId || isDrawingTool(armedTool));
  // An owner that holds the cursor decides when it goes, so Esc stays the pane's.
  const clearableCursor = !!scene?.cursorDate && cursorDate === undefined;

  const enterChart = () => {
    setEntered(true);
    // The cursor shows where the keys went, starting on the latest bar.
    if (!scene || cursorDate !== undefined || keyboardCursorDateRef.current) return;
    const date = resolveAdjacentCompositeCursorDate(scene, null, -1);
    keyboardCursorDateRef.current = date;
    updateCursor(date);
  };
  const leaveChart = () => {
    setEntered(false);
    setLegendKeyboardIndex(null);
    if (!clearableCursor) return;
    keyboardCursorDateRef.current = null;
    updateCursor(null);
  };
  const placementPanel = (panelId: string) => scene?.panels.find((panel) => panel.id === panelId) ?? null;
  const startKeyboardPlacement = () => {
    if (!scene || !armedTool) return;
    const panel = scene.panels.find((entry) => resolveMeasureAxisDomain(entry) !== null);
    const domain = panel ? resolveMeasureAxisDomain(panel) : null;
    const date = keyboardCursorDateRef.current ?? resolveAdjacentCompositeCursorDate(scene, null, -1);
    if (!panel || !domain || !date) return;
    const time = date.getTime();
    const value = resolveMeasureValueAt(panel, time) ?? unprojectCompositeValue(0.5, domain);
    if (value === null) return;
    const anchor = { time, value };
    onActivate?.();
    if (isDrawingTool(armedTool)) setSelectedDrawingId(null);
    setKeyboardPlacement({ kind: armedTool, panelId: panel.id, start: anchor, end: anchor, path: [anchor], freeValue: false });
    keyboardCursorDateRef.current = date;
    updateCursor(date);
  };
  /** Moves the end to a new bar, following the series until Up or Down set a level. */
  const moveKeyboardPlacement = (
    placement: KeyboardToolPlacement,
    move: { time: number } | { level: 1 | -1 },
  ): KeyboardToolPlacement | null => {
    const panel = placementPanel(placement.panelId);
    const domain = panel ? resolveMeasureAxisDomain(panel) : null;
    if (!panel || !domain) return null;
    let { time, value } = placement.end;
    let freeValue = placement.freeValue;
    if ("level" in move) {
      // Half a row per press: fine enough to reach a wick, quick enough to cross the plot.
      const step = 1 / (2 * Math.max(panel.height - 1, 1));
      const ratio = projectCompositeValue(value, domain) ?? 0.5;
      value = unprojectCompositeValue(Math.max(0, Math.min(1, ratio - move.level * step)), domain) ?? value;
      freeValue = true;
    } else {
      time = move.time;
      if (!freeValue) value = resolveMeasureValueAt(panel, time) ?? value;
    }
    const end = { time, value };
    return { ...placement, end, path: [...placement.path, end], freeValue };
  };
  const finishKeyboardPlacement = () => {
    const placement = keyboardPlacement;
    setKeyboardPlacement(null);
    // A placement that never left its anchor spans nothing, like a click.
    if (!placement || placement.start.time === placement.end.time) return;
    if (placement.kind === "zoom") {
      if (!navigationFrame) return;
      const range = resolveZoomTimeRange(placement.start.time, placement.end.time, navigationFrame.minimumSpanMs);
      if (range) setViewportRange(range);
      return;
    }
    if (!isDrawingTool(placement.kind)) return;
    const points = placement.kind === "pencil"
      ? placement.path.filter((point, index, path) => (
        index === 0 || point.time !== path[index - 1]!.time || point.value !== path[index - 1]!.value
      ))
      : [placement.start, placement.end];
    if (points.length < 2) return;
    addDrawing({ id: nextDrawingId(), panelId: placement.panelId, points, color: drawColor });
  };
  const stepLegend = (direction: -1 | 1) => {
    onActivate?.();
    setLegendKeyboardIndex((current) => (
      current === null
        ? direction > 0 ? 0 : visibleLegendSeries.length - 1
        : (current + direction + visibleLegendSeries.length) % visibleLegendSeries.length
    ));
  };
  const toggleLegendEntry = () => {
    if (!legendEntry || !legendEntryToggleable) return;
    onActivate?.();
    onToggleSeries?.(legendEntry.id);
  };
  /** A level at the keyboard cursor's price, or the last price without a cursor. */
  const addLevelAtCursor = () => {
    if (!levels?.onEdit || !levelHost || !scene) return;
    const { panel, domain } = levelHost;
    const date = keyboardCursorDateRef.current ?? scene.dates.at(-1) ?? null;
    // The levels' own series, not whichever one the panel lists first.
    const pricePanel = { ...panel, series: panel.series.filter((entry) => entry.source.id === levels.seriesId) };
    const value = (date ? resolveMeasureValueAt(pricePanel, date.getTime()) : null)
      ?? (panel.lastPrice?.seriesId === levels.seriesId ? panel.lastPrice.value : null)
      ?? unprojectCompositeValue(0.5, domain);
    if (value === null) return;
    const rounded = roundLevelValue(value, domain);
    onActivate?.();
    // Enter again at the same cursor picks the level already there.
    const existing = levelItems.find((level) => level.editable && level.value === rounded);
    if (existing) {
      setSelectedLevelId(existing.id);
      return;
    }
    const id = nextLevelId();
    levels.onEdit({ kind: "add", id, value: rounded });
    setSelectedLevelId(id);
  };
  /** Half a row per press, like a keyboard-placed tool's end. */
  const nudgeLevel = (level: CompositeChartLevel, direction: 1 | -1) => {
    if (!levels?.onEdit || !levelHost) return;
    const { panel, domain } = levelHost;
    const ratio = projectCompositeValue(level.value, domain);
    if (ratio === null) return;
    const step = 1 / (2 * Math.max(panel.height - 1, 1));
    const value = unprojectCompositeValue(Math.max(0, Math.min(1, ratio - direction * step)), domain);
    if (value !== null) levels.onEdit({ kind: "move", id: level.id, value: roundLevelValue(value, domain) });
  };
  const stepLevel = (direction: -1 | 1) => {
    // Top to bottom, the order they read in on the plot.
    const ordered = [...levelItems].sort((left, right) => right.value - left.value);
    if (ordered.length === 0) return;
    const index = ordered.findIndex((level) => level.id === selectedLevelId);
    const next = index < 0
      ? direction > 0 ? 0 : ordered.length - 1
      : (index + direction + ordered.length) % ordered.length;
    setSelectedLevelId(ordered[next]!.id);
  };
  const removeSelectedLevel = () => {
    if (!selectedLevel?.editable) return;
    levels?.onEdit?.({ kind: "remove", id: selectedLevel.id });
    setSelectedLevelId(null);
  };
  const runLevelAction = () => {
    if (selectedLevel?.actionable) levels?.action?.run(selectedLevel);
  };
  const stepDrawing = (direction: -1 | 1) => {
    if (drawings.length === 0) return;
    const index = drawings.findIndex((drawing) => drawing.id === selectedDrawingId);
    const next = index < 0
      ? direction > 0 ? 0 : drawings.length - 1
      : (index + direction + drawings.length) % drawings.length;
    setSelectedDrawingId(drawings[next]!.id);
  };
  const keyboardToolDrag = useMemo<KeyboardToolDrag | null>(() => {
    if (!keyboardPlacement || !scene) return null;
    const panel = scene.panels.find((entry) => entry.id === keyboardPlacement.panelId);
    const domain = panel ? resolveMeasureAxisDomain(panel) : null;
    if (!panel || !domain) return null;
    const project = (point: ChartDrawingPoint) => {
      const xRatio = projectCompositeTimestamp(scene.timeScale, point.time)?.ratio;
      const yRatio = projectCompositeValue(point.value, domain);
      return typeof xRatio === "number" && yRatio !== null ? { xRatio, yRatio } : null;
    };
    const start = project(keyboardPlacement.start);
    const end = project(keyboardPlacement.end);
    if (!start || !end) return null;
    return {
      panelId: panel.id,
      start: keyboardPlacement.start,
      end: keyboardPlacement.end,
      drag: {
        kind: keyboardPlacement.kind,
        startXRatio: start.xRatio,
        startYRatio: start.yRatio,
        endXRatio: end.xRatio,
        endYRatio: end.yRatio,
        path: keyboardPlacement.path.flatMap((point) => {
          const projected = project(point);
          return projected ? [projected] : [];
        }),
      },
    };
  }, [keyboardPlacement, scene]);

  // Scoped, so the chart sees its keys before an older pane or stack handler
  // (Backspace back, Esc close) whichever mounted first; a dialog opened over
  // it is a newer scope and still comes first.
  useShortcut((event) => {
    if (!keyboardActive) return;
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (timePick && scene && isPlainKey(event, "return", "enter", "escape")) {
      consume();
      if (event.name === "escape") timePick.onCancel();
      else chartActionsRef.current.pick();
      return;
    }
    if (zoned && !entered && isPlainKey(event, "down", "return", "enter")) {
      consume();
      enterChart();
      return;
    }
    const levelKeys = toolsActive && armedTool === "level" && levelsEditable && !keyboardPlacement;
    if (levelKeys && isPlainKey(event, "return", "enter")) {
      consume();
      addLevelAtCursor();
      return;
    }
    if (levelKeys && selectedLevel?.editable && isPlainKey(event, "up", "down")) {
      consume();
      nudgeLevel(selectedLevel, event.name === "up" ? 1 : -1);
      return;
    }
    if (levelKeys && levelItems.length > 0 && isPlainKey(event, "[", "]")) {
      consume();
      stepLevel(event.name === "[" ? -1 : 1);
      return;
    }
    if (toolsActive && selectedLevel?.editable && levelsEditable && isPlainKey(event, "backspace")) {
      consume();
      removeSelectedLevel();
      return;
    }
    // Taken even once the level has its alert, which then says so, so a quick
    // second press never falls through to the plain `a` pan.
    if (toolsActive && selectedLevel && levels?.action && isShiftedLetter(event, "a")) {
      consume();
      levels.action.run(selectedLevel);
      return;
    }
    if (toolsActive && armedTool && isPlainKey(event, "return", "enter") && scene) {
      consume();
      if (keyboardPlacement) finishKeyboardPlacement();
      else startKeyboardPlacement();
      return;
    }
    if (keyboardPlacement && (isPlainKey(event, "escape") || isPlainKey(event, "backspace"))) {
      consume();
      setKeyboardPlacement(null);
      return;
    }
    if (keyboardPlacement && keyboardPlacement.kind !== "zoom" && isPlainKey(event, "up", "down")) {
      consume();
      const level = event.name === "up" ? 1 : -1;
      setKeyboardPlacement((current) => current && moveKeyboardPlacement(current, { level }));
      return;
    }
    if (isPlainKey(event, "[", "]") && (drawingKeysActive || legendKeysActive)) {
      consume();
      const direction = event.name === "[" ? -1 : 1;
      if (drawingKeysActive) stepDrawing(direction);
      else stepLegend(direction);
      return;
    }
    if (isPlainKey(event, "space") && legendKeysActive && legendEntryToggleable) {
      consume();
      toggleLegendEntry();
      return;
    }
    if (isPlainKey(event, "escape") && toolsActive && (armedTool || selectedDrawingId || selectedLevelId)) {
      consume();
      setArmedTool(null);
      setSelectedDrawingId(null);
      setSelectedLevelId(null);
      return;
    }
    if (isPlainKey(event, "escape") && legendKeysActive && legendKeyboardIndex !== null && !clearableCursor) {
      consume();
      setLegendKeyboardIndex(null);
      return;
    }
    // Whatever a tool or a pick held is gone by now, so Esc steps out to the
    // strip, and so does Up: the strip sits above. Consumed, so leaving never
    // counts toward a double-Esc close.
    if (inside && isPlainKey(event, "escape", "up")) {
      consume();
      leaveChart();
      return;
    }
    const interaction = resolveCompositeChartInteraction(event);
    if (!interaction) return;
    const cursorInteraction = interaction === "cursor-left"
      || interaction === "cursor-right"
      || interaction === "clear-cursor";
    if (!cursorInteraction && !toolsActive) return;
    if (
      (interaction === "clear-cursor" && !clearableCursor)
      || ((interaction === "arm-measure"
        || interaction === "arm-zoom"
        || interaction === "arm-line"
        || interaction === "arm-pencil") && !scene)
      || (interaction === "arm-level" && !levelsEditable)
      || (interaction === "delete-drawing" && !canDeleteDrawing)
      || (interaction === "cycle-colour" && !isDrawingTool(armedTool) && !selectedDrawingId)
      // A focused tab strip in the pane keeps the arrows until the user moves
      // into a chart they pan and draw on; a read-only chart never takes them.
      || ((interaction === "cursor-left" || interaction === "cursor-right") && (!scene || (arrowsClaimed && !inside)))
      || ((interaction === "zoom-in"
        || interaction === "zoom-out"
        || interaction === "pan-left"
        || interaction === "pan-right") && !navigationFrame)
    ) {
      return;
    }
    consume();
    switch (interaction) {
      case "arm-measure":
      case "arm-zoom":
      case "arm-line":
      case "arm-pencil":
      case "arm-level":
        onActivate?.();
        armTool(ARMED_TOOL_BY_INTERACTION[interaction]);
        return;
      case "delete-drawing":
        removeDrawing();
        return;
      case "cycle-colour":
        pickDrawColor(nextDrawingColor(drawColor));
        return;
      case "clear-cursor":
        keyboardCursorDateRef.current = null;
        updateCursor(null);
        return;
      case "cursor-left":
      case "cursor-right": {
        const nextDate = resolveAdjacentCompositeCursorDate(
          scene!,
          keyboardCursorDateRef.current,
          interaction === "cursor-left" ? -1 : 1,
        );
        keyboardCursorDateRef.current = nextDate;
        updateCursor(nextDate);
        if (nextDate && keyboardPlacement) {
          const time = nextDate.getTime();
          setKeyboardPlacement((current) => current && moveKeyboardPlacement(current, { time }));
        }
        return;
      }
      case "pan-left":
        panViewportByRatio(COMPOSITE_KEYBOARD_PAN_RATIO);
        return;
      case "pan-right":
        panViewportByRatio(-COMPOSITE_KEYBOARD_PAN_RATIO);
        return;
      case "reset":
        resetViewport();
        return;
      case "zoom-in":
        zoomViewport(COMPOSITE_ZOOM_STEP_FACTOR);
        return;
      case "zoom-out":
        zoomViewport(1 / COMPOSITE_ZOOM_STEP_FACTOR);
    }
  }, { enabled: keyboardActive, scope: keyboardId });

  // The keys a mode adds show where they act: Enter with a tool in hand, Space
  // on a legend entry. Everything else the chart answers is in the pane menu.
  // Footer and menu entries outlive the render that registered them, so they
  // call through to this render's actions.
  const chartActions = {
    pick: () => {
      const date = keyboardCursorDateRef.current ?? scene?.dates.at(-1) ?? null;
      if (date) timePick?.onPick(date);
    },
    start: armedTool === "level" ? addLevelAtCursor : startKeyboardPlacement,
    finish: finishKeyboardPlacement,
    stepLevel,
    removeLevel: removeSelectedLevel,
    levelAction: runLevelAction,
    toggleLegend: toggleLegendEntry,
    stepLegend,
    stepDrawing,
    removeDrawing,
    cycleColour: () => pickDrawColor(nextDrawingColor(drawColor)),
    reset: resetViewport,
    arm: (tool: ChartToolKind) => {
      onActivate?.();
      armTool(tool);
    },
    leave: leaveChart,
  };
  const chartActionsRef = useRef(chartActions);
  chartActionsRef.current = chartActions;
  // Inside the chart the footer names the way back first, so it never falls
  // behind More; on the strip there is nothing to say.
  const leaveHint = keyboardActive && inside;
  usePaneFooter(`${keyboardId}:leave`, () => leaveHint
    ? { order: -2, hints: [{ id: "chart-leave", key: "Esc", label: "tabs", title: "Back to Tabs", onPress: () => chartActionsRef.current.leave() }] }
    : null, [leaveHint]);
  const armedHints = armedTool ? KEYBOARD_TOOL_HINTS[armedTool] : null;
  const placing = !!keyboardPlacement;
  const legendEntryVisible = !!legendEntry && visibleSeriesIds.has(legendEntry.id);
  const resettable = !!activeUserViewport;
  const timePickLabel = timePick?.label ?? null;
  const levelActionHint = selectedLevel?.actionable && levels?.action ? levels.action : null;
  const levelToolKeys = toolsActive && armedTool === "level" && levelsEditable;
  const canDeleteLevel = toolsActive && levelsEditable && !!selectedLevel?.editable;
  usePaneFooter(keyboardId, () => {
    if (!keyboardActive || !scene) return null;
    const hints: PaneHint[] = [];
    if (timePickLabel) {
      hints.push({ id: "chart-pick", key: "Enter", label: timePickLabel, onPress: () => chartActionsRef.current.pick() });
    } else if (toolsActive && armedHints) {
      hints.push(placing
        ? { id: "chart-tool", key: "Enter", label: armedHints.finish, title: armedHints.finishTitle, onPress: () => chartActionsRef.current.finish() }
        : { id: "chart-tool", key: "Enter", label: armedHints.start, title: armedHints.startTitle, onPress: () => chartActionsRef.current.start() });
    }
    if (toolsActive && levelActionHint) {
      hints.push({
        id: "chart-level-action",
        key: "Shift+A",
        label: levelActionHint.label,
        title: levelActionHint.title,
        onPress: () => chartActionsRef.current.levelAction(),
      });
    }
    if (legendKeysActive && legendEntryToggleable) {
      hints.push({
        id: "chart-series",
        key: "Space",
        label: legendEntryVisible ? "hide" : "show",
        title: legendEntryVisible ? "Hide Series" : "Show Series",
        onPress: () => chartActionsRef.current.toggleLegend(),
      });
    }
    const menu: ContextMenuItem[] = [];
    if (toolsActive) {
      for (const tool of CHART_TOOL_MENU.filter((entry) => entry.kind !== "level" || levelsEditable)) {
        menu.push({
          id: `chart-tool-${tool.kind}`,
          label: tool.label,
          accelerator: tool.accelerator,
          checked: armedTool === tool.kind,
          onSelect: () => chartActionsRef.current.arm(tool.kind),
        });
      }
      if (drawingKeysActive) {
        menu.push({ id: "chart-drawing-next", label: "Next Drawing", accelerator: "]", onSelect: () => chartActionsRef.current.stepDrawing(1) });
      }
      if (canDeleteDrawing) {
        menu.push({ id: "chart-drawing-delete", label: "Delete Drawing", accelerator: "Backspace", onSelect: () => chartActionsRef.current.removeDrawing() });
      }
      if (levelToolKeys && levelItems.length > 0) {
        menu.push({ id: "chart-level-next", label: "Next Level", accelerator: "]", onSelect: () => chartActionsRef.current.stepLevel(1) });
      }
      if (canDeleteLevel) {
        menu.push({ id: "chart-level-delete", label: "Delete Level", accelerator: "Backspace", onSelect: () => chartActionsRef.current.removeLevel() });
      }
      if (isDrawingTool(armedTool) || selectedDrawingId) {
        menu.push({
          id: "chart-drawing-colour",
          label: "Drawing Colour",
          accelerator: "c",
          onSelect: () => chartActionsRef.current.cycleColour(),
        });
      }
      if (resettable) menu.push({ id: "chart-reset", label: "Reset Zoom", accelerator: "0", onSelect: () => chartActionsRef.current.reset() });
    }
    if (legendKeysActive && anyLegendToggleable && !drawingKeysActive) {
      menu.push({ id: "chart-series-next", label: "Next Series", accelerator: "]", onSelect: () => chartActionsRef.current.stepLegend(1) });
    }
    return { order: 10, hints, menu };
  }, [
    armedHints,
    anyLegendToggleable,
    armedTool,
    canDeleteDrawing,
    drawingKeysActive,
    keyboardActive,
    legendEntryToggleable,
    legendEntryVisible,
    legendKeysActive,
    placing,
    resettable,
    !!scene,
    selectedDrawingId,
    timePickLabel,
    levelActionHint,
    levelToolKeys,
    levelItems.length,
    canDeleteLevel,
    levelsEditable,
    toolsActive,
  ]);

  const leftPadding = leftAxisWidth + (leftAxisWidth ? axisGap : 0);
  const rightPadding = rightAxisWidth + (rightAxisWidth ? axisGap : 0);
  const timeAxisLayout = scene && showTimeAxis
    ? buildCompositeTimeAxisLayout(scene, plotWidth)
    : null;
  const emptyTimeAxisLayout = !scene && showTimeAxis && effectiveViewport
    ? buildCompositeViewportTimeAxisLayout(effectiveViewport, plotWidth)
    : null;

  if (!scene) {
    const emptyPlotHeight = Math.max(0, totalHeight - legendRows - timeAxisRows - xMarkerRows);
    return (
      <Box
        flexDirection="column"
        width={totalWidth}
        height={totalHeight}
        overflow="hidden"
        data-gloom-role="composite-chart"
      >
        {legendRows > 0 && legendAccessory ? (
          <CompositeLegend
            scene={null}
            series={[]}
            visibleSeriesIds={new Set()}
            width={totalWidth}
            accessory={legendAccessory}
            accessoryWidth={legendAccessoryWidth}
            formatValue={formatValue}
            showLatestChangePercent={showLatestChangePercent}
            onActivate={activateFromPointer}
            onToggleSeries={onToggleSeries}
            isSeriesToggleable={isSeriesToggleable}
            keyboardIndex={legendKeyboardIndex}
          />
        ) : null}
        {emptyPlotHeight > 0 ? (
          <Box flexDirection="row" width={totalWidth} height={emptyPlotHeight}>
            {leftPadding > 0 ? <Box width={leftPadding} /> : null}
            <ChartSurface
              width={plotWidth}
              height={emptyPlotHeight}
              alignItems="center"
              justifyContent="center"
              onMouseScroll={interactive && navigable && navigationFrame ? handleEmptyMouseScroll : undefined}
              cursor={interactive && navigable && navigationFrame ? "grab" : undefined}
              data-gloom-interactive={interactive && navigable && navigationFrame ? "true" : undefined}
              data-gloom-role="composite-chart-empty"
              data-gloom-label={emptyMessage}
            >
              <Text fg={resolvedColors.textDim}>{emptyMessage}</Text>
            </ChartSurface>
            {rightPadding > 0 ? <Box width={rightPadding} /> : null}
          </Box>
        ) : null}
        {emptyTimeAxisLayout ? (
          <Box flexDirection="row" width={totalWidth} height={1}>
            {leftPadding > 0 ? <Box width={leftPadding} /> : null}
            <StaticXAxisLabels
              labels={[emptyTimeAxisLayout.text]}
              positionedLabels={emptyTimeAxisLayout.ticks}
              width={plotWidth}
              color={resolvedColors.textDim}
            />
            {rightPadding > 0 ? <Box width={rightPadding} /> : null}
          </Box>
        ) : null}
      </Box>
    );
  }

  const timeAxisCursorColumn = scene.cursorXRatio === null
    ? null
    : scene.cursorXRatio * Math.max(plotWidth - 1, 0);
  const timeAxisCursorPixelX = timeAxisCursorColumn === null
    ? null
    : timeAxisCursorColumn * cellWidthPx;
  const timeAxisCursorLabel = xAxis?.formatCursor && scene.cursorXRatio !== null
    ? xAxis.formatCursor(scene.cursorXRatio)
    : scene.cursorDate
      ? formatCompositeTimeAxisDate(scene.cursorDate, scene.startTime, scene.endTime, scene.timeZone)
      : null;
  // The crosshair labels the moving end, so the axis only adds the anchor.
  const timeAxisMarkers = toolSpan
    ? [{
      ratio: toolSpan.startXRatio,
      label: formatCompositeTimeAxisDate(
        new Date(toolSpan.startTime),
        scene.startTime,
        scene.endTime,
        scene.timeZone,
      ),
      color: toolSpan.color,
    }]
    : undefined;
  return (
    <Box
      flexDirection="column"
      width={totalWidth}
      height={totalHeight}
      overflow="hidden"
      // The tool overlay anchors here; without it the desktop pins it to the page.
      position="relative"
      data-gloom-role="composite-chart"
    >
      {showLegend ? (
        <CompositeLegend
          scene={scene}
          series={visibleLegendSeries}
          visibleSeriesIds={visibleSeriesIds}
          width={totalWidth}
          accessory={legendAccessory}
          accessoryWidth={legendAccessoryWidth}
          formatValue={formatValue}
          showLatestChangePercent={showLatestChangePercent}
          onActivate={activateFromPointer}
          onToggleSeries={onToggleSeries}
          isSeriesToggleable={isSeriesToggleable}
          keyboardIndex={legendKeyboardIndex}
        />
      ) : null}
      {interactive && navigable && plotWidth > CHART_TOOLBAR_WIDTH + 4 ? (
        <ChartToolbar
          armedTool={armedTool}
          isDesktopWeb={isDesktopWeb}
          left={leftPadding}
          top={legendRows}
          drawColor={drawColor}
          showColors={isDrawingTool(armedTool) || !!selectedDrawingId}
          levelTool={levelsEditable}
          onArmTool={(tool) => {
            activateFromPointer();
            armTool(tool);
          }}
          onPickColor={(color) => {
            activateFromPointer();
            pickDrawColor(color);
          }}
        />
      ) : null}
      {paneInstanceId ? (
        <ChartDrawingStore
          paneInstanceId={paneInstanceId}
          drawings={drawings}
          onRestore={setDrawings}
        />
      ) : null}
      {scene.panels.map((panel) => (
        <CompositePanelSurface
          key={panel.id}
          panel={panel}
          scene={scene}
          plotWidth={plotWidth}
          leftAxisWidth={leftAxisWidth}
          rightAxisWidth={rightAxisWidth}
          axisGap={axisGap}
          colors={resolvedColors}
          interactive={interactive}
          navigable={navigable}
          formatAxisValue={formatAxisValue}
          remoteKind={remoteKind}
          viewport={effectiveViewport!}
          frame={navigationFrame!}
          armedTool={armedTool}
          drawings={drawings}
          selectedDrawingId={selectedDrawingId}
          drawColor={drawColor}
          onDraw={addDrawing}
          onEditDrawing={editDrawing}
          onSelectDrawing={setSelectedDrawingId}
          onActivate={activateFromPointer}
          onCursorDateChange={updateCursor}
          onPanViewport={panViewport}
          onZoomViewport={zoomViewport}
          onSetViewport={setViewportRange}
          onToolSpanChange={setToolSpan}
          keyboardToolDrag={keyboardToolDrag?.panelId === panel.id ? keyboardToolDrag : null}
          onPointerPress={cancelKeyboardPlacement}
          showTextFallback={showTextFallback}
          onPickTime={timePick?.onPick}
          levels={levelHost?.panel.id === panel.id ? levels ?? null : null}
          selectedLevelId={selectedLevelId}
          onSelectLevel={setSelectedLevelId}
        />
      ))}
      {watermarkScale ? (
        // Hidden until a screenshot reveals it (see utils/screenshot-watermark).
        // Above the opaque bitmaps, below drawings, crosshair and readouts.
        <Box
          position="absolute"
          left={leftPadding}
          top={legendRows}
          width={plotWidth}
          height={plotHeight}
          zIndex={5}
          alignItems="center"
          justifyContent="center"
          data-gloom-role={CHART_WATERMARK_ROLE}
        >
          <AsciiText text="Gloomberb" font="wordmark" scale={watermarkScale} color={resolvedColors.textDim} />
        </Box>
      ) : null}
      {xMarkers.length > 0 ? (
        <Box
          position="absolute"
          left={leftPadding}
          top={legendRows}
          width={plotWidth}
          height={plotHeight}
          zIndex={12}
          style={isDesktopWeb ? { pointerEvents: "none" } : undefined}
        >
          <StaticXMarkerOverlay
            markers={xMarkers}
            width={plotWidth}
            height={plotHeight}
            fallbackColor={resolvedColors.textDim}
          />
        </Box>
      ) : null}
      {timeAxisLayout ? (
        <Box flexDirection="row" width={totalWidth} height={1}>
          {leftPadding > 0 ? <Box width={leftPadding} /> : null}
          <StaticXAxisLabels
            labels={xAxis?.ticks ? [] : xAxis?.labels ? [...xAxis.labels] : [timeAxisLayout.text]}
            positionedLabels={xAxis?.ticks ?? (xAxis?.labels ? undefined : timeAxisLayout.ticks)}
            width={plotWidth}
            color={resolvedColors.textDim}
            cursorColumn={timeAxisCursorColumn}
            cursorPixelX={timeAxisCursorPixelX}
            cursorLabel={timeAxisCursorLabel}
            cursorColor={resolvedColors.crosshair}
            cursorBackgroundColor={resolvedColors.background}
            extraMarkers={timeAxisMarkers}
          />
          {rightPadding > 0 ? <Box width={rightPadding} /> : null}
        </Box>
      ) : null}
      {xMarkerRows > 0 ? (
        <Box flexDirection="row" width={totalWidth} height={1}>
          {leftPadding > 0 ? <Box width={leftPadding} /> : null}
          <StaticXMarkerLabels
            markers={xMarkers}
            width={plotWidth}
            fallbackColor={resolvedColors.textDim}
          />
          {rightPadding > 0 ? <Box width={rightPadding} /> : null}
        </Box>
      ) : null}
    </Box>
  );
}
