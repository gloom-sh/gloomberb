import { Box, Text, TextAttributes } from "../../../ui";
import { StaticChartSurface } from "../../../components";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import type { StaticChartXMarker } from "../../../components/chart/static";
import { colors, priceColor } from "../../../theme/colors";
import { formatCompact, formatCurrency, formatNumber } from "../../../utils/format";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import type { KellySizerDraft, KellySizingResult, SensitivityGrid } from "./model";
import {
  KellyCurveDecisionView,
  MetricLine,
  SensitivityGridView,
  formatPct,
  formatSignedPct,
} from "./view";

export function KellyResultMetrics({
  result,
  activeDraft,
  baseCurrency,
  leftWidth,
  rightWidth,
}: {
  result: KellySizingResult;
  activeDraft: KellySizerDraft;
  baseCurrency: string;
  leftWidth: number;
  rightWidth: number;
}) {
  return (
    <Box flexDirection="row" paddingX={1}>
      <Box flexDirection="column" width={leftWidth}>
        <MetricLine width={leftWidth} label="Full Kelly" value={formatPct(result.fullKellyFraction, 1)} />
        <MetricLine width={leftWidth} label="Fractional" value={formatPct(result.fractionalKellyFraction, 1)} detail={formatPct(activeDraft.kellyFraction, 0)} />
        <MetricLine
          width={leftWidth}
          label="Clipped"
          value={formatPct(result.clippedFraction, 2)}
          detail={result.clipReasons.length > 0 ? result.clipReasons.join(", ") : undefined}
          color={result.clipReasons.length > 0 ? colors.positive : colors.text}
        />
        <MetricLine width={leftWidth} label="Target val" value={formatCurrency(result.targetValue, baseCurrency)} />
        <MetricLine
          width={leftWidth}
          label="Add / trim"
          value={formatCurrency(result.addTrimValue, baseCurrency)}
          color={priceColor(result.addTrimValue)}
        />
        <MetricLine
          width={leftWidth}
          label="Units"
          value={result.estimatedUnits == null ? "—" : formatNumber(result.estimatedUnits, 1)}
        />
      </Box>
      <Box flexDirection="column" width={rightWidth}>
        <MetricLine width={rightWidth} label="Risk" value={formatCurrency(result.riskValue, baseCurrency)} detail={formatPct(result.riskFraction, 2)} color={colors.negative} />
        <MetricLine width={rightWidth} label="Worst loss" value={formatPct(result.downsideLossFraction, 1)} />
        <MetricLine width={rightWidth} label="Current %" value={formatPct(result.currentFraction, 1)} />
        <MetricLine width={rightWidth} label="Exp return" value={formatSignedPct(result.expectedReturn)} color={priceColor(result.expectedReturn)} />
        <MetricLine width={rightWidth} label="Log growth" value={formatCompact(result.expectedLogGrowth)} />
      </Box>
    </Box>
  );
}

export function KellyCurveSection({
  width,
  height,
  points,
  xAxisLabels,
  curveMaxFraction,
  markers,
  result,
  currentGrowth,
  targetGrowth,
  baseCurrency,
}: {
  width: number;
  height: number;
  points: ProjectedChartPoint[];
  xAxisLabels: string[];
  curveMaxFraction: number;
  markers: StaticChartXMarker[];
  result: KellySizingResult;
  currentGrowth: number;
  targetGrowth: number;
  baseCurrency: string;
}) {
  return (
    <>
      <Box height={1} paddingX={1}>
        <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>Kelly Curve</Text>
      </Box>
      <Box paddingX={1} height={height}>
        <StaticChartSurface
          points={points}
          width={Math.max(10, width - 2)}
          height={height}
          mode="line"
          colors={resolveChartPalette(colors, "positive")}
          yAxisLabel="Expected log growth"
          yAxisColor={colors.textDim}
          formatYAxisValue={(value) => formatSignedPct(value)}
          xAxisLabels={xAxisLabels}
          xAxisColor={colors.textDim}
          formatXAxisCursorValue={(ratio) => formatPct(curveMaxFraction * ratio, 1)}
          xMarkers={markers}
        />
      </Box>
      <KellyCurveDecisionView
        width={Math.max(10, width - 2)}
        currentFraction={result.currentFraction}
        targetFraction={result.clippedFraction}
        fullKellyFraction={result.fullKellyFraction}
        currentGrowth={currentGrowth}
        targetGrowth={targetGrowth}
        addTrimValue={result.addTrimValue}
        currency={baseCurrency}
        clipReasons={result.clipReasons}
      />
    </>
  );
}

export function KellySensitivitySection({
  width,
  sensitivity,
}: {
  width: number;
  sensitivity: SensitivityGrid;
}) {
  return (
    <>
      <Box height={1} paddingX={1} flexDirection="row">
        <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>Sensitivity</Text>
        <Text fg={colors.textDim}>{`  ${sensitivity.columnLabel}`}</Text>
      </Box>
      <SensitivityGridView width={Math.max(10, width - 2)} grid={sensitivity} />
    </>
  );
}
