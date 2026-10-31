import { mergePriceHistoryIntegrity } from "../../utils/price-history-integrity";
import { isRealizedVolatilityEstimator, rollingRealizedVolatility } from "../../market-data/realized-volatility";
import { averageTrueRange } from "../trader-studies";
import type { ChartStudySpec, ResolvedSeries, TimeSeriesPoint } from "../types";
import { isFiniteNumber } from "../../utils/guards";
import {
  derivedPoint,
  outputSeries,
  positiveInteger,
  samplesFor,
  STUDY_COLORS,
  studyBars,
  studyPeriod,
  type NumericSample,
} from "./shared";

export interface IndexedValue {
  index: number;
  value: number;
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

export function studyWarmupPoints(spec: ChartStudySpec): number {
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
  if (spec.kind === "atr") return studyPeriod(spec, 14) - 1;
  return 0;
}

export function resolveRealizedVolatility(spec: ChartStudySpec, input: ResolvedSeries, color: string): ResolvedSeries[] {
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

export function resolveMovingAverage(
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

export function resolveBollinger(
  spec: ChartStudySpec,
  input: ResolvedSeries,
  color: string,
): ResolvedSeries[] {
  const period = studyPeriod(spec, 20);
  const deviations = isFiniteNumber(spec.parameters.stdDev) && spec.parameters.stdDev > 0
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

export function resolveRsi(spec: ChartStudySpec, input: ResolvedSeries, color: string): ResolvedSeries[] {
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

export function resolveMacd(spec: ChartStudySpec, input: ResolvedSeries, color: string): ResolvedSeries[] {
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

export function resolveVolume(spec: ChartStudySpec, input: ResolvedSeries, color: string, nameInput: boolean): ResolvedSeries[] {
  // No bar has volume to plot (spot FX quotes 0 for every bar; a coin's window
  // can miss every bar's), so the study adds no panel rather than an empty one.
  if (input.points.length > 0 && !input.points.some((point) => isFiniteNumber(point.volume) && point.volume !== 0)) return [];
  // Left to its own colour, volume follows the candles: the price's colour for
  // a bar that rose, the falling colour for one that fell. A colour picked for it stays flat.
  const directional = !spec.color;
  const points = [...input.points]
    .sort((left, right) => left.date.getTime() - right.date.getTime())
    .flatMap((point) => isFiniteNumber(point.volume)
      ? [{
        ...derivedPoint({ point, value: point.volume }, point.volume),
        ...(directional && isFiniteNumber(point.open) && isFiniteNumber(point.close) && point.close < point.open ? { fell: true } : {}),
      }]
      : []);
  return [outputSeries(spec, input, {
    label: nameInput ? `Volume ${input.label}` : "Volume",
    points,
    color: directional ? input.color : color,
    unit: input.volumeUnit ?? "",
    unitGroup: "volume",
    style: "columns",
    axis: "left",
  })];
}

export function resolveAtr(spec: ChartStudySpec, input: ResolvedSeries, color: string, nameInput: boolean): ResolvedSeries[] {
  const period = studyPeriod(spec, 14);
  const bars = studyBars(input);
  return [outputSeries(spec, input, {
    label: nameInput ? `ATR(${period}) ${input.label}` : `ATR(${period})`,
    points: averageTrueRange(bars, period).flatMap(({ index, value }) => {
      const bar = bars[index];
      return bar ? [derivedPoint(bar.sample, value)] : [];
    }),
    color,
    axis: "left",
  })];
}
