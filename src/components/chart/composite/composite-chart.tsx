import { useCallback, useMemo, useRef, useState } from "react";
import { useCompositeChartKeyboard } from "./use-composite-chart-keyboard";
import { useCompositeViewport } from "./use-composite-viewport";
import { CompositePanelSurface } from "./panel-surface";
import { MINIMUM_AXIS_LABEL_WIDTH, compositeAxisLabelWidth } from "./panel-labels";
import { isVerticalWheelDirection } from "./panel-gestures";
import { type ChartToolSpan, CHART_DRAWING_COLORS, isDrawingTool, type ChartDrawing } from "./tools";
import { ChartDrawingStore, NO_DRAWINGS } from "./drawing-store";
import { CompositeLegend } from "./legend";
import { ChartToolbar, CHART_TOOLBAR_WIDTH } from "./toolbar";
import { AsciiText, Box, ChartSurface, Text, useUiCapabilities } from "../../../ui";
import { useOptionalPaneInstanceId } from "../../../state/app/context";
import { useThemeColors } from "../../../theme/theme-context";
import { chartSurfaceBackground, usePaneSurface } from "../../layout/pane/surface";
import { CHART_WATERMARK_ROLE } from "../../../utils/screenshot-watermark";
import type { ResolvedSeries } from "../../../time-series/types";
import { downsampleCompositeChartScene } from "./downsample";
import { reuseResolvedSeriesList } from "./panel-series";
import { consumeChartMouseEvent, type ChartMouseEvent } from "../core/pointer";
import { useShowChartTextFallback } from "../native/use-chart-text-fallback";
import { StaticXAxisLabels, StaticXMarkerLabels, StaticXMarkerOverlay } from "./axis-overlays";
import { formatCompositeTimeAxisDate } from "./format";
import { resolveCompositeWheelPan, resolveCompositeWheelZoom } from "./interactions";
import { COMPOSITE_RIGHT_OFFSET_RATIO } from "./time-scale";
import {
  allocateCompositePanelHeights,
  applyCompositeChartCursor,
  buildCompositeChartScene,
  resizeCompositePanel,
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
  const {
    navigationFrame, activeUserViewport, effectiveViewport,
    panViewport, panViewportByRatio, zoomViewport, setViewportRange, resetViewport,
  } = useCompositeViewport({
    viewport, viewportResetKey, visibleSeries, marketTimelineSeries,
    allowHistoricalBackfill, onViewportChange,
  });
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
    updateCursor,
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
