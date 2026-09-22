import { alignTimeSeries, effectiveTimeSeriesPointTime, scalarPointValue } from "./alignment";
import { mergePriceHistoryIntegrity } from "../utils/price-history-integrity";
import { resolveCurrencyUnit } from "../utils/currency-units";
import { isRealizedVolatilityEstimator, realizedVolatilityCadenceIssue, rollingRealizedVolatility } from "../plugins/builtin/shared/volatility/realized";
import type { ManualChartResolution } from "./resolution";
import type {
  ChartStudyKind,
  ChartStudySpec,
  ResolvedSeries,
  SeriesAxis,
  SeriesInterpolation,
  SeriesPeriod,
  SeriesStyle,
  TimeSeriesPoint,
} from "./types";

export interface StudyResolutionResult {
  series: ResolvedSeries[];
  warnings: string[];
  errors: string[];
}

interface NumericSample {
  point: TimeSeriesPoint;
  value: number;
}

export interface IndexedValue {
  index: number;
  value: number;
}

const STUDY_COLORS = ["#f6c85f", "#4dabf7", "#b197fc", "#63e6be", "#ffa94d", "#ff6b6b"];

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveInteger(value: unknown, fallback: number): number {
  return finiteNumber(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

function samplesFor(series: ResolvedSeries): NumericSample[] {
  return [...series.points]
    .sort((left, right) => left.date.getTime() - right.date.getTime())
    .flatMap((point) => {
      const value = scalarPointValue(point);
      return value === null ? [] : [{ point, value }];
    });
}

function derivedPoint(sample: NumericSample, value: number | null): TimeSeriesPoint {
  return {
    date: new Date(sample.point.date),
    observedAt: new Date(sample.point.observedAt),
    availableAt: sample.point.availableAt ? new Date(sample.point.availableAt) : undefined,
    value,
    periodLabel: sample.point.periodLabel,
    provenance: {
      providerId: sample.point.provenance?.providerId,
      quality: "derived",
    },
  };
}

function outputSeries(
  spec: ChartStudySpec,
  input: ResolvedSeries,
  options: {
    id?: string;
    label: string;
    points: TimeSeriesPoint[];
    color: string;
    unit?: string;
    unitGroup?: string;
    style?: SeriesStyle;
    interpolation?: SeriesInterpolation;
    axis?: Exclude<SeriesAxis, "auto">;
    nativeFrequency?: SeriesPeriod;
    historyResolution?: ManualChartResolution | null;
  },
): ResolvedSeries {
  const historyResolution = options.historyResolution === undefined ? input.historyResolution : options.historyResolution;
  return {
    id: options.id ?? spec.id,
    label: options.label,
    color: options.color,
    unit: options.unit ?? input.unit,
    unitGroup: options.unitGroup ?? input.unitGroup,
    priceAssetCategory: (options.unit ?? input.unit) === input.unit
      && (options.unitGroup ?? input.unitGroup) === input.unitGroup ? input.priceAssetCategory : undefined,
    nativeFrequency: options.nativeFrequency ?? input.nativeFrequency,
    ...(historyResolution !== undefined ? { historyResolution } : {}),
    dataShape: "scalar",
    style: options.style ?? "line",
    transform: "raw",
    axis: spec.axis === "auto" ? options.axis ?? input.axis : spec.axis,
    panelId: spec.panelId,
    interpolation: options.interpolation ?? "none",
    timeBasis: historyResolution === null && input.timeBasis ? { ...input.timeBasis, cadenceMs: undefined } : input.timeBasis,
    observationKind: input.observationKind,
    points: options.points,
  };
}

/** Exported so backtest rules and chart studies share identical math. */
export function sma(values: readonly number[], period: number): IndexedValue[] {
  if (values.length < period) return [];
  const result: IndexedValue[] = [];
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]!;
    if (index >= period) sum -= values[index - period]!;
    if (index >= period - 1) result.push({ index, value: sum / period });
  }
  return result;
}

