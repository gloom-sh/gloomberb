import { useMemo } from "react";
import {
  Box,
  ChartSurface,
  Text,
  useNativeRenderer,
  useUiCapabilities,
  useUiHost,
} from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import type { PricePoint } from "../../types/financials";
import { resolveNativeBitmapSize, shouldRenderNativeBitmap } from "../chart/native/bitmap-support";
import { renderSparklineBitmap } from "./bitmap";
import {
  buildSamples,
  colorWithAlpha,
  resolveSparklineHistory,
  sparklineColor,
  sparklineValues,
  svgAreaPath,
  svgPath,
  type PriceSparklinePeriod,
  type PriceSparklineTrend,
} from "./model";
import { renderPriceSparkline } from "./index";

export const PRICE_SPARKLINE_COLUMN_ID = "sparkline";
export const PRICE_SPARKLINE_PERIOD_LABEL = "1M";
export { resolvePriceSparklineRange } from "./model";
export type { PriceSparklinePeriod, PriceSparklineTrend } from "./model";

const SPARKLINE_HEIGHT = 1;

function DesktopPriceSparkline({
  values,
  width,
  height,
  color,
  emptyColor,
}: {
  values: number[];
  width: number;
  height: number;
  color: string;
  emptyColor: string;
}) {
  const svgWidth = Math.max(24, width * 8);
  const svgHeight = Math.max(18, height * 18);
  const path = svgPath(buildSamples(values, svgWidth, svgHeight, 2));
  if (!path) return <Text fg={emptyColor}>{" "}</Text>;

  return (
    <Box width={width} height={height} justifyContent="center" overflow="hidden">
      <svg
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        width="100%"
        height="100%"
        aria-hidden="true"
        focusable="false"
        style={{ display: "block" }}
      >
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </Box>
  );
}

function TerminalPriceSparkline({
  priceHistory,
  values,
  width,
  height,
  color,
  area = false,
}: {
  priceHistory: PricePoint[];
  values: number[];
  width: number;
  height: number;
  color: string;
  area?: boolean;
}) {
  const { nativeCharts, cellWidthPx = 8, cellHeightPx = 18, pixelRatio = 1 } = useUiCapabilities();
  const nativeRenderer = useNativeRenderer();
  const rendererResolution = nativeRenderer.resolution;
  const rendererCapabilities = nativeRenderer.capabilities;
  const rendererTerminalWidth = nativeRenderer.terminalWidth;
  const rendererTerminalHeight = nativeRenderer.terminalHeight;
  const bitmap = useMemo(() => {
    if (values.length < 2 || !shouldRenderNativeBitmap(nativeRenderer, nativeCharts === true)) return null;
    const bitmapSize = resolveNativeBitmapSize({
      width,
      height,
      resolution: rendererResolution,
      terminalWidth: rendererTerminalWidth,
      terminalHeight: rendererTerminalHeight,
      cellWidthPx,
      cellHeightPx,
      pixelRatio,
    });
    return renderSparklineBitmap(values, bitmapSize.pixelWidth, bitmapSize.pixelHeight, color, { area, compact: height <= 1 });
  }, [
    area,
    cellHeightPx,
    cellWidthPx,
    color,
    height,
    nativeCharts,
    nativeRenderer,
    pixelRatio,
    rendererCapabilities,
    rendererResolution,
    rendererTerminalHeight,
    rendererTerminalWidth,
    values,
    width,
  ]);
  const fallback = useMemo(
    () => renderPriceSparkline(priceHistory, { width, height, maxPoints: priceHistory.length }),
    [height, priceHistory, width],
  );

  return (
    <ChartSurface width={width} height={height} flexDirection="column" bitmaps={bitmap ? [bitmap] : null}>
      {fallback ? <Text fg={color}>{fallback}</Text> : null}
    </ChartSurface>
  );
}

export function PriceSparkline({
  priceHistory,
  width,
  trend,
  period = "1M",
  height = SPARKLINE_HEIGHT,
  area = false,
}: {
  priceHistory: PricePoint[] | undefined;
  width: number;
  trend?: PriceSparklineTrend;
  period?: PriceSparklinePeriod;
  height?: number;
  area?: boolean;
}) {
  const colors = useThemeColors();
  const uiHost = useUiHost();
  const sparklineHistory = useMemo(() => resolveSparklineHistory(priceHistory ?? [], period), [period, priceHistory]);
  const values = useMemo(() => sparklineValues(sparklineHistory), [sparklineHistory]);
  if (values.length < 2) {
    return <Text fg={colors.textMuted}>{" "}</Text>;
  }

  const color = sparklineColor(values, trend, colors);
  return uiHost.kind === "desktop-web"
    ? <DesktopPriceSparkline values={values} width={width} height={height} color={color} emptyColor={colors.textMuted} />
    : <TerminalPriceSparkline priceHistory={sparklineHistory} values={values} width={width} height={height} color={color} area={area} />;
}

export function PriceAreaSparklineBackground({
  priceHistory,
  trend,
  period = "1M",
}: {
  priceHistory: PricePoint[] | undefined;
  trend?: PriceSparklineTrend;
  period?: PriceSparklinePeriod;
}) {
  const colors = useThemeColors();
  const uiHost = useUiHost();
  const sparklineHistory = useMemo(() => resolveSparklineHistory(priceHistory ?? [], period), [period, priceHistory]);
  const values = useMemo(() => sparklineValues(sparklineHistory), [sparklineHistory]);
  if (uiHost.kind !== "desktop-web" || values.length < 2) return null;

  const color = sparklineColor(values, trend, colors);
  const baseline = 100;
  const samples = buildSamples(values, 100, baseline, 0);
  const linePath = svgPath(samples);
  const areaPath = svgAreaPath(samples, baseline);
  if (!linePath || !areaPath) return null;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "block",
        pointerEvents: "none",
      }}
    >
      <path d={areaPath} fill={colorWithAlpha(color, 0.08)} />
      <path
        d={linePath}
        fill="none"
        stroke={colorWithAlpha(color, 0.46)}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
