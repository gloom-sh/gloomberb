import { useCallback, useMemo } from "react";
import { Box, Text } from "../../../ui";
import { colors } from "../../../theme/colors";
import { CompositeChart } from "../composite/composite-chart";
import { scalarPoint, staticSeries } from "./series";

export interface MultiLineChartSeries {
  id: string;
  label: string;
  color: string;
  points: Array<{ date: Date; value: number | null }>;
}

interface MultiLineChartColors {
  bgColor: string;
  gridColor: string;
  axisColor: string;
  crosshairColor: string;
}

export interface StaticMultiLineChartSurfaceProps {
  series: MultiLineChartSeries[];
  width: number;
  height: number;
  colors?: MultiLineChartColors;
  cursorDate?: Date | null;
  showTimeAxis?: boolean;
  timeAxisColor?: string;
  yAxisLabel?: string;
  yAxisColor?: string;
  formatYAxisValue?: (value: number) => string;
  onCursorDateChange?: (date: Date) => void;
}

const PANELS = [{ id: "main" }];

export function StaticMultiLineChartSurface({
  series,
  width,
  height,
  colors: chartColors = {
    bgColor: colors.bg,
    gridColor: colors.border,
    axisColor: colors.textDim,
    crosshairColor: colors.borderFocused,
  },
  cursorDate = null,
  showTimeAxis = false,
  timeAxisColor = colors.textDim,
  yAxisLabel,
  yAxisColor = colors.textDim,
  formatYAxisValue,
  onCursorDateChange,
}: StaticMultiLineChartSurfaceProps) {
  const totalWidth = Math.max(1, Math.floor(width));
  const totalHeight = Math.max(1, Math.floor(height));
  const labelRows = yAxisLabel ? 1 : 0;
  const resolved = useMemo(() => series.map((entry) => staticSeries(
    entry.points.map((point) => scalarPoint(point.date, point.value)),
    { id: entry.id, label: entry.label, color: entry.color },
  )), [series]);
  const compositeColors = useMemo(() => ({
    background: chartColors.bgColor,
    grid: chartColors.gridColor,
    crosshair: chartColors.crosshairColor,
    text: chartColors.axisColor,
    textDim: yAxisColor ?? timeAxisColor ?? chartColors.axisColor,
    negative: colors.negative,
  }), [chartColors, timeAxisColor, yAxisColor]);
  const formatAxisValue = useMemo(
    () => formatYAxisValue ? (value: number) => formatYAxisValue(value) : undefined,
    [formatYAxisValue],
  );
  const handleCursorDateChange = useCallback((date: Date | null) => {
    if (date) onCursorDateChange?.(date);
  }, [onCursorDateChange]);

  return (
    <Box flexDirection="column" width={totalWidth} height={totalHeight}>
      {yAxisLabel ? (
        <Box height={1}>
          <Text fg={yAxisColor}>{yAxisLabel}</Text>
        </Box>
      ) : null}
      <CompositeChart
        series={resolved}
        panels={PANELS}
        width={totalWidth}
        height={Math.max(1, totalHeight - labelRows)}
        colors={compositeColors}
        cursorDate={cursorDate}
        onCursorDateChange={handleCursorDateChange}
        navigable={false}
        showLegend={false}
        showTimeAxis={showTimeAxis}
        formatAxisValue={formatAxisValue}
        emptyMessage="No chart data"
      />
    </Box>
  );
}