export function ema(values: readonly number[], period: number): IndexedValue[] {
  if (values.length < period) return [];
  const result: IndexedValue[] = [];
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result.push({ index: period - 1, value: current });
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    current = values[index]! * multiplier + current * (1 - multiplier);
    result.push({ index, value: current });
  }
  return result;
}

export function rsi(values: readonly number[], period: number): IndexedValue[] {
  if (values.length < period + 1) return [];
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index]! - values[index - 1]!;
    if (change > 0) averageGain += change;
    else averageLoss -= change;
  }
  averageGain /= period;
  averageLoss /= period;
  const result: IndexedValue[] = [{
    index: period,
    value: averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss),
  }];
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result.push({
      index,
      value: averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss),
    });
  }
  return result;
}

function indexedPoints(samples: readonly NumericSample[], values: readonly IndexedValue[]): TimeSeriesPoint[] {
  return values.flatMap(({ index, value }) => {
    const sample = samples[index];
    return sample ? [derivedPoint(sample, value)] : [];
  });
}

function studyPeriod(spec: ChartStudySpec, fallback: number): number {
  return positiveInteger(spec.parameters.period, fallback);
}

function studyWarmupPoints(spec: ChartStudySpec): number {
  if (spec.kind === "realized-vol") {
    const window = positiveInteger(spec.parameters.window, 30);
    return spec.parameters.estimator === undefined || spec.parameters.estimator === "close-to-close" || spec.parameters.estimator === "yang-zhang"
      ? window : window - 1;
  }
  if (spec.kind === "sma" || spec.kind === "ema" || spec.kind === "bollinger") {
    return studyPeriod(spec, 20) - 1;
  }
  if (spec.kind === "rsi") return studyPeriod(spec, 14);
  if (spec.kind === "macd") {
    const slow = positiveInteger(spec.parameters.slow, 26);
    const signal = positiveInteger(spec.parameters.signal, 9);
    return slow + signal - 2;
  }
  if (spec.kind === "correlation") return studyPeriod(spec, 20);
  return 0;
}

export function maxStudyWarmupPoints(specs: readonly ChartStudySpec[]): number {
  return Math.max(0, ...specs.filter((spec) => spec.visible !== false).map(studyWarmupPoints));
}

