import { KeyValueRow, SectionHeading, StaticChartSurface } from "../../../components";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import type { StaticChartXMarker } from "../../../components/chart/static";
import { colors, priceColor } from "../../../theme/colors";
import { Box, Text } from "../../../ui";
import { formatCurrency, formatNumber } from "../../../utils/format";
import type { KellySizingResult, SensitivityGrid } from "./model";
import { KellyCurveDecisionView, SensitivityGridView, formatPct, formatSignedPct } from "./view";

export function KellyResultMetrics({
  result,
  baseCurrency,
  leftWidth,
  rightWidth,
}: {
  result: KellySizingResult;
  baseCurrency: string;
  leftWidth: number;
  rightWidth: number;
}) {
  return (
    <Box flexDirection="row" paddingX={1}>
      <Box flexDirection="column" width={leftWidth}>
        <KeyValueRow width={leftWidth} label="Full Kelly" value={formatPct(result.fullKellyFraction, 1)} />
        <KeyValueRow width={leftWidth} label="Fractional" value={formatPct(result.fractionalKellyFraction, 1)} />
        <KeyValueRow
          width={leftWidth}
          label="Clipped"
          value={formatPct(result.clippedFraction, 2)}
          color={result.clipReasons.length > 0 ? colors.positive : colors.text}
        />
        <KeyValueRow width={leftWidth} label="Target val" value={formatCurrency(result.targetValue, baseCurrency)} />
        <KeyValueRow
          width={leftWidth}
          label="Add / trim"
          value={formatCurrency(result.addTrimValue, baseCurrency)}
          color={priceColor(result.addTrimValue)}
        />
        <KeyValueRow
          width={leftWidth}
          label="Units"
          value={result.estimatedUnits == null ? "—" : formatNumber(result.estimatedUnits, 1)}
        />
      </Box>
      <Box flexDirection="column" width={rightWidth}>
        <KeyValueRow width={rightWidth} label="Risk" value={formatCurrency(result.riskValue, baseCurrency)} detail={formatPct(result.riskFraction, 2)} color={colors.negative} />
        <KeyValueRow width={rightWidth} label="Worst loss" value={formatPct(result.downsideLossFraction, 1)} />
        <KeyValueRow width={rightWidth} label="Current %" value={formatPct(result.currentFraction, 1)} />
        <KeyValueRow width={rightWidth} label="Exp return" value={formatSignedPct(result.expectedReturn)} color={priceColor(result.expectedReturn)} />
        <KeyValueRow width={rightWidth} label="Full growth" value={formatSignedPct(result.expectedLogGrowth)} />
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
        <SectionHeading title="Kelly Curve" />
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
        <SectionHeading title="Sensitivity" />
        <Text fg={colors.textDim}>{`  ${sensitivity.columnLabel}`}</Text>
      </Box>
      <SensitivityGridView width={Math.max(10, width - 2)} grid={sensitivity} />
    </>
  );
}
