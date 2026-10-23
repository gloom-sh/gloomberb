import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useCompositeChartKeyboard } from "./use-composite-chart-keyboard";
import { useCompositeViewport } from "./use-composite-viewport";
import { CompositePanelSurface } from "./panel-surface";
import { MINIMUM_AXIS_LABEL_WIDTH, compositeAxisLabelWidth } from "./panel-labels";
import { AXIS_DOUBLE_PRESS_MS, isVerticalWheelDirection } from "./panel-gestures";
import { type ChartToolSpan, CHART_DRAWING_COLORS, isDrawingTool, type ChartDrawing } from "./tools";
import { ChartDrawingStore, NO_DRAWINGS } from "./drawing-store";
import { CompositeLegend } from "./legend";
import { ChartToolbar, CHART_TOOLBAR_WIDTH } from "./toolbar";
import { AsciiText, Box, ChartSurface, Text, useUiCapabilities, type BoxRenderable } from "../../../ui";
import { Button } from "../../ui/button";
import { useLiveStretch } from "../../../ui/live-stretch";
import { useOptionalPaneInstanceId, usePaneSettingValue } from "../../../state/app/context";
import {
  CHART_LAYOUT_SETTING_KEY,
  NO_CHART_LAYOUT,
  draggedPanelWeights,
  minimumPanelRows,
  parseChartLayoutPrefs,
  patchChartLayout,
  stepTopPanel,
  type ChartLayoutPrefs,
} from "./chart-layout";
import { usePaneFocused } from "../../../state/app/activity";
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
import {
  resolveCompositeWheelPan,
  resolveCompositeWheelZoom,
  type CompositeNavigationFrame,
  type CompositeViewportRange,
} from "./interactions";
import { NO_VALUE_SCALES, resolveAxisDragSpanFactor } from "./value-scale";
import { useCompositeValueScales } from "./use-composite-value-scales";
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

/** The most lines a legend wraps to, and the plot rows each panel keeps when it does. */
const MAX_LEGEND_ROWS = 3;
const MIN_PANEL_ROWS_BESIDE_WRAPPED_LEGEND = 4;

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
/** The button on a panel that has the whole plot. */
const RESTORE_PANELS_LABEL = "All panels";
/** The time axis row where a drag on it zooms time. */
const TIME_AXIS_ROW = { ...DESKTOP_FULL_ROW, cursor: "ew-resize" } as const;

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

/** A line broken between its " · " parts to fit `width` cells, each part kept whole. */
function centeredLines(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const part of text.split(" · ")) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 3 + part.length <= width) lines[lines.length - 1] = `${last} · ${part}`;
    else lines.push(part);
  }
  return lines;
}

type ChartLayoutUpdate = (update: (layout: ChartLayoutPrefs) => ChartLayoutPrefs) => void;
type ChartLayoutChild = (layout: ChartLayoutPrefs, update: ChartLayoutUpdate) => ReactNode;

/** A chart in a pane keeps its layout in the pane's settings, read as it renders so it never paints twice. */
function PaneChartLayout({ paneInstanceId, children }: { paneInstanceId: string; children: ChartLayoutChild }) {
  const [stored, setStored] = usePaneSettingValue<unknown>(CHART_LAYOUT_SETTING_KEY, undefined, paneInstanceId);
  const layout = useMemo(() => parseChartLayoutPrefs(stored), [stored]);
  const update = useCallback<ChartLayoutUpdate>((change) => {
    setStored((current: unknown) => {
      const previous = parseChartLayoutPrefs(current);
      const next = change(previous);
      if (next === previous) return current;
      return next === NO_CHART_LAYOUT ? undefined : next;
    });
  }, [setStored]);
  return <>{children(layout, update)}</>;
}

/** A chart outside a pane (a share page) keeps its layout while it is mounted. */
function LocalChartLayout({ children }: { children: ChartLayoutChild }) {
  const [layout, setLayout] = useState<ChartLayoutPrefs>(NO_CHART_LAYOUT);
  const update = useCallback<ChartLayoutUpdate>((change) => setLayout(change), []);
  return <>{children(layout, update)}</>;
}

