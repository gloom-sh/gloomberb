import { Box, Text } from "../../ui";
import { useMemo } from "react";
import { Tabs } from "../../components";
import {
  CompositeChart,
  pricePointsToResolvedSeries,
} from "../../components/chart/composite";
import { EmptyState } from "../../components/ui/status";
import { colors } from "../../theme/colors";
import { formatNumber, formatPercentRaw } from "../../utils/format";
import type { PricePoint } from "../../types/financials";
import type { PredictionHistoryPoint, PredictionHistoryRange } from "./types";

const RANGES: PredictionHistoryRange[] = ["1D", "1W", "1M", "ALL"];

function coercePredictionPointDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const next = new Date(value);
    return Number.isFinite(next.getTime()) ? next : null;
  }
  return null;
}

function toPricePoints(points: PredictionHistoryPoint[]): PricePoint[] {
  return points.flatMap((point) => {
    const date = coercePredictionPointDate(point.date);
    if (!date) return [];
    return [{
      date,
      close: point.close,
      open: point.open,
      high: point.high,
      low: point.low,
      volume: point.volume,
    }];
  });
}

const RANGE_TABS = RANGES.map((entry) => ({ label: entry, value: entry }));

/** Shared Tabs so the range picker keeps keyboard navigation, not just clicks. */
function PredictionRangeTabs({
  activeRange,
  focused,
  onRangeSelect,
}: {
  activeRange: PredictionHistoryRange;
  focused: boolean;
  onRangeSelect: (range: PredictionHistoryRange) => void;
}) {
  return (
    <Tabs
      tabs={RANGE_TABS}
      activeValue={activeRange}
      onSelect={(value) => onRangeSelect(value as PredictionHistoryRange)}
      compact
      variant="bare"
      focused={focused}
    />
  );
}

export function PredictionMarketChart({
  history,
  width,
  height,
  loading = false,
  focused = false,
  range,
  onRangeSelect,
}: {
  history: PredictionHistoryPoint[];
  width: number;
  height: number;
  loading?: boolean;
  focused?: boolean;
  range: PredictionHistoryRange;
  onRangeSelect: (range: PredictionHistoryRange) => void;
}) {
  const pricePoints = useMemo(() => toPricePoints(history), [history]);

  if (pricePoints.length === 0) {
    return (
      <Box flexDirection="column" height={height}>
        <Box flexDirection="row" height={1}>
          <PredictionRangeTabs
            activeRange={range}
            focused={focused}
            onRangeSelect={onRangeSelect}
          />
        </Box>
        <Box flexGrow={1} justifyContent="center">
          {loading ? (
            <Text fg={colors.textDim}>Loading chart...</Text>
          ) : (
            <EmptyState
              title="No chart history."
              hint="This venue did not return price history for the selected market."
            />
          )}
        </Box>
      </Box>
    );
  }

  const first = pricePoints[0] ?? null;
  const last = pricePoints[pricePoints.length - 1] ?? null;
  const delta = first && last ? last.close - first.close : 0;
  const deltaPct = first?.close ? (delta / first.close) * 100 : 0;
  const chartHeight = Math.max(height - 1, 2);
  const priceSeries = pricePointsToResolvedSeries(pricePoints, {
    id: "prediction-price",
    label: "YES price",
    color: delta > 0 ? colors.positive : delta < 0 ? colors.negative : colors.text,
    unit: "USD",
    style: "area",
    axis: "right",
    panelId: "price",
  });

  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="row" height={1}>
        <PredictionRangeTabs
          activeRange={range}
          focused={focused}
          onRangeSelect={onRangeSelect}
        />
        <Box flexGrow={1} />
        <Text
          fg={
            delta > 0
              ? colors.positive
              : delta < 0
                ? colors.negative
                : colors.text
          }
        >
          {`${formatNumber(last?.close ?? 0, 3)}  ${formatPercentRaw(deltaPct)}`}
        </Text>
      </Box>

      <CompositeChart
        width={width}
        height={chartHeight}
        focused={focused}
        interactive
        series={[priceSeries]}
        panels={[{ id: "price" }]}
        axisWidth={8}
        showLegend={false}
      />
    </Box>
  );
}
