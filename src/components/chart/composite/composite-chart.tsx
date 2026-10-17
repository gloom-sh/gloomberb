import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useCompositeChartKeyboard } from "./use-composite-chart-keyboard";
import { useCompositeViewport } from "./use-composite-viewport";
import { CompositePanelSurface } from "./panel-surface";
import { MINIMUM_AXIS_LABEL_WIDTH, compositeAxisLabelWidth } from "./panel-labels";
import { isVerticalWheelDirection } from "./panel-gestures";
import { type ChartToolSpan, CHART_DRAWING_COLORS, isDrawingTool, type ChartDrawing } from "./tools";
import { ChartDrawingStore, NO_DRAWINGS } from "./drawing-store";
import { CompositeLegend } from "./legend";
import { ChartToolbar, CHART_TOOLBAR_WIDTH } from "./toolbar";
import { AsciiText, Box, ChartSurface, Text, useUiCapabilities, type BoxRenderable } from "../../../ui";
import { useLiveStretch } from "../../../ui/live-stretch";
import { useOptionalPaneInstanceId } from "../../../state/app/context";
import { useTabCursorLink } from "../../../state/app/tab-cursor";
import { useThemeColors, useThemeId } from "../../../theme/theme-context";
import { themedSeriesColor, themeSeriesColors } from "../../../theme/series-colors";
import { assignSeriesLineCues } from "./series-cues";
import { chartSurfaceBackground, usePaneSurface } from "../../layout/pane/surface";
import { CHART_WATERMARK_ROLE } from "../../../utils/screenshot-watermark";
import type { ResolvedSeries } from "../../../time-series/types";
import { isIntradayResolution } from "../../../time-series/resolution";
import { downsampleCompositeChartScene } from "./downsample";
import { reuseResolvedSeriesList } from "./panel-series";
import { consumeChartMouseEvent, type ChartMouseEvent } from "../core/pointer";
import { useChartViewResetListener } from "../core/view-reset";
import { useShowChartTextFallback } from "../native/use-chart-text-fallback";
import { StaticXAxisLabels, StaticXMarkerLabels, StaticXMarkerOverlay } from "./axis-overlays";
import { formatCompositeCursorAxisDate } from "./format";
import { resolveCompositeWheelPan, resolveCompositeWheelZoom } from "./interactions";
import { COMPOSITE_RIGHT_OFFSET_RATIO } from "./time-scale";
import {
  allocateCompositePanelHeights,
  applyCompositeChartCursor,
  buildCompositeChartScene,
  compositeCursorAsOf,
  compositeLinkedCursorTime,
  resizeCompositePanel,
  resolveAdjacentCompositeCursorDate,
} from "./scene";
import { buildCompositeTimeAxisLayout, buildCompositeViewportTimeAxisLayout } from "./time-axis";
import type {
  CompositeChartColors,
  CompositeChartProps,
  CompositeChartScene,
  CompositeChartXMarker,
  CompositePanelScene,
} from "./types";

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

const NO_X_MARKERS: readonly CompositeChartXMarker[] = [];
const subscribeToNothing = () => () => {};
const holdsNothing = () => false;

/**
 * Desktop: the rows below the plot span the chart's box and their labels the
 * width the gutters leave, so when a resize draws the box at a new size
 * between renders, or CSS sizes it to the box it sits in (`useLiveStretch`),
 * they follow it by CSS. Otherwise they are the size the cells give them.
 */
const DESKTOP_FULL_ROW = { width: "100%" } as const;
const DESKTOP_PLOT_COLUMN = { flex: "1 1 0px", width: "auto", minWidth: 0 } as const;