export function CompositeChart(props: CompositeChartProps) {
  const themeId = useThemeId();
  const series = useThemedSeriesList(props.series, themeId);
  const legendSeries = useThemedSeriesList(props.legendSeries, themeId);
  const paneInstanceId = useOptionalPaneInstanceId();
  const chart: ChartLayoutChild = (layout, update) => (
    <ThemedCompositeChart {...props} series={series} legendSeries={legendSeries} chartLayout={layout} onChartLayoutChange={update} />
  );
  return paneInstanceId
    ? <PaneChartLayout paneInstanceId={paneInstanceId}>{chart}</PaneChartLayout>
    : <LocalChartLayout>{chart}</LocalChartLayout>;
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
  emptyDetail,
  formatValue,
  onCursorDateChange,
  onViewportChange,
  onActivate,
  onPress,
  onToggleSeries,
  isSeriesToggleable,
  timePick,
  pricePick,
  levels,
  chartLayout,
  onChartLayoutChange,
}: CompositeChartProps & { chartLayout: ChartLayoutPrefs; onChartLayoutChange: ChartLayoutUpdate }) {
  const activeThemeColors = useThemeColors();
  const { cellWidthPx = 8, cellHeightPx = 18, pixelRatio = 1, fractionalViewport = false } = useUiCapabilities();
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const showTextFallback = useShowChartTextFallback();
  const [internalCursorDate, setInternalCursorDate] = useState<Date | null>(null);
  const [toolSpan, setToolSpan] = useState<ChartToolSpan | null>(null);
  const [pointerDragging, setPointerDragging] = useState(false);
  const paneFocused = usePaneFocused();
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
  // A cursor the owner rests on without following its moves (a seasonal
  // chart's latest week) is where the chart's own cursor goes back to: the
  // pointer moves it as on any chart, and the pointer leaving returns it.
  const restingCursor = cursorDate !== undefined && !onCursorDateChange;
  const ownsCursor = cursorDate === undefined || restingCursor;
  const resolvedCursorDate = cursorDate === undefined ? internalCursorDate
    : restingCursor ? internalCursorDate ?? cursorDate : cursorDate;
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
    navigationFrame, activeUserViewport, effectiveViewport, authoredViewportChanged, authoredGeneration,
    panViewport, panViewportByRatio, zoomViewport, setViewportRange, resetViewport,
  } = useCompositeViewport({
    viewport, viewportResetKey, visibleSeries, marketTimelineSeries,
    allowHistoricalBackfill, onViewportChange,
  });
  // Values scaled by hand belong to the view they were scaled in: a new
  // authored view (another range, another listing) fits them again.
  const { valueScales: heldValueScales, setValueScale, resetPanelValueScale, resetValueScales } = useCompositeValueScales(authoredGeneration);
  const valueScales = authoredViewportChanged ? NO_VALUE_SCALES : heldValueScales;
  const scaledByHand = valueScales !== NO_VALUE_SCALES && Object.keys(valueScales).length > 0;
  // `0`, Reset Zoom and choosing the range again put both axes back.
  const resetView = useCallback(() => {
    resetViewport();
    resetValueScales();
  }, [resetValueScales, resetViewport]);
  // The pane's range control asks for this when its selected range is chosen again.
  useChartViewResetListener(resetView, interactive);
  const timeAxisRows = showTimeAxis ? 1 : 0;
  const xMarkers = xAxis?.markers ?? NO_X_MARKERS;
  const xMarkerRows = xMarkers.some((marker) => marker.label) ? 1 : 0;
  const panelCount = new Set(panelSeries.map((entry) => entry.panelId)).size;
  // One legend line, or up to a few when its entries cannot share one and each
  // panel keeps a readable plot: the legend says how many it needs while no
  // cursor moves its values.
  const [legendWantedRows, setLegendWantedRows] = useState(1);
  const legendRoom = totalHeight - timeAxisRows - xMarkerRows - MIN_PANEL_ROWS_BESIDE_WRAPPED_LEGEND * Math.max(1, panelCount);
  const legendRows = showLegend && (visibleSeries.length > 0 || legendAccessory)
    ? Math.max(1, Math.min(legendWantedRows, MAX_LEGEND_ROWS, legendRoom))
    : 0;
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
      valueScales,
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
    valueScales,
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
  // Heights a drag is setting, shown before they are kept.
  const [draftPanelWeights, setDraftPanelWeights] = useState<Readonly<Record<string, number>> | null>(null);
  const panelWeights = draftPanelWeights ?? chartLayout.panelWeights;
  useEffect(() => setDraftPanelWeights(null), [chartLayout.panelWeights]);
  // A panel given the whole plot, while the chart still has it and another.
  const maximizedPanelId = projectedScene && projectedScene.panels.length > 1
    && projectedScene.panels.some((panel) => panel.id === chartLayout.maximizedPanelId)
    ? chartLayout.maximizedPanelId ?? null
    : null;
  const layoutPanels = useMemo<CompositePanelScene[] | null>(() => {
    if (!projectedScene) return null;
    const panelSpecById = new Map(panels.map((panel) => [panel.id, panel] as const));
    const shown = maximizedPanelId
      ? projectedScene.panels.filter((panel) => panel.id === maximizedPanelId)
      : projectedScene.panels;
    const panelHeights = allocateCompositePanelHeights(
      shown.map((panel) => ({
        id: panel.id,
        height: panelWeights?.[panel.id] ?? panelSpecById.get(panel.id)?.height,
      })),
      plotHeight,
    );
    // Terminal labels snap to rows; a fractional viewport places them exactly.
    return shown.map((panel) => {
      const resized = resizeCompositePanel(panel, panelHeights.get(panel.id) ?? 1, !fractionalViewport);
      return lineCues.size > 0 ? { ...resized, lineCues } : resized;
    });
  }, [fractionalViewport, lineCues, maximizedPanelId, panelWeights, panels, plotHeight, projectedScene]);
  // What a resize starts from: each shown panel's rows, and the weights they share.
  const panelLayoutRef = useRef<{ rows: { id: string; rows: number; weight: number }[]; weightTotal: number }>({ rows: [], weightTotal: 0 });
  {
    const rows = (layoutPanels ?? []).map((panel) => {
      const weight = panelWeights?.[panel.id] ?? panels.find((spec) => spec.id === panel.id)?.height;
      return { id: panel.id, rows: panel.height, weight: typeof weight === "number" && Number.isFinite(weight) && weight > 0 ? weight : 1 };
    });
    panelLayoutRef.current = { rows, weightTotal: rows.reduce((sum, entry) => sum + entry.weight, 0) };
  }
  // Static overview charts also pin the latest price with cursor precision.
  const includeCursorLabels = interactive || cursorDate !== undefined || !!scenePanels?.some((panel) => panel.lastPrice);
  const includeSeriesTags = isDesktopWeb && (interactive || cursorDate !== undefined);
  const resolvedAxisWidth = useMemo(() => maximumAxisWidth === 0 ? 0 : Math.min(
    availableAxisWidth,
    Math.max(
      Math.min(MINIMUM_AXIS_LABEL_WIDTH, maximumAxisWidth),
      ...(levels?.items ?? []).map((level) => level.axisLabel?.length ?? 0),
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
  ), [availableAxisWidth, formatAxisValue, includeCursorLabels, includeSeriesTags, layoutPanels, maximumAxisWidth, levels?.items]);
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
      // A panel with the whole plot still leaves the legend every series' value.
      ...(maximizedPanelId ? { cursorPanels: projectedScene.panels } : {}),
    };
    return downsampleCompositeChartScene(laidOut, downsampleWidth);
  }, [downsampleWidth, layoutPanels, maximizedPanelId, plotWidth, projectedScene]);
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
    if (ownsCursor) setInternalCursorDate(date);
    onCursorDateChange?.(date);
    publishCursor?.(date && baseScene && nextTimestamp !== null ? compositeCursorAsOf(baseScene, date) : null);
  }, [baseScene, onCursorDateChange, ownsCursor, publishCursor]);
  // Another chart taking the cursor, or clearing it, takes it from this one,
  // so it does not come back here later. Read live: a move since the render
  // makes this chart's cursor the shared one again.
  useEffect(() => {
    void holdsSharedCursor;
    if (!link || !ownsCursor || lastCursorTimestampRef.current === null || link.held()) return;
    updateCursor(null);
  }, [holdsSharedCursor, link, ownsCursor, updateCursor]);
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

  // The layout the user leaves the chart in: kept with the pane, through the
  // latest values, so a handler bound once still acts on what is on screen.
  const layoutStateRef = useRef({ chartLayout, maximizedPanelId, onChartLayoutChange });
  layoutStateRef.current = { chartLayout, maximizedPanelId, onChartLayoutChange };
  const patchLayout = useCallback((patch: ChartLayoutPrefs | ((layout: ChartLayoutPrefs) => ChartLayoutPrefs)) => {
    layoutStateRef.current.onChartLayoutChange((layout) => patchChartLayout(layout, typeof patch === "function" ? patch(layout) : patch));
  }, []);
  // The tool in hand, read when the bar is toggled (the keyboard hook below holds it).
  const toolInHandRef = useRef<{ armed: boolean; putDown: () => void }>({ armed: false, putDown: () => {} });
  // Shift+T and the chevrons act on the bar as it shows: a bar open only for
  // the tool in hand folds again, the tool put down, and stays hidden.
  const toggleToolbar = useCallback(() => {
    const tool = toolInHandRef.current;
    const hidden = layoutStateRef.current.chartLayout.toolbarHidden === true && !tool.armed;
    if (!hidden && tool.armed) tool.putDown();
    patchLayout({ toolbarHidden: !hidden });
  }, [patchLayout]);
  const toggleLegendCollapsed = useCallback(() => patchLayout((layout) => ({ legendCollapsed: !layout.legendCollapsed })), [patchLayout]);
  const resetPanelHeights = useCallback(() => {
    setDraftPanelWeights(null);
    patchLayout({ panelWeights: undefined });
  }, [patchLayout]);
  const resetPanelMaximized = useCallback(() => patchLayout({ maximizedPanelId: undefined }), [patchLayout]);
  const togglePanelMaximized = useCallback((panelId: string) => {
    const maximized = layoutStateRef.current.maximizedPanelId;
    patchLayout({ maximizedPanelId: maximized === panelId ? undefined : panelId });
  }, [patchLayout]);
  // A panel given the whole plot is let go once the chart no longer has it, so
  // it never comes back maximized, and when a panel is added beside it, so the
  // new one shows. The chart's panels are the ones it is given and the ones
  // its series bring; a panel whose data is loading is still given.
  const chartPanelIds = useMemo(() => {
    const ids = new Set(panels.map((panel) => panel.id));
    for (const panel of projectedScene?.panels ?? []) ids.add(panel.id);
    return [...ids].join("\u0000");
  }, [panels, projectedScene]);
  const seenPanelIdsRef = useRef<readonly string[] | null>(null);
  const savedMaximizedPanelId = chartLayout.maximizedPanelId;
  const chartDrawn = projectedScene !== null;
  useEffect(() => {
    const ids = chartPanelIds ? chartPanelIds.split("\u0000") : [];
    const previous = seenPanelIdsRef.current;
    seenPanelIdsRef.current = ids;
    if (!savedMaximizedPanelId) return;
    const gone = chartDrawn && !ids.includes(savedMaximizedPanelId);
    const added = !!previous && previous.length > 1 && previous.includes(savedMaximizedPanelId)
      && ids.some((id) => !previous.includes(id));
    if (gone || added) patchLayout({ maximizedPanelId: undefined });
  }, [chartDrawn, chartPanelIds, patchLayout, savedMaximizedPanelId]);
  // Shift+Up and Shift+Down: the top panel a row taller or shorter.
  const stepTopPanelRows = useCallback((direction: 1 | -1) => {
    const { rows } = panelLayoutRef.current;
    const plotRows = rows.reduce((sum, entry) => sum + entry.rows, 0);
    const weight = stepTopPanel(rows, direction, minimumPanelRows(plotRows, rows.length));
    const top = rows[0];
    if (weight === null || !top) return;
    patchLayout((layout) => ({ panelWeights: { ...layout.panelWeights, [top.id]: weight } }));
  }, [patchLayout]);
  const legendCollapsible = showLegend && visibleLegendSeries.length > 1;
  const legendCollapsed = legendCollapsible && chartLayout.legendCollapsed === true;
  const projectedPanelCount = projectedScene?.panels.length ?? 0;
  const layoutControls = useMemo(() => ({
    toolbarHidden: chartLayout.toolbarHidden === true,
    toggleToolbar,
    legendCollapsible,
    legendCollapsed,
    toggleLegend: toggleLegendCollapsed,
    panelsResizable: (layoutPanels?.length ?? 0) > 1,
    stepTopPanel: stepTopPanelRows,
    panelHeightsSet: projectedPanelCount > 1 && !!chartLayout.panelWeights,
    resetPanelHeights,
    panelMaximized: !!maximizedPanelId,
    restorePanels: resetPanelMaximized,
  }), [
    chartLayout.panelWeights,
    chartLayout.toolbarHidden,
    layoutPanels?.length,
    legendCollapsed,
    legendCollapsible,
    maximizedPanelId,
    projectedPanelCount,
    resetPanelHeights,
    resetPanelMaximized,
    stepTopPanelRows,
    toggleLegendCollapsed,
    toggleToolbar,
  ]);

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
    pricePick,
    levels,
    visibleLegendSeries,
    visibleSeriesIds,
    onToggleSeries,
    isSeriesToggleable,
    navigationFrame,
    activeUserViewport,
    scaledByHand,
    panViewportByRatio,
    zoomViewport,
    setViewportRange,
    resetViewport: resetView,
    drawings,
    selectedDrawingId,
    setSelectedDrawingId,
    drawColor,
    addDrawing,
    removeDrawing,
    pickDrawColor,
    layout: layoutControls,
  });
  toolInHandRef.current = { armed: armedTool !== null, putDown: () => armTool(null) };
  const pressFromPointer = useCallback(() => {
    onPress?.();
    activateFromPointer();
  }, [activateFromPointer, onPress]);
  const pressPlot = useCallback(() => {
    cancelKeyboardPlacement();
    onPress?.();
  }, [cancelKeyboardPlacement, onPress]);
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

  // The time axis under the pointer: a drag zooms time from the newest bar
  // in view, in (left) or out (right), as +/- do; a double click resets it.
  const timeScalable = interactive && navigable && !!navigationFrame && !xAxis;
  const timeAxisGestureRef = useRef<{
    startColumn: number;
    frame: CompositeNavigationFrame;
    from: CompositeViewportRange;
    moved: boolean;
  } | null>(null);
  const lastTimeAxisPressRef = useRef<number | null>(null);
  const latestTimeAxisRef = useRef({ navigationFrame, effectiveViewport, resetViewport, zoomViewport, activateFromPointer, cellWidthPx });
  latestTimeAxisRef.current = { navigationFrame, effectiveViewport, resetViewport, zoomViewport, activateFromPointer, cellWidthPx };
  const timeAxisGestures = useMemo(() => {
    if (!timeScalable) return undefined;
    const column = (event: ChartMouseEvent) => typeof event.preciseX === "number" ? event.preciseX : event.x;
    const release = () => {
      timeAxisGestureRef.current = null;
    };
    return {
      onMouseDown: (event: ChartMouseEvent) => {
        const latest = latestTimeAxisRef.current;
        latest.activateFromPointer();
        consumeChartMouseEvent(event);
        const now = Date.now();
        const last = lastTimeAxisPressRef.current;
        const double = typeof event.detail === "number"
          ? event.detail >= 2
          : last !== null && now - last < AXIS_DOUBLE_PRESS_MS;
        if (double) {
          lastTimeAxisPressRef.current = null;
          timeAxisGestureRef.current = null;
          latest.resetViewport();
          return;
        }
        lastTimeAxisPressRef.current = now;
        timeAxisGestureRef.current = latest.navigationFrame && latest.effectiveViewport
          ? { startColumn: column(event), frame: latest.navigationFrame, from: latest.effectiveViewport, moved: false }
          : null;
      },
      onMouseDrag: (event: ChartMouseEvent) => {
        const gesture = timeAxisGestureRef.current;
        if (!gesture) return;
        consumeChartMouseEvent(event);
        const latest = latestTimeAxisRef.current;
        const deltaPx = (column(event) - gesture.startColumn) * latest.cellWidthPx;
        if (!gesture.moved && Math.abs(deltaPx) < 1) return;
        gesture.moved = true;
        lastTimeAxisPressRef.current = null;
        latest.zoomViewport(1 / resolveAxisDragSpanFactor(deltaPx), 1, { frame: gesture.frame, from: gesture.from });
      },
      onMouseUp: release,
      onMouseDragEnd: release,
    };
  }, [timeScalable]);

  // The line between two panels on the desktop and the web: a drag moves it a
  // row at a time, the panel above taking what the one below gives, and a
  // double click puts back the split the chart was made with.
  const [resizingPanelIndex, setResizingPanelIndex] = useState<number | null>(null);
  const panelResizeRef = useRef<{
    index: number;
    startPixelY: number;
    rows: { id: string; rows: number }[];
    weightTotal: number;
    weights: Readonly<Record<string, number>> | null;
  } | null>(null);
  const latestPanelResizeRef = useRef({ activateFromPointer, cellHeightPx });
  latestPanelResizeRef.current = { activateFromPointer, cellHeightPx };
  const panelsResizableByPointer = interactive && isDesktopWeb && !maximizedPanelId && (layoutPanels?.length ?? 0) > 1;
  const panelDividerGestures = useMemo(() => {
    if (!panelsResizableByPointer) return null;
    const release = () => {
      const gesture = panelResizeRef.current;
      panelResizeRef.current = null;
      setResizingPanelIndex(null);
      const weights = gesture?.weights;
      if (weights) patchLayout((layout) => ({ panelWeights: { ...layout.panelWeights, ...weights } }));
    };
    return (index: number) => ({
      onMouseDown: (event: ChartMouseEvent) => {
        latestPanelResizeRef.current.activateFromPointer();
        consumeChartMouseEvent(event);
        if ((event.detail ?? 0) >= 2) {
          panelResizeRef.current = null;
          setResizingPanelIndex(null);
          resetPanelHeights();
          return;
        }
        const { rows, weightTotal } = panelLayoutRef.current;
        panelResizeRef.current = { index, startPixelY: event.pixelY ?? 0, rows, weightTotal, weights: null };
        setResizingPanelIndex(index);
      },
      onMouseDrag: (event: ChartMouseEvent) => {
        const gesture = panelResizeRef.current;
        if (!gesture) return;
        consumeChartMouseEvent(event);
        const deltaRows = ((event.pixelY ?? gesture.startPixelY) - gesture.startPixelY) / Math.max(1, latestPanelResizeRef.current.cellHeightPx);
        const plotRows = gesture.rows.reduce((sum, entry) => sum + entry.rows, 0);
        // Back where it started, or never a row away, the line saves nothing.
        const weights = draggedPanelWeights(gesture, gesture.index, deltaRows, minimumPanelRows(plotRows, gesture.rows.length));
        gesture.weights = weights;
        setDraftPanelWeights(weights
          ? (current) => ({ ...(current ?? layoutStateRef.current.chartLayout.panelWeights), ...weights })
          : null);
      },
      onMouseUp: release,
      onMouseDragEnd: release,
    });
  }, [panelsResizableByPointer, patchLayout, resetPanelHeights]);

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
            onActivate={pressFromPointer}
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
              {emptyDetail ? (
                // The kit's empty state: the message dim, what to do about it muted under it.
                <Box flexDirection="column" alignItems="center">
                  <Text fg={resolvedColors.textDim}>{emptyMessage}</Text>
                  {centeredLines(emptyDetail, plotWidth - 2).map((line, index) => (
                    <Text key={index} fg={activeThemeColors.textMuted}>{line}</Text>
                  ))}
                </Box>
              ) : (
                <Text fg={resolvedColors.textDim}>{emptyMessage}</Text>
              )}
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

  // The tools belong to the focused pane, and stay while one is in hand or a
  // press drags the plot, so focus moving elsewhere never hides what is
  // drawing. A chart outside a pane (a share page) keeps them.
  const toolbarWanted = paneFocused !== false || armedTool !== null || pointerDragging || toolSpan !== null;
  const showToolbar = interactive && navigable && toolbarWanted && plotWidth > CHART_TOOLBAR_WIDTH + 4;
  // Hidden, the bar folds to the button that brings it back, and opens again
  // while a tool picked from the keys is in hand, so the plot says which one.
  const toolbarFolded = showToolbar && chartLayout.toolbarHidden === true && armedTool === null;
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
          onActivate={pressFromPointer}
          onToggleSeries={onToggleSeries}
          isSeriesToggleable={isSeriesToggleable}
          keyboardIndex={legendKeyboardIndex}
          rows={legendRows}
          onWantedRowsChange={setLegendWantedRows}
          collapsed={legendCollapsed}
          onToggleCollapsed={legendCollapsible && interactive ? () => {
            pressFromPointer();
            toggleLegendCollapsed();
          } : undefined}
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
          folded={toolbarFolded}
          onToggleFolded={() => {
            pressFromPointer();
            toggleToolbar();
          }}
          onArmTool={(tool) => {
            pressFromPointer();
            armTool(tool);
          }}
          onPickColor={(color) => {
            pressFromPointer();
            pickDrawColor(color);
          }}
        />
      ) : null}
      {maximizedPanelId && interactive ? (
        // A panel with the whole plot says so at its corner, as a value axis
        // scaled by hand does at its foot, and that is the way back.
        <Box
          position="absolute"
          left={leftPadding + Math.max(0, plotWidth - RESTORE_PANELS_LABEL.length - 1)}
          top={legendRows}
          width={RESTORE_PANELS_LABEL.length}
          height={1}
          zIndex={30}
          style={isDesktopWeb
            ? {
              left: "auto",
              right: `calc(${rightPadding} * var(--cell-w) + var(--gloom-space-xs))`,
              top: `calc(${legendRows} * var(--cell-h) + var(--gloom-space-xs))`,
              width: "auto",
              height: "auto",
            }
            : undefined}
          data-gloom-role="composite-chart-panels-restore"
        >
          <Button
            label="Show All Panels"
            displayLabel={RESTORE_PANELS_LABEL}
            title="One panel has the chart. Show every panel again (or double-click the plot)."
            variant="secondary"
            compact
            stopPropagation
            onPress={() => {
              pressFromPointer();
              resetPanelMaximized();
            }}
          />
        </Box>
      ) : null}
      {paneInstanceId ? (
        <ChartDrawingStore
          paneInstanceId={paneInstanceId}
          drawings={drawings}
          onRestore={setDrawings}
        />
      ) : null}
      {scene.panels.map((panel, index) => (
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
          onDragActiveChange={setPointerDragging}
          keyboardToolDrag={keyboardToolDrag?.panelId === panel.id ? keyboardToolDrag : null}
          onPointerPress={pressPlot}
          showTextFallback={showTextFallback}
          onPickTime={timePick?.onPick}
          onPickPrice={pricePick?.onPick}
          levels={levelHost?.panel.id === panel.id ? levels ?? null : null}
          selectedLevelId={selectedLevelId}
          onSelectLevel={setSelectedLevelId}
          valueScalable={interactive}
          onSetValueScale={setValueScale}
          onResetValueScale={resetPanelValueScale}
          dividerAbove={index > 0 && panelDividerGestures
            ? { active: resizingPanelIndex === index, gestures: panelDividerGestures(index) }
            : null}
          onToggleMaximized={interactive && navigable && projectedPanelCount > 1 ? () => togglePanelMaximized(panel.id) : undefined}
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
        <Box
          flexDirection="row"
          width={totalWidth}
          height={1}
          style={isDesktopWeb ? timeAxisGestures ? TIME_AXIS_ROW : DESKTOP_FULL_ROW : undefined}
          {...timeAxisGestures}
          data-gloom-interactive={timeAxisGestures ? "true" : undefined}
          data-gloom-role="composite-chart-time-scale"
        >
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
