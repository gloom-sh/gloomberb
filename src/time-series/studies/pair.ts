import type { ChartStudySpec, ResolvedSeries, TimeSeriesPoint } from "../types";
import { isFiniteNumber } from "../../utils/guards";
import { alignedDerivedSamples, derivedPoint, outputSeries, sharedFrequency, sharedHistoryResolution, studyPeriod } from "./shared";
import { derivedValueDecimals, isPriceGroup, PLAIN_RATIO_UNIT, percentBasisPointRatioScale, ratioUnit } from "./units";

interface PairedSample {
  point: TimeSeriesPoint;
  left: number;
  right: number;
}

function pairedSamples(left: ResolvedSeries, right: ResolvedSeries, carryForward: boolean): PairedSample[] {
  return alignedDerivedSamples([left, right], carryForward).map((sample) => ({
    point: sample.point,
    left: sample.values[0]!,
    right: sample.values[1]!,
  }));
}

/** A pair's leg as its formula names it: a published series as written, anything else by its label. */
function pairLegName(series: ResolvedSeries): string {
  return series.expression ?? series.label;
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
    const ratioStudy = spec.kind === "ratio";
    // A percent over basis points cancels to a plain number, 100 times the quotient (4.1% over 61bp is 6.72),
    // rounded off the float's last digits.
    const percentScale = ratioStudy ? percentBasisPointRatioScale(left, right) : null;
    const points = paired.map((sample) => derivedPoint(
      { point: sample.point, value: sample.left },
      ratioStudy
        ? sample.right === 0 ? null : percentScale === null ? sample.left / sample.right
          : Number((sample.left / sample.right * percentScale).toPrecision(12))
        : sample.left - sample.right * multiplier,
    ));
    const outputUnit = ratioStudy
      ? percentScale === null ? ratioUnit(left, right) : PLAIN_RATIO_UNIT
      : { unit: left.unit, unitGroup: left.unitGroup };
    // A price over an FX rate is a price in the other currency (EUR / barrel),
    // stated as a future's unit is; a plain ratio keeps its own decimals.
    const convertedPrice = ratioStudy && isPriceGroup(outputUnit.unitGroup);
    const valueDecimals = !ratioStudy || convertedPrice ? derivedValueDecimals([left, right], points) : undefined;
    return [outputSeries(spec, left, {
      ...(convertedPrice ? { statedUnit: outputUnit.unit, priceAssetCategory: null } : {}),
      ...(valueDecimals !== undefined ? { valueDecimals } : {}),
      // A published series reads as it is written (FRED:BAMLC0A0CM - CAP:cdx:ig): its long title would
      // read like the leg's own line in a legend that has to shorten.
      label: ratioStudy
        ? `${pairLegName(left)} / ${pairLegName(right)}`
        : `${pairLegName(left)} - ${multiplier === 1 ? "" : `${multiplier}×`}${pairLegName(right)}`,
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
      nativeFrequency: sharedFrequency([left, right]),
      historyResolution: sharedHistoryResolution([left, right]),
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
    nativeFrequency: sharedFrequency([left, right]),
    historyResolution: sharedHistoryResolution([left, right]),
  })];
}
