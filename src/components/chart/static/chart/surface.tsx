import { useCallback, useMemo, useRef, useState } from "react";
import { Box, ChartSurface, Text, type BoxRenderable, type ChartSurfaceProps, useUiCapabilities } from "../../../../ui";
import { useThemeColors } from "../../../../theme/theme-context";
import { PriceAxisLabels } from "../../price-axis-labels";
import type { ProjectedChartPoint } from "../../core/data";
import {
  buildChartScene,
  computeGridLines,
  renderChart,
  type RenderChartOptions,
  type RenderChartResult,
} from "../../core/renderer";
import { renderNativeChartBase, type NativeChartBitmap } from "../../native/chart-rasterizer";
import { useShowChartTextFallback } from "../../native/use-chart-text-fallback";
import { useStaticChartBitmapSize } from "./bitmap";
import {
  StaticXAxisLabels,
  StaticXMarkerLabels,
  StaticXMarkerOverlay,
  clampRatio,
  type StaticChartXMarker,
} from "./axis-overlays";

export type { StaticChartXMarker } from "./axis-overlays";

export interface StaticChartSurfaceProps extends Omit<
  RenderChartOptions,
  "width" | "height" | "cursorX" | "cursorY" | "showVolume" | "volumeHeight"
> {
  points: ProjectedChartPoint[];
  width: number;
  height: number;
  showVolume?: boolean;
  volumeHeight?: number;
  showTimeAxis?: boolean;
  timeAxisColor?: string;
  xAxisLabels?: string[];
  xAxisColor?: string;
  formatXAxisCursorValue?: (xRatio: number) => string;
  xMarkers?: StaticChartXMarker[];
  yAxisLabel?: string;
  yAxisColor?: string;
  formatYAxisValue?: (value: number) => string;
  yAxisSide?: "left" | "right";
  yDomain?: { min: number; max: number };
}

interface ChartMouseEventLike {
  x: number;
  y: number;
  preciseX?: number;
  preciseY?: number;
  preventDefault?: () => void;
}

function localPlotPointer(
  event: ChartMouseEventLike,
  renderable: BoxRenderable | null,
): { x: number; y: number } | null {
  if (!renderable) return null;
  const originX = typeof renderable.absoluteX === "number"
    ? renderable.absoluteX
    : typeof renderable.x === "number"
      ? renderable.x
      : 0;
  const originY = typeof renderable.absoluteY === "number"
    ? renderable.absoluteY
    : typeof renderable.y === "number"
      ? renderable.y
      : 0;
  const rawX = typeof event.preciseX === "number" ? event.preciseX : event.x;
  const rawY = typeof event.preciseY === "number" ? event.preciseY : event.y;
  const x = rawX - originX;
  const y = rawY - originY;
  const width = typeof renderable.width === "number" ? renderable.width : 0;
  const height = typeof renderable.height === "number" ? renderable.height : 0;
  if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) return null;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  return {
    x: Math.max(0, Math.min(x, Math.max(width - 1, 0))),
    y: Math.max(0, Math.min(y, Math.max(height - 1, 0))),
  };
}