function resolveRealizedVolatility(spec: ChartStudySpec, input: ResolvedSeries, color: string): ResolvedSeries[] {
  const window = positiveInteger(spec.parameters.window, 30);
  const estimator = isRealizedVolatilityEstimator(spec.parameters.estimator) ? spec.parameters.estimator : "close-to-close";
  // Retain invalid rows and the last correction for each date. Dropping one
  // would turn two separated returns into adjacent observations.
  const byDate = new Map(input.points.map((point) => [point.date.getTime(), point]));
  const source = [...byDate.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  const calculated = rollingRealizedVolatility(source.map((point) => ({
    date: point.date,
    close: point.provenance?.priceHistoryIntegrity || point.provenance?.valuationPriceIssues?.length
      ? Number.NaN : (point.close === undefined ? point.value : point.close) ?? Number.NaN,
    open: point.open ?? undefined,
    high: point.high ?? undefined,
    low: point.low ?? undefined,
  })), { windows: [window], estimator });
  const warmup = studyWarmupPoints(spec);
  const points = calculated.map((point, index): TimeSeriesPoint => {
    const original = source[index]!;
    const value = point.values[window];
    const derived = derivedPoint({ point: original, value: 0 }, value == null ? null : value * 100);
    if (value == null) {
      const affected = source.slice(Math.max(0, index - warmup), index + 1);
      const integrity = affected.flatMap((entry) => entry.provenance?.priceHistoryIntegrity ? [entry.provenance.priceHistoryIntegrity] : []);
      if (integrity.length) derived.provenance!.priceHistoryIntegrity = mergePriceHistoryIntegrity(...integrity);
    }
    return derived;
  });
  return [outputSeries(spec, input, {
    label: `RV(${window}, ${estimator}) ${input.label}`,
    points,
    color,
    unit: "%",
    unitGroup: "percent",
    axis: "left",
  })];
}

function resolveMovingAverage(
  spec: ChartStudySpec,
  input: ResolvedSeries,
  color: string,
  exponential: boolean,
): ResolvedSeries[] {
  const period = studyPeriod(spec, 20);
  const samples = samplesFor(input);
  const calculated = exponential
    ? ema(samples.map(({ value }) => value), period)
    : sma(samples.map(({ value }) => value), period);
  const name = exponential ? "EMA" : "SMA";
  return [outputSeries(spec, input, {
    label: `${name}(${period}) ${input.label}`,
    points: indexedPoints(samples, calculated),
    color,
  })];
}

function resolveBollinger(
  spec: ChartStudySpec,
  input: ResolvedSeries,
  color: string,
): ResolvedSeries[] {
  const period = studyPeriod(spec, 20);
  const deviations = finiteNumber(spec.parameters.stdDev) && spec.parameters.stdDev > 0
    ? spec.parameters.stdDev
    : 2;
  const samples = samplesFor(input);
  const values = samples.map(({ value }) => value);
  const middle = sma(values, period);
  const upper: IndexedValue[] = [];
  const lower: IndexedValue[] = [];
  for (const point of middle) {
    const window = values.slice(point.index - period + 1, point.index + 1);
    const variance = window.reduce((sum, value) => sum + (value - point.value) ** 2, 0) / period;
    const deviation = Math.sqrt(variance) * deviations;
    upper.push({ index: point.index, value: point.value + deviation });
    lower.push({ index: point.index, value: point.value - deviation });
  }
  const label = `Bollinger(${period},${deviations}) ${input.label}`;
  return [
    outputSeries(spec, input, {
      id: `${spec.id}:upper`,
      label: `${label} Upper`,
      points: indexedPoints(samples, upper),
      color,
    }),
    outputSeries(spec, input, {
      id: `${spec.id}:middle`,
      label: `${label} Middle`,
      points: indexedPoints(samples, middle),
      color,
    }),
    outputSeries(spec, input, {
      id: `${spec.id}:lower`,
      label: `${label} Lower`,
      points: indexedPoints(samples, lower),
      color,
    }),
  ];
}

function resolveRsi(spec: ChartStudySpec, input: ResolvedSeries, color: string): ResolvedSeries[] {
  const period = studyPeriod(spec, 14);
  const samples = samplesFor(input);
  return [outputSeries(spec, input, {
    label: `RSI(${period}) ${input.label}`,
    points: indexedPoints(samples, rsi(samples.map(({ value }) => value), period)),
    color,
    unit: "index",
    unitGroup: "oscillator-0-100",
    axis: "left",
  })];
}

function resolveMacd(spec: ChartStudySpec, input: ResolvedSeries, color: string): ResolvedSeries[] {
  const fastPeriod = positiveInteger(spec.parameters.fast, 12);
  const slowPeriod = positiveInteger(spec.parameters.slow, 26);
  const signalPeriod = positiveInteger(spec.parameters.signal, 9);
  if (fastPeriod >= slowPeriod) return [];
  const samples = samplesFor(input);
  const values = samples.map(({ value }) => value);
  const fast = new Map(ema(values, fastPeriod).map((point) => [point.index, point.value]));
  const macd = ema(values, slowPeriod).flatMap(({ index, value }) => {
    const fastValue = fast.get(index);
    return fastValue === undefined ? [] : [{ index, value: fastValue - value }];
  });
  const signalOnMacd = ema(macd.map(({ value }) => value), signalPeriod);
  const signal = signalOnMacd.flatMap(({ index, value }) => {
    const source = macd[index];
    return source ? [{ index: source.index, value }] : [];
  });
  const macdByIndex = new Map(macd.map((point) => [point.index, point.value]));
  const histogram = signal.map(({ index, value }) => ({ index, value: macdByIndex.get(index)! - value }));
  const label = `MACD(${fastPeriod},${slowPeriod},${signalPeriod}) ${input.label}`;
  return [
    outputSeries(spec, input, {
      id: `${spec.id}:macd`,
      label,
      points: indexedPoints(samples, macd),
      color,
      axis: "left",
    }),
    outputSeries(spec, input, {
      id: `${spec.id}:signal`,
      label: `${label} Signal`,
      points: indexedPoints(samples, signal),
      color: STUDY_COLORS[1]!,
      axis: "left",
    }),
    outputSeries(spec, input, {
      id: `${spec.id}:histogram`,
      label: `${label} Histogram`,
      points: indexedPoints(samples, histogram),
      color: STUDY_COLORS[4]!,
      style: "columns",
      axis: "left",
    }),
  ];
}

function resolveVolume(spec: ChartStudySpec, input: ResolvedSeries, color: string): ResolvedSeries[] {
  const points = [...input.points]
    .sort((left, right) => left.date.getTime() - right.date.getTime())
    .flatMap((point) => finiteNumber(point.volume)
      ? [derivedPoint({ point, value: point.volume }, point.volume)]
      : []);
  return [outputSeries(spec, input, {
    label: `Volume ${input.label}`,
    points,
    color,
    unit: input.volumeUnit ?? "",
    unitGroup: "volume",
    style: "columns",
    axis: "left",
  })];
}

interface PairedSample {
  point: TimeSeriesPoint;
  left: number;
  right: number;
}

function seriesCurrency(series: ResolvedSeries): string | null {
  const grouped = series.unitGroup.match(/:([A-Z]{3})$/i)?.[1];
  if (grouped) return grouped.toUpperCase();
  if (!/^(?:price|currency-total|per-share)$/.test(series.unitGroup)) return null;
  return series.unit.match(/^([A-Z]{3})(?:$|\/)/i)?.[1]?.toUpperCase() ?? null;
}

function unitFactorIdentity(value: string): string {
  const token = value.trim();
  if (/^[A-Za-z]{3}$/.test(token)) {
    const { currency, divisor } = resolveCurrencyUnit(token);
    return `${currency}:${divisor}`;
  }
  return token.toLowerCase().replace(/^shares$/, "share");
}

function knownUnitSignature(series: ResolvedSeries): string | null {
  const unit = series.unit.trim();
  if (!unit || /(?:^|\W)(?:currency|unknown|unspecified|n\/a)(?:$|\W)/i.test(unit)
    || /^(?:units?|[-?]+)$/i.test(unit)) return null;
  if (unit.split("/").some((part) => !part.trim() || /^[-?]+$/.test(part.trim()))) return null;

  const monetary = series.unitGroup.match(/^(price|currency-total|per-share)(?::([^:]+))?$/);
  const currency = unit.match(/^([A-Za-z]{3})(?:$|\/)/)?.[1];
  if (monetary && (!currency || (monetary[2] && unitFactorIdentity(monetary[2]) !== unitFactorIdentity(currency)))) return null;

  // Currency alone does not establish a price's physical/share basis. A scalar
  // multiplier cannot establish it either. Explicit USD/share price and EPS
  // units, however, match despite different groups.
  if (monetary?.[1] === "price" && !unit.includes("/")) return null;
  const basis = monetary && !unit.includes("/") ? monetary[1] : "";
  // Keep currency scale and compound order: GBp/GBX are pence, not pounds;
  // USD/EUR cannot subtract EUR/USD.
  return `${basis ?? ""}|${unit.split("/").map(unitFactorIdentity).join("/")}`;
}

function unitFactors(unit: string): { numerator: string[]; denominator: string[] } {
  const [numerator = "", ...denominator] = unit.split("/");
  const factor = (value: string) => {
    const normalized = value.trim();
    if (!normalized || normalized === "1") return [];
    return [normalized.toLowerCase() === "shares" ? "share" : normalized];
  };
  return {
    numerator: factor(numerator),
    denominator: denominator.flatMap(factor),
  };
}

function ratioUnit(left: ResolvedSeries, right: ResolvedSeries): {
  unit: string;
  unitGroup: string;
} {
  if (!knownUnitSignature(left) || !knownUnitSignature(right)) {
    return { unit: "unknown", unitGroup: "derived-unit:unknown" };
  }
  const leftFactors = unitFactors(left.unit);
  const rightFactors = unitFactors(right.unit);
  const numerator = [...leftFactors.numerator, ...rightFactors.denominator];
  const denominator = [...leftFactors.denominator, ...rightFactors.numerator];
  for (let index = numerator.length - 1; index >= 0; index -= 1) {
    const match = denominator.findIndex((factor) => (
      unitFactorIdentity(factor) === unitFactorIdentity(numerator[index]!)
    ));
    if (match < 0) continue;
    numerator.splice(index, 1);
    denominator.splice(match, 1);
  }
  const unit = denominator.length === 0
    ? numerator.join("·") || "x"
    : `${numerator.join("·") || "1"}/${denominator.join("·")}`;
  const groupFactor = (value: string) => {
    const identity = unitFactorIdentity(value);
    return (/^[A-Za-z]{3}$/.test(value.trim()) ? identity.replace(/:1$/, "") : identity).toLowerCase();
  };
  const groupNumerator = numerator.map(groupFactor).join("·");
  const groupDenominator = denominator.map(groupFactor).join("·");
  const group = groupDenominator ? `${groupNumerator || "1"}/${groupDenominator}` : groupNumerator;
  return {
    unit,
    unitGroup: unit === "x" ? "ratio" : `derived-unit:${group}`,
  };
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
    if (!finiteNumber(leftValue?.value) || !finiteNumber(rightValue?.value)) return [];
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

function resolvePairStudy(
  spec: ChartStudySpec,
  left: ResolvedSeries,
  right: ResolvedSeries,
  color: string,
): ResolvedSeries[] {
  const paired = pairedSamples(left, right, spec.kind !== "correlation");
  if (spec.kind === "ratio" || spec.kind === "spread") {
    const multiplier = finiteNumber(spec.parameters.multiplier) ? spec.parameters.multiplier : 1;
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
    return [outputSeries(spec, left, {
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

function requiredInputs(kind: ChartStudyKind): number {
  return kind === "ratio" || kind === "spread" || kind === "correlation" ? 2 : 1;
}

/**
 * A contradictory observation interrupts the input history. Running studies on
 * each continuous segment keeps finite windows from skipping the missing bar
 * and makes recursive indicators warm up again from valid observations.
 */
function resolveInterruptedStudy(
  inputs: readonly ResolvedSeries[],
  spec: ChartStudySpec,
): StudyResolutionResult | null {
  const gaps = new Map<number, TimeSeriesPoint>();
  for (const input of inputs) {
    for (const point of input.points) {
      const integrity = point.provenance?.priceHistoryIntegrity;
      const priceIssues = point.provenance?.valuationPriceIssues;
      if (!integrity && !priceIssues?.length) continue;
      const timestamp = effectiveTimeSeriesPointTime(point);
      const previous = gaps.get(timestamp)?.provenance;
      gaps.set(timestamp, {
        date: new Date(timestamp), observedAt: new Date(timestamp), value: null,
        provenance: {
          quality: "derived",
          ...(integrity || previous?.priceHistoryIntegrity ? { priceHistoryIntegrity: previous?.priceHistoryIntegrity && integrity
            ? mergePriceHistoryIntegrity(previous.priceHistoryIntegrity, integrity) : integrity ?? previous?.priceHistoryIntegrity } : {}),
          ...(priceIssues?.length || previous?.valuationPriceIssues?.length
            ? { valuationPriceIssues: [...(previous?.valuationPriceIssues ?? []), ...(priceIssues ?? [])] } : {}),
        },
      });
    }
  }
  if (!gaps.size) return null;
  const times = [...gaps.keys()].sort((left, right) => left - right);
  const outputs = new Map<string, ResolvedSeries>();
  const warnings = new Set<string>();
  const errors = new Set<string>();
  const cursors = inputs.map((input) => ({
    input,
    points: [...input.points].sort((left, right) => effectiveTimeSeriesPointTime(left) - effectiveTimeSeriesPointTime(right)),
    index: 0,
    previous: undefined as TimeSeriesPoint | undefined,
  }));
  let start = Number.NEGATIVE_INFINITY;
  for (const end of [...times, Number.POSITIVE_INFINITY]) {
    const segmentInputs = cursors.map((cursor) => {
      while (cursor.index < cursor.points.length && effectiveTimeSeriesPointTime(cursor.points[cursor.index]!) <= start) {
        cursor.previous = cursor.points[cursor.index++];
      }
      const previous = cursor.previous;
      const points: TimeSeriesPoint[] = [];
      while (cursor.index < cursor.points.length && effectiveTimeSeriesPointTime(cursor.points[cursor.index]!) < end) {
        const point = cursor.points[cursor.index++]!;
        points.push(point);
        cursor.previous = point;
      }
      // A valid unaffected peer remains usable for as-of ratio/spread levels.
      // Correlations instead restart their shared observations and returns.
      if (spec.kind === "ratio" || spec.kind === "spread") {
        if (previous && !previous.provenance?.priceHistoryIntegrity && !previous.provenance?.valuationPriceIssues?.length) points.unshift(previous);
      }
      return { ...cursor.input, points };
    });
    const segment = resolveStudies(segmentInputs, [spec]);
    for (const output of segment.series) {
      const points = output.points.filter((point) => effectiveTimeSeriesPointTime(point) > start);
      const gap = gaps.get(start);
      if (gap && spec.kind !== "ratio" && spec.kind !== "spread" && spec.kind !== "volume") {
        // A gap just outside the visible window still invalidates the next
        // warmup observations. Keep those nulls and their original diagnostic
        // explicit so clipping cannot hide why a study is unavailable.
        const firstComputed = points[0] ? effectiveTimeSeriesPointTime(points[0]) : Number.POSITIVE_INFINITY;
        points.unshift(...segmentInputs[0]!.points.filter((point) => effectiveTimeSeriesPointTime(point) < firstComputed).map((point) => ({
          date: new Date(point.date), observedAt: new Date(point.observedAt),
          availableAt: point.availableAt ? new Date(point.availableAt) : undefined,
          value: null, provenance: gap.provenance,
        })));
      }
      const previous = outputs.get(output.id);
      outputs.set(output.id, { ...output, points: [...(previous?.points ?? []), ...points] });
    }
    for (const warning of segment.warnings) {
      if (!warning.includes("not enough valid history")) warnings.add(warning);
    }
    for (const error of segment.errors) errors.add(error);
    start = end;
  }
  for (const output of outputs.values()) {
    output.points.push(...gaps.values());
    output.points.sort((left, right) => left.date.getTime() - right.date.getTime());
  }
  return { series: [...outputs.values()], warnings: [...warnings], errors: [...errors] };
}

/** Base series that must be calculated for currently visible studies. */
export function activeStudyInputSeriesIds(
  studySpecs: readonly ChartStudySpec[],
): Set<string> {
  return new Set(studySpecs
    .filter((spec) => spec.visible !== false)
    .flatMap((spec) => spec.inputSeriesIds));
}

export function resolveStudies(
  baseSeries: readonly ResolvedSeries[],
  studySpecs: readonly ChartStudySpec[],
  marketResolution?: ManualChartResolution,
  historicalPriceSeries?: ReadonlyMap<string, ResolvedSeries>,
): StudyResolutionResult {
  const byId = new Map(baseSeries.map((series) => [series.id, series]));
  const resolved: ResolvedSeries[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  studySpecs.forEach((spec, index) => {
    if (spec.visible === false) return;
    const required = requiredInputs(spec.kind);
    const inputs = spec.inputSeriesIds.map((id) => spec.kind === "realized-vol"
      ? historicalPriceSeries?.get(id) ?? byId.get(id) : byId.get(id));
    if (inputs.length !== required || inputs.some((input) => !input)) {
      errors.push(`${spec.id}: ${spec.kind} requires ${required} valid input series.`);
      return;
    }
    const input = inputs[0]!;
    if (spec.kind === "spread") {
      const pairedInput = inputs[1]!;
      const inputUnit = knownUnitSignature(input);
      if (inputUnit === null || inputUnit !== knownUnitSignature(pairedInput)) {
        errors.push(`${spec.id}: spread cannot subtract ${pairedInput.label} (${pairedInput.unit || "unit unknown"}) from ${input.label} (${input.unit || "unit unknown"}); inputs require matching known units, currencies and scales.`);
        return;
      }
    }
    const color = spec.color ?? STUDY_COLORS[index % STUDY_COLORS.length]!;
    if (spec.kind === "realized-vol") {
      const window = spec.parameters.window ?? 30;
      if (typeof window !== "number" || !Number.isInteger(window) || window < 2
        || (spec.parameters.estimator !== undefined && !isRealizedVolatilityEstimator(spec.parameters.estimator))) {
        errors.push(`${spec.id}: choose a supported volatility estimator and a whole window of at least two sessions.`);
        return;
      }
      const inputResolution = input.historyResolution === undefined ? marketResolution : input.historyResolution;
      if (input.nativeFrequency !== "daily"
        || (inputResolution !== undefined && inputResolution !== "1d")
        || (input.timeBasis?.cadenceMs !== undefined && input.timeBasis.cadenceMs !== 86_400_000)
        || !(input.unitGroup === "price" || input.unitGroup.startsWith("price:"))) {
        errors.push(`${spec.id}: realized volatility requires daily prices. Choose Auto or 1D resolution and a daily price source.`);
        return;
      }
      const cadenceIssue = realizedVolatilityCadenceIssue(input.points);
      if (cadenceIssue) {
        errors.push(`${spec.id}: ${cadenceIssue}`);
        return;
      }
      const outputs = resolveRealizedVolatility(spec, input, color);
      if (outputs.every((output) => output.points.every((point) => point.value === null))) {
        warnings.push(`${spec.id}: not enough valid daily history to calculate ${spec.parameters.estimator ?? "close-to-close"} realized volatility.`);
      }
      resolved.push(...outputs);
      return;
    }
    const interrupted = resolveInterruptedStudy(inputs as ResolvedSeries[], { ...spec, color });
    if (interrupted) {
      resolved.push(...interrupted.series);
      warnings.push(...interrupted.warnings);
      errors.push(...interrupted.errors);
      return;
    }
    let outputs: ResolvedSeries[] = [];
    if (spec.kind === "sma") outputs = resolveMovingAverage(spec, input, color, false);
    else if (spec.kind === "ema") outputs = resolveMovingAverage(spec, input, color, true);
    else if (spec.kind === "bollinger") outputs = resolveBollinger(spec, input, color);
    else if (spec.kind === "rsi") outputs = resolveRsi(spec, input, color);
    else if (spec.kind === "macd") outputs = resolveMacd(spec, input, color);
    else if (spec.kind === "volume") {
      outputs = resolveVolume(spec, input, color);
      if (!input.volumeUnit && outputs.some((output) => output.points.length > 0)) {
        warnings.push(`Volume unit unknown: ${input.label}.`);
      }
    }
    else {
      const pairedInput = inputs[1]!;
      const inputCurrency = seriesCurrency(input);
      const pairedCurrency = seriesCurrency(pairedInput);
      const differentCurrencies = inputCurrency !== null
        && pairedCurrency !== null
        && inputCurrency !== pairedCurrency;
      if (spec.kind === "ratio" && differentCurrencies) {
        warnings.push(
          `${spec.id}: ${spec.kind} inputs use different currencies (${inputCurrency} and ${pairedCurrency}); raw values are not FX-converted.`,
        );
      }
      if (spec.kind === "correlation" && input.nativeFrequency !== pairedInput.nativeFrequency) {
        warnings.push(`${spec.id}: correlation mixes ${input.nativeFrequency} and ${pairedInput.nativeFrequency} observations; only matching observation times contribute.`);
      }
      outputs = resolvePairStudy(spec, input, pairedInput, color);
    }
    if (
      spec.kind !== "volume"
      && (outputs.length === 0 || outputs.every((output) => output.points.length === 0))
    ) {
      warnings.push(`${spec.id}: not enough valid history to calculate ${spec.kind}.`);
    }
    resolved.push(...outputs);
  });
  return { series: resolved, warnings, errors };
}