/** Default-palette series in the theme's own palette, where it has one; the same list otherwise. */
function useThemedSeriesList(list: ResolvedSeries[], themeId: string): ResolvedSeries[];
function useThemedSeriesList(list: ResolvedSeries[] | undefined, themeId: string): ResolvedSeries[] | undefined;
function useThemedSeriesList(list: ResolvedSeries[] | undefined, themeId: string): ResolvedSeries[] | undefined {
  return useMemo(() => {
    if (!list || !themeSeriesColors(themeId)) return list;
    return list.map((entry) => {
      const color = themedSeriesColor(entry.color, themeId);
      return color === entry.color ? entry : { ...entry, color };
    });
  }, [list, themeId]);
}

export function CompositeChart(props: CompositeChartProps) {
  const themeId = useThemeId();
  const series = useThemedSeriesList(props.series, themeId);
  const legendSeries = useThemedSeriesList(props.legendSeries, themeId);
  return <ThemedCompositeChart {...props} series={series} legendSeries={legendSeries} />;
}

function ThemedCompositeChart({
  series,
  legendSeries,
  timelineSeries,
  panels,
  width,
  height,
  focused = false,
  cursorDate,
  cursorLink,
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
  const [toolSpan, setToolSpan] = useState<ChartToolSpan | null>(null);
  const paneInstanceId = useOptionalPaneInstanceId();
  const [drawings, setDrawings] = useState<readonly ChartDrawing[]>(NO_DRAWINGS);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [drawColor, setDrawColor] = useState<string>(CHART_DRAWING_COLORS[0]);
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
  // Assigned over the legend's list, hidden lines included, so toggling one
  // never restyles the rest.
  const cueSource = legendSeries ?? stableSeries;
  const cueKey = cueSource.map((entry) => `${entry.id}\u0000${entry.style}\u0000${entry.profile ? 1 : 0}`).join("\u0001");
  const cueSourceRef = useRef(cueSource);
  cueSourceRef.current = cueSource;
  // Keyed by ids and styles: a live tick hands over new series objects.
  const lineCues = useMemo(() => {
    void cueKey;
    return assignSeriesLineCues(cueSourceRef.current);
  }, [cueKey]);
  const {
    navigationFrame, activeUserViewport, effectiveViewport,
    panViewport, panViewportByRatio, zoomViewport, setViewportRange, resetViewport,
  } = useCompositeViewport({
    viewport, viewportResetKey, visibleSeries, marketTimelineSeries,
    allowHistoricalBackfill, onViewportChange,
  });
  // The pane's range control asks for this when its selected range is chosen again.
  useChartViewResetListener(resetViewport, interactive && navigable);
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
    return projectedScene.panels.map((panel) => {
      const resized = resizeCompositePanel(panel, panelHeights.get(panel.id) ?? 1, !fractionalViewport);
      return lineCues.size > 0 ? { ...resized, lineCues } : resized;
    });
  }, [fractionalViewport, lineCues, panels, plotHeight, projectedScene]);
  // Static overview charts also pin the latest price with cursor precision.
  const includeCursorLabels = interactive || cursorDate !== undefined || !!scenePanels?.some((panel) => panel.lastPrice);
  const includeSeriesTags = isDesktopWeb && (interactive || cursorDate !== undefined);
  const resolvedAxisWidth = useMemo(() => maximumAxisWidth === 0 ? 0 : Math.min(
    availableAxisWidth,
    Math.max(
      Math.min(MINIMUM_AXIS_LABEL_WIDTH, maximumAxisWidth),
      ...(layoutPanels ?? []).flatMap((panel) => (["left", "right"] as const).map((side) => {
        const width = compositeAxisLabelWidth(panel.axes[side], formatAxisValue, includeCursorLabels);
        if (!includeSeriesTags || !width) return includeCursorLabels ? width : Math.min(width, maximumAxisWidth);
        const count = panel.series.filter(({ source }) => source.axis === side && !source.hidden).length;
        const lanes = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(panel.height))));
        // Reserve the observation leaders and dense-panel lanes before hover,
        // so moving the crosshair never moves the plot or its time axis.
        return (width + 1) * lanes;
      })),
    ),
  ), [availableAxisWidth, formatAxisValue, includeCursorLabels, includeSeriesTags, layoutPanels, maximumAxisWidth]);
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
  // A custom x axis is not time, so there is no time to share. Otherwise an
  // interactive chart in a pane shares its crosshair with every chart in the
  // pane's layout tab, its siblings in the pane included: each chart is its
  // own source, so they never take turns. A chart that stops taking the
  // pointer for a while (under a dialog) keeps its place, so a cursor it
  // holds stays shared. Only an interactive chart shows the tab's pin and
  // lifts it, so only one counts toward keeping it.
  const chartId = useId();
  const tabLink = useTabCursorLink(
    cursorLink === undefined && !xAxis && paneInstanceId !== null ? `${paneInstanceId}${chartId}` : null,
    { viewer: interactive },
  );
  const link = xAxis ? undefined
    : cursorLink === undefined ? interactive ? tabLink : undefined
      : cursorLink ?? undefined;
  const subscribeToLink = link?.subscribe ?? subscribeToNothing;
  const sharedTime = link?.time;
  // Charts sharing a cursor show one: another chart's while it holds it, in
  // place of this one's own. An owner's resting cursor, such as a table's
  // selected row, comes back when it clears. A chart renders again when the
  // bar the shared cursor lands on here changes, not on every move: a daily
  // chart under a 30-minute one's cursor moves once a session.
  const showsSharedCursor = useSyncExternalStore(subscribeToLink, useCallback(() => sharedTime?.() != null, [sharedTime]));
  const sharedCursorBar = useSyncExternalStore(subscribeToLink, useCallback(() => {
    const time = sharedTime?.() ?? null;
    return time === null || !baseScene ? null : compositeLinkedCursorTime(baseScene, time);
  }, [baseScene, sharedTime]));
  const holdsSharedCursor = useSyncExternalStore(subscribeToLink, link?.held ?? holdsNothing);
  const pinnedCursor = useSyncExternalStore(subscribeToLink, link?.pinned ?? holdsNothing);
  const publishCursor = link?.publish;
  const scene = useMemo(() => {
    if (!baseScene) return null;
    if (showsSharedCursor) {
      return applyCompositeChartCursor(baseScene, sharedCursorBar === null ? null : new Date(sharedCursorBar), "linked");
    }
    return applyCompositeChartCursor(
      baseScene,
      normalizedCursorTimestamp === null ? null : new Date(normalizedCursorTimestamp),
    );
  }, [baseScene, normalizedCursorTimestamp, sharedCursorBar, showsSharedCursor]);
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
    publishCursor?.(date && baseScene && nextTimestamp !== null ? compositeCursorAsOf(baseScene, date) : null);
  }, [baseScene, cursorDate, onCursorDateChange, publishCursor]);
  // Another chart taking the cursor, or clearing it, takes it from this one,
  // so it does not come back here later. Read live: a move since the render
  // makes this chart's cursor the shared one again.
  useEffect(() => {
    void holdsSharedCursor;
    if (!link || cursorDate !== undefined || lastCursorTimestampRef.current === null || link.held()) return;
    updateCursor(null);
  }, [cursorDate, holdsSharedCursor, link, updateCursor]);
  // Esc on a chart showing another chart's cursor clears it, as on that chart.
  // While the tab's cursor is pinned the arrows move the pin and Esc unpins it.
  const updateKeyboardCursor = useCallback((date: Date | null) => {
    if (link?.pinned?.()) {
      link.pin?.(date && baseScene ? compositeCursorAsOf(baseScene, date) : null);
      return;
    }
    if (date === null && showsSharedCursor) link?.clear();
    updateCursor(date);
  }, [baseScene, link, showsSharedCursor, updateCursor]);
  // `p` pins the crosshair where it is, this chart's own or another's, so
  // every chart in the tab holds that moment after the pointer leaves.
  // Another chart's is pinned at its own moment, not at the bar it lands on
  // here, so a daily chart pins an intraday chart's minute. With no crosshair
  // it pins the last one shown (the pointer leaves the plot on its way to the
  // footer's pin), and before any, the latest bar, where the arrows start.
  // The last time sits in a ref, so a moving crosshair costs no extra render,
  // and the footer's pin is there from the start: a hint appearing mid-hover
  // would move the plot under the pointer.
  const cursorAt = scene?.cursorDate?.getTime() ?? null;
  const lastCursorAtRef = useRef<{ time: number; shared: boolean } | null>(null);
  if (cursorAt !== null) {
    const shared = showsSharedCursor ? sharedTime?.() ?? null : null;
    lastCursorAtRef.current = shared !== null ? { time: shared, shared: true } : { time: cursorAt, shared: false };
  }
  const pinnable = !!link?.pin;
  const togglePin = useCallback(() => {
    if (!link?.pin) return;
    if (link.pinned?.()) {
      link.pin(null);
      return;
    }
    const live = link.time();
    if (live !== null) {
      link.pin(live);
      return;
    }
    if (!baseScene) return;
    const last = lastCursorAtRef.current;
    if (last?.shared) {
      link.pin(last.time);
      return;
    }
    const date = last ? new Date(last.time) : resolveAdjacentCompositeCursorDate(baseScene, null, -1);
    if (date) link.pin(compositeCursorAsOf(baseScene, date));
  }, [baseScene, link]);

  const {
    armedTool,
    armTool,
    cancelKeyboardPlacement,
    activateFromPointer,
    legendKeyboardIndex,
    levelHost,
    levelsEditable,
    selectedLevelId,
    setSelectedLevelId,
    keyboardToolDrag,
  } = useCompositeChartKeyboard({
    focused,
    interactive,
    navigable,
    showLegend,
    scene,
    cursorDate,
    updateCursor: updateKeyboardCursor,
    pin: pinnable ? { pinned: pinnedCursor, toggle: togglePin } : null,
    onActivate,
    timePick,
    levels,
    visibleLegendSeries,
    visibleSeriesIds,
    onToggleSeries,
    isSeriesToggleable,
    navigationFrame,
    activeUserViewport,
    panViewportByRatio,
    zoomViewport,
    setViewportRange,
    resetViewport,
    drawings,
    selectedDrawingId,
    setSelectedDrawingId,
    drawColor,
    addDrawing,
    removeDrawing,
    pickDrawColor,
  });
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

  const leftPadding = leftAxisWidth + (leftAxisWidth ? axisGap : 0);
  const rightPadding = rightAxisWidth + (rightAxisWidth ? axisGap : 0);
  // The axis's ticks do not move with the cursor, so they are laid out once per chart, not per move.
  const timeAxisLayout = useMemo(
    () => baseScene && showTimeAxis ? buildCompositeTimeAxisLayout(baseScene, plotWidth) : null,
    [baseScene, plotWidth, showTimeAxis],
  );
  const emptyTimeAxisLayout = !scene && showTimeAxis && effectiveViewport
    ? buildCompositeViewportTimeAxisLayout(effectiveViewport, plotWidth)
    : null;

  // On the desktop the chart takes the box it sits in (a fraction of a cell
  // past its cells) and follows a resize by CSS where the boxes above it do;
  // elsewhere, while a resize has the pane ahead of this size, the chart's
  // box takes the size it will render at, the plot takes what the gutters
  // leave, and its bitmap stretches with it until the chart renders there.
  const rootRef = useRef<BoxRenderable | null>(null);
  useLiveStretch(rootRef, totalWidth, totalHeight);
  // Overlays over the plot keep the gutters around it rather than its size.
  const plotInsetStyle = isDesktopWeb
    ? { width: "auto", height: "auto", right: `calc(${rightPadding} * var(--cell-w))`, bottom: `calc(${timeAxisRows + xMarkerRows} * var(--cell-h))` }
    : undefined;

  if (!scene) {
    const emptyPlotHeight = Math.max(0, totalHeight - legendRows - timeAxisRows - xMarkerRows);
    return (
      <Box
        ref={rootRef}
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
          <Box
            flexDirection="row"
            width={totalWidth}
            height={emptyPlotHeight}
            style={isDesktopWeb ? { width: "100%", flex: "1 1 0px", height: "auto", minHeight: 0 } : undefined}
          >
            {leftPadding > 0 ? <Box width={leftPadding} /> : null}
            <ChartSurface
              width={plotWidth}
              height={emptyPlotHeight}
              style={isDesktopWeb ? { ...DESKTOP_PLOT_COLUMN, height: "auto", alignSelf: "stretch" } : undefined}
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
          <Box flexDirection="row" width={totalWidth} height={1} style={isDesktopWeb ? DESKTOP_FULL_ROW : undefined}>
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

  const showToolbar = interactive && navigable && plotWidth > CHART_TOOLBAR_WIDTH + 4;
  // Bars shorter than a day carry a time of day the cursor reads out.
  const intradayBars = scene.timeZone !== undefined || visibleSeries.some((entry) => (
    !!entry.historyResolution && isIntradayResolution(entry.historyResolution)
  ));
  const timeAxisCursorColumn = scene.cursorXRatio === null
    ? null
    : scene.cursorXRatio * Math.max(plotWidth - 1, 0);
  const timeAxisCursorPixelX = timeAxisCursorColumn === null
    ? null
    : timeAxisCursorColumn * cellWidthPx;
  const timeAxisCursorLabel = xAxis?.formatCursor && scene.cursorXRatio !== null
    ? xAxis.formatCursor(scene.cursorXRatio)
    : scene.cursorDate
      ? formatCompositeCursorAxisDate(scene.cursorDate, scene.startTime, scene.endTime, scene.timeZone, intradayBars)
      : null;
  // The crosshair labels the moving end, so the axis only adds the anchor.
  const timeAxisMarkers = toolSpan
    ? [{
      ratio: toolSpan.startXRatio,
      label: formatCompositeCursorAxisDate(
        new Date(toolSpan.startTime),
        scene.startTime,
        scene.endTime,
        scene.timeZone,
        intradayBars,
      ),
      color: toolSpan.color,
    }]
    : undefined;
  return (
    <Box
      ref={rootRef}
      flexDirection="column"
      width={totalWidth}
      height={totalHeight}
      overflow="hidden"
      // The tool overlay anchors here; without it the desktop pins it to the page.
      position="relative"
      data-gloom-role="composite-chart"
      // Where the view and the loaded bars start and end, in epoch ms, for checks that move it.
      data-gloom-view={effectiveViewport ? `${effectiveViewport.start.getTime()}:${effectiveViewport.end.getTime()}` : undefined}
      data-gloom-data={navigationFrame ? `${navigationFrame.dataStart}:${navigationFrame.dataEnd}` : undefined}
    >
      {showLegend ? (
        <CompositeLegend
          // Every series' value at the crosshair, the latest ones when the
          // pointer leaves; the price and the time under it sit on the axes.
          scene={scene}
          series={visibleLegendSeries}
          visibleSeriesIds={visibleSeriesIds}
          lineCues={lineCues}
          cellPlot={showTextFallback && !isDesktopWeb}
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
      {showToolbar ? (
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
          sharedCursor={showsSharedCursor}
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
        // Above the opaque bitmaps, below drawings and the crosshair.
        <Box
          position="absolute"
          left={leftPadding}
          top={legendRows}
          width={plotWidth}
          height={plotHeight}
          zIndex={5}
          alignItems="center"
          justifyContent="center"
          style={plotInsetStyle}
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
          style={isDesktopWeb ? { ...plotInsetStyle, pointerEvents: "none" } : undefined}
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
        <Box flexDirection="row" width={totalWidth} height={1} style={isDesktopWeb ? DESKTOP_FULL_ROW : undefined}>
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
        <Box flexDirection="row" width={totalWidth} height={1} style={isDesktopWeb ? DESKTOP_FULL_ROW : undefined}>
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