export function StaticChartSurface({
  points,
  width,
  height,
  mode,
  axisMode,
  currency,
  assetCategory,
  colors,
  timeAxisDates,
  indicators,
  showVolume = false,
  volumeHeight = 0,
  showTimeAxis = false,
  timeAxisColor,
  xAxisLabels,
  xAxisColor,
  formatXAxisCursorValue,
  xMarkers,
  yAxisLabel,
  yAxisColor,
  formatYAxisValue,
  yAxisSide = "right",
  yDomain,
}: StaticChartSurfaceProps) {
  const themeColors = useThemeColors();
  const { cellWidthPx = 8, cellHeightPx = 18 } = useUiCapabilities();
  const showTextFallback = useShowChartTextFallback();
  const plotRef = useRef<BoxRenderable | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const xAxisRows = showTimeAxis || (xAxisLabels?.length ?? 0) > 0 ? 1 : 0;
  const xMarkerRows = xMarkers?.some((marker) => marker.label) ? 1 : 0;
  const labelRows = yAxisLabel ? 1 : 0;
  const totalWidth = Math.max(1, Math.floor(width));
  const totalHeight = Math.max(1, Math.floor(height));
  const plotHeight = Math.max(1, totalHeight - xAxisRows - xMarkerRows - labelRows);
  const axisSourceOptions = useMemo<RenderChartOptions>(() => ({
    width: totalWidth,
    height: plotHeight,
    showVolume,
    volumeHeight,
    cursorX: null,
    cursorY: null,
    mode,
    axisMode,
    currency,
    assetCategory,
    colors,
    timeAxisDates,
    indicators,
    yDomain,
  }), [
    assetCategory,
    axisMode,
    colors,
    currency,
    indicators,
    mode,
    plotHeight,
    showVolume,
    timeAxisDates,
    totalWidth,
    volumeHeight,
    yDomain,
  ]);
  const axisScene = useMemo(
    () => buildChartScene(points, axisSourceOptions),
    [axisSourceOptions, points],
  );
  const customAxisLabels = useMemo(() => {
    if (!axisScene || !formatYAxisValue) return null;
    return computeGridLines(axisScene.min, axisScene.max, 0, axisScene.chartRows - 1, 3)
      .map((line) => ({
        row: Math.max(0, Math.min(axisScene.chartRows - 1, Math.round(line.y))),
        label: formatYAxisValue(line.price),
      }));
  }, [axisScene, formatYAxisValue]);
  const axisLabels = customAxisLabels ?? [];
  const axisWidth = axisLabels.length > 0
    ? Math.min(Math.max(...axisLabels.map((entry) => entry.label.length), 5), 12)
    : 0;
  const axisGap = axisWidth > 0 ? 1 : 0;
  const plotWidth = Math.max(1, totalWidth - axisWidth - axisGap);
  const bitmapSize = useStaticChartBitmapSize(plotWidth, plotHeight);
  const plotOptions = useMemo<RenderChartOptions>(() => ({
    width: plotWidth,
    height: plotHeight,
    showVolume,
    volumeHeight,
    cursorX: null,
    cursorY: null,
    mode,
    axisMode,
    currency,
    assetCategory,
    colors,
    timeAxisDates,
    indicators,
    yDomain,
  }), [
    assetCategory,
    axisMode,
    colors,
    currency,
    indicators,
    mode,
    plotHeight,
    plotWidth,
    showVolume,
    timeAxisDates,
    volumeHeight,
    yDomain,
  ]);
  const cursorOptions = useMemo<RenderChartOptions>(() => ({
    ...plotOptions,
    cursorX: cursor?.x ?? null,
    cursorY: cursor?.y ?? null,
  }), [cursor, plotOptions]);
  const plotScene = useMemo(
    () => buildChartScene(points, plotOptions),
    [plotOptions, points],
  );
  const cursorScene = useMemo(
    () => {
      if (showTextFallback || !cursor) return plotScene;
      return buildChartScene(points, cursorOptions);
    },
    [cursor, cursorOptions, plotScene, points, showTextFallback],
  );
  const textResult = useMemo<RenderChartResult>(() => {
    if (showTextFallback) return renderChart(points, cursorOptions);
    return {
      lines: [],
      axisLabels: [],
      timeLabels: cursorScene?.timeLabels ?? "",
      activePoint: cursorScene?.activePoint ?? null,
      priceAtCursor: cursorScene?.priceAtCursor ?? null,
      crosshairPrice: cursorScene?.crosshairPrice ?? null,
      dateAtCursor: cursorScene?.dateAtCursor ?? null,
      changeAtCursor: cursorScene?.changeAtCursor ?? null,
      changePctAtCursor: cursorScene?.changePctAtCursor ?? null,
      cursorColumn: cursorScene?.cursorColumn ?? null,
      cursorRow: cursorScene?.cursorRow ?? null,
      axisFractionDigits: null,
      priceRange: cursorScene ? cursorScene.max - cursorScene.min : null,
      pixelBuffer: null,
    };
  }, [cursorOptions, cursorScene, points, showTextFallback]);
  const effectiveAxisLabelsByRow = useMemo(() => {
    return new Map(axisLabels.map((entry) => [entry.row, entry.label] as const));
  }, [axisLabels]);
  const cursorAxisLabel = useMemo(() => {
    if (!formatYAxisValue || textResult.crosshairPrice === null) return null;
    return formatYAxisValue(textResult.crosshairPrice);
  }, [formatYAxisValue, textResult.crosshairPrice]);
  const cursorXAxisLabel = useMemo(() => {
    if (!formatXAxisCursorValue || !cursor) return null;
    return formatXAxisCursorValue(clampRatio(cursor.x / Math.max(plotWidth - 1, 1)));
  }, [cursor, formatXAxisCursorValue, plotWidth]);
  const effectiveAxisWidth = axisWidth;
  const effectiveAxisGap = effectiveAxisWidth > 0 ? 1 : 0;
  const bitmap = useMemo<NativeChartBitmap | null>(() => {
    if (!bitmapSize || !plotScene) return null;
    return renderNativeChartBase(plotScene, bitmapSize.pixelWidth, bitmapSize.pixelHeight);
  }, [bitmapSize, plotScene]);
  const canvasCrosshair = useMemo<ChartSurfaceProps["crosshair"]>(() => {
    if (!bitmap || !cursor) return null;
    return {
      pixelX: Math.round(clampRatio(cursor.x / Math.max(plotWidth - 1, 1)) * Math.max(bitmap.width - 1, 0)),
      pixelY: Math.round(clampRatio(cursor.y / Math.max(plotHeight - 1, 1)) * Math.max(bitmap.height - 1, 0)),
      color: colors.crosshairColor,
    };
  }, [bitmap, colors.crosshairColor, cursor, plotHeight, plotWidth]);
  const handleCursorEvent = useCallback((event: ChartMouseEventLike) => {
    const pointer = localPlotPointer(event, plotRef.current);
    if (!pointer) return;
    event.preventDefault?.();
    setCursor((current) => (
      current && current.x === pointer.x && current.y === pointer.y ? current : pointer
    ));
  }, []);
  const clearCursor = useCallback(() => {
    setCursor(null);
  }, []);

  const axisOnLeft = yAxisSide === "left";
  const priceAxis = effectiveAxisWidth > 0 ? (
    <PriceAxisLabels
      axisLabels={effectiveAxisLabelsByRow}
      axisWidth={effectiveAxisWidth}
      axisSectionWidth={effectiveAxisWidth}
      side={axisOnLeft ? "left" : undefined}
      height={plotHeight}
      cursorRow={textResult.cursorRow}
      cursorPixelY={cursor ? cursor.y * cellHeightPx : null}
      cursorLabel={cursorAxisLabel}
      cursorColor={colors.crosshairColor}
      axisColor={yAxisColor}
    />
  ) : null;
  const leftAxisSpacer = axisOnLeft && effectiveAxisWidth > 0 ? (
    <>
      <Box width={effectiveAxisWidth} />
      <Box width={effectiveAxisGap} />
    </>
  ) : null;
  const rightAxisSpacer = !axisOnLeft && effectiveAxisWidth > 0 ? (
    <>
      <Box width={effectiveAxisGap} />
      <Box width={effectiveAxisWidth} />
    </>
  ) : null;

  return (
    <Box flexDirection="column" width={totalWidth} height={plotHeight + xAxisRows + xMarkerRows + labelRows}>
      {yAxisLabel ? (
        <Box height={1}>
          <Text fg={yAxisColor}>{yAxisLabel}</Text>
        </Box>
      ) : null}
      <Box flexDirection="row" height={plotHeight}>
        {axisOnLeft && priceAxis ? (
          <>
            {priceAxis}
            <Box width={effectiveAxisGap} />
          </>
        ) : null}
        <Box
          ref={plotRef}
          position="relative"
          width={plotWidth}
          height={plotHeight}
          onMouseMove={handleCursorEvent}
          onMouseDown={handleCursorEvent}
          onMouseOut={clearCursor}
          data-gloom-role="static-chart-plot"
        >
          <ChartSurface
            width={plotWidth}
            height={plotHeight}
            flexDirection="column"
            bitmaps={bitmap ? [bitmap] : null}
            crosshair={canvasCrosshair}
            onMouseMove={handleCursorEvent}
            onMouseDown={handleCursorEvent}
            onMouseOut={clearCursor}
            data-gloom-remote-kind="static-chart"
          >
            {textResult.lines.map((line, index) => (
              <Text key={index} content={line} />
            ))}
          </ChartSurface>
          {xMarkers ? (
            <StaticXMarkerOverlay
              markers={xMarkers}
              width={plotWidth}
              height={plotHeight}
              fallbackColor={xAxisColor ?? timeAxisColor}
            />
          ) : null}
        </Box>
        {!axisOnLeft && priceAxis ? (
          <>
            <Box width={effectiveAxisGap} />
            {priceAxis}
          </>
        ) : null}
      </Box>
      {showTimeAxis || (xAxisLabels?.length ?? 0) > 0 ? (
        <Box height={1} flexDirection="row">
          {leftAxisSpacer}
          {xAxisLabels ? (
            <StaticXAxisLabels
              labels={xAxisLabels}
              width={plotWidth}
              color={xAxisColor ?? timeAxisColor}
              cursorColumn={textResult.cursorColumn}
              cursorPixelX={cursor ? cursor.x * cellWidthPx : null}
              cursorLabel={cursorXAxisLabel}
              cursorColor={colors.crosshairColor}
              cursorBackgroundColor={colors.bgColor ?? themeColors.bg}
            />
          ) : (
            <Box width={plotWidth} height={1} overflow="hidden">
              <Text fg={timeAxisColor}>{textResult.timeLabels}</Text>
            </Box>
          )}
          {rightAxisSpacer}
        </Box>
      ) : null}
      {xMarkers && xMarkerRows > 0 ? (
        <Box height={1} flexDirection="row">
          {leftAxisSpacer}
          <StaticXMarkerLabels markers={xMarkers} width={plotWidth} fallbackColor={xAxisColor ?? timeAxisColor} />
          {rightAxisSpacer}
        </Box>
      ) : null}
    </Box>
  );
}
