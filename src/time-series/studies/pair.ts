import { alignTimeSeries } from "../alignment";
import type { ManualChartResolution } from "../resolution";
import type { ChartStudySpec, ResolvedSeries, SeriesPeriod, TimeSeriesPoint } from "../types";
import { isFiniteNumber } from "../../utils/guards";
import { derivedPoint, outputSeries, studyPeriod } from "./shared";
import { derivedValueDecimals, isPriceGroup, ratioUnit } from "./units";

interface PairedSample {
  point: TimeSeriesPoint;
  left: number;
  right: number;
}

function pairedSamples(left: ResolvedSeries, right: ResolvedSeries, carryForward: boolean): PairedSample[] {
  return alignTimeSeries([left, right], {
    mode: "intersection",
    // Ratios/spreads compare latest known levels; correlations need actual
    // shared observations before calculating returns. Carrying a closed market
    // invents zero returns and mismatches both sides of a weekend/holiday move.
    // Both modes still respect the publication time of each observation.
    carryForward,
  }).flatMap((row) => {
    const leftValue = row.values[left.id];
    const rightValue = row.values[right.id];
    if (!isFiniteNumber(leftValue?.value) || !isFiniteNumber(rightValue?.value)) return [];
    const availability = Math.max(
      leftValue.point.availableAt?.getTime() ?? leftValue.point.date.getTime(),
      rightValue.point.availableAt?.getTime() ?? rightValue.point.date.getTime(),
    );
    return [{
      left: leftValue.value,
      right: rightValue.value,
      point: {
        date: new Date(row.date),
        observedAt: new Date(row.date),
        availableAt: Number.isFinite(availability) ? new Date(availability) : undefined,
        value: null,
        provenance: { quality: "derived" as const },
      },
    }];
  });
}

function pairedFrequency(left: ResolvedSeries, right: ResolvedSeries): SeriesPeriod {
  return left.nativeFrequency === right.nativeFrequency ? left.nativeFrequency : "auto";
}

function pairedHistoryResolution(left: ResolvedSeries, right: ResolvedSeries): ManualChartResolution | null | undefined {
  return left.historyResolution === right.historyResolution ? left.historyResolution : null;
}

export function resolvePairStudy(
  spec: ChartStudySpec,
  left: ResolvedSeries,
  right: ResolvedSeries,
  color: string,
): ResolvedSeries[] {
  const paired = pairedSamples(left, right, spec.kind !== "correlation");
  if (spec.kind === "ratio" || spec.kind === "spread") {
    const multiplier = isFiniteNumber(spec.parameters.multiplier) ? spec.parameters.multiplier : 1;
    const points = paired.map((sample) => derivedPoint(
      { point: sample.point, value: sample.left },
      spec.kind === "ratio"
        ? sample.right === 0 ? null : sample.left / sample.right
        : sample.left - sample.right * multiplier,
    ));
    const ratioStudy = spec.kind === "ratio";
    const outputUnit = ratioStudy
      ? ratioUnit(left, right)
      : { unit: left.unit, unitGroup: left.unitGroup };
    // A price over an FX rate is a price in the other currency (EUR / barrel),
    // stated as a future's unit is; a plain ratio keeps its own decimals.
    const convertedPrice = ratioStudy && isPriceGroup(outputUnit.unitGroup);
    const valueDecimals = !ratioStudy || convertedPrice ? derivedValueDecimals([left, right], points) : undefined;
    return [outputSeries(spec, left, {
      ...(convertedPrice ? { statedUnit: outputUnit.unit, priceAssetCategory: null } : {}),
      ...(valueDecimals !== undefined ? { valueDecimals } : {}),
      label: ratioStudy
        ? `${left.label} / ${right.label}`
        : `${left.label} - ${multiplier === 1 ? "" : `${multiplier}×`}${right.label}`,
      points,
      color,
      unit: outputUnit.unit,
      unitGroup: outputUnit.unitGroup,
      // Pair formulas are calculated with as-of carry on the union of both
      // inputs' event dates. Their value is therefore piecewise constant until
      // either input changes, even when an input is displayed as columns.
      style: "step",
      interpolation: "step-after",
      axis: "left",
      nativeFrequency: pairedFrequency(left, right),
      historyResolution: pairedHistoryResolution(left, right),
    })];
  }

  const period = studyPeriod(spec, 20);
  const useReturns = spec.parameters.returns !== 0;
  const values = useReturns
    ? paired.slice(1).flatMap((sample, index) => {
      const previous = paired[index]!;
      if (previous.left === 0 || previous.right === 0) return [];
      return [{
        point: sample.point,
        left: (sample.left - previous.left) / Math.abs(previous.left),
        right: (sample.right - previous.right) / Math.abs(previous.right),
      }];
    })
    : paired;
  const points: TimeSeriesPoint[] = [];
  for (let index = period - 1; index < values.length; index += 1) {
    const window = values.slice(index - period + 1, index + 1);
    const leftMean = window.reduce((sum, item) => sum + item.left, 0) / period;
    const rightMean = window.reduce((sum, item) => sum + item.right, 0) / period;
    let covariance = 0;
    let leftVariance = 0;
    let rightVariance = 0;
    for (const item of window) {
      const leftDelta = item.left - leftMean;
      const rightDelta = item.right - rightMean;
      covariance += leftDelta * rightDelta;
      leftVariance += leftDelta ** 2;
      rightVariance += rightDelta ** 2;
    }
    const denominator = Math.sqrt(leftVariance * rightVariance);
    const value = denominator === 0 ? null : Math.max(-1, Math.min(1, covariance / denominator));
    points.push(derivedPoint({ point: values[index]!.point, value: values[index]!.left }, value));
  }
  return [outputSeries(spec, left, {
    label: `Correlation(${period}) ${left.label} / ${right.label}`,
    points,
    color,
    unit: "correlation",
    unitGroup: "correlation",
    axis: "left",
    nativeFrequency: pairedFrequency(left, right),
    historyResolution: pairedHistoryResolution(left, right),
  })];
}
