import { alignTimeSeries, effectiveTimeSeriesPointTime, scalarPointValue } from "./alignment";
import { mergePriceHistoryIntegrity } from "../utils/price-history-integrity";
import { resolveCurrencyUnit } from "../utils/currency-units";
import { isRealizedVolatilityEstimator, realizedVolatilityCadenceIssue, rollingRealizedVolatility } from "../market-data/realized-volatility";
import { latestRegularSessionOpen } from "../market-data/market/freshness";
import { CHART_RESOLUTION_STEP_MS, isIntradayResolution, type ManualChartResolution } from "./resolution";
import { anchoredVwap, averageTrueRange, sessionVwap, type StudyBar, type VwapValue } from "./trader-studies";
import { zonedDateTimeParts } from "../utils/zoned-date-time";
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
import { isFiniteNumber } from "../utils/guards";

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
/**
 * Overlays that sit on the price keep colours of their own, never the blue the
 * first price series takes; the profile is grey so it stays behind the bars.
 */
const KIND_COLORS: Partial<Record<ChartStudyKind, string>> = {
  vwap: "#ffa94d",
  "anchored-vwap": "#b197fc",
  "volume-profile": "#adb5bd",
  atr: "#63e6be",
};
/**
 * One per anchor, so eight lines never repeat a colour. None is red or pink
 * (falling candles take the theme's negative), orange (VWAP), yellow (the
 * first moving average) or blue (the price).
 */
const ANCHOR_COLORS = ["#b197fc", "#66d9e8", "#8ce99a", "#e599f7", "#9775fa", "#3bc9db", "#c0eb75", "#d0bfff"];

function positiveInteger(value: unknown, fallback: number): number {
  return isFiniteNumber(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
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
  if (spec.kind === "atr") return studyPeriod(spec, 14) - 1;
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

function resolveVolume(spec: ChartStudySpec, input: ResolvedSeries, color: string, nameInput: boolean): ResolvedSeries[] {
  // Spot FX and similar quotes report 0 for every bar: there is no volume to
  // plot, so the study adds no panel rather than an empty one.
  if (input.points.some((point) => point.volume === 0) && input.points.every((point) => !point.volume)) return [];
  const points = [...input.points]
    .sort((left, right) => left.date.getTime() - right.date.getTime())
    .flatMap((point) => isFiniteNumber(point.volume)
      ? [derivedPoint({ point, value: point.volume }, point.volume)]
      : []);
  return [outputSeries(spec, input, {
    label: nameInput ? `Volume ${input.label}` : "Volume",
    points,
    color,
    unit: input.volumeUnit ?? "",
    unitGroup: "volume",
    style: "columns",
    axis: "left",
  })];
}

const DAY_MS = 86_400_000;
/** Most anchors one anchored VWAP keeps; each draws its own line. */
const MAX_VWAP_ANCHORS = 8;
export const DEFAULT_PROFILE_ROWS = 24;

/** Anchor times of an anchored VWAP, kept as `anchor1`, `anchor2`, ... so the spec stays numeric. */
export function vwapAnchors(spec: Pick<ChartStudySpec, "parameters">): number[] {
  return [...new Set(Object.entries(spec.parameters)
    .filter(([key, value]) => /^anchor\d+$/.test(key) && isFiniteNumber(value))
    .map(([, value]) => value as number))]
    .sort((left, right) => left - right)
    .slice(0, MAX_VWAP_ANCHORS);
}

export function withVwapAnchors(
  parameters: ChartStudySpec["parameters"],
  anchors: readonly number[],
): ChartStudySpec["parameters"] {
  const kept = Object.fromEntries(Object.entries(parameters).filter(([key]) => !/^anchor\d+$/.test(key)));
  const sorted = [...new Set(anchors.filter(Number.isFinite))].sort((left, right) => left - right).slice(-MAX_VWAP_ANCHORS);
  return { ...kept, ...Object.fromEntries(sorted.map((anchor, index) => [`anchor${index + 1}`, anchor])) };
}

/** Bars with a range and volume; a close-only point stands for a bar with no range. */
function studyBars(input: ResolvedSeries): Array<StudyBar & { sample: NumericSample }> {
  return samplesFor(input).flatMap((sample) => {
    const close = isFiniteNumber(sample.point.close) ? sample.point.close : sample.value;
    const high = isFiniteNumber(sample.point.high) ? sample.point.high : close;
    const low = isFiniteNumber(sample.point.low) ? sample.point.low : close;
    return [{
      time: sample.point.date.getTime(),
      high: Math.max(high, low, close),
      low: Math.min(high, low, close),
      close,
      volume: isFiniteNumber(sample.point.volume) ? sample.point.volume : 0,
      sample,
    }];
  });
}

function isIntradayInput(input: ResolvedSeries, marketResolution?: ManualChartResolution): boolean {
  const resolution = input.historyResolution === undefined ? marketResolution : input.historyResolution;
  if (resolution) return isIntradayResolution(resolution);
  const cadence = input.timeBasis?.cadenceMs;
  return cadence !== undefined && cadence < DAY_MS;
}

function localDay(time: number, timeZone: string | undefined): number {
  if (!timeZone) return Math.floor(time / DAY_MS);
  const { year, month, day } = zonedDateTimeParts(time, timeZone);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

/**
 * `step` at each of `times` (ascending) for a step function that never falls
 * as time moves on, such as a session's open or a local day. It is asked at
 * both ends of a run and a run whose ends agree takes that value throughout,
 * so a few calendar lookups per session cover every bar. The live chart
 * resolves on every quote, and a lookup per 1-minute bar took tens of
 * milliseconds over a week.
 */
function risingSteps<T>(times: readonly number[], step: (time: number) => T): T[] {
  const values = new Array<T>(times.length);
  if (times.length === 0) return values;
  const last = times.length - 1;
  values[0] = step(times[0]!);
  values[last] = step(times[last]!);
  const fill = (from: number, to: number): void => {
    if (to - from < 2) return;
    if (values[from] === values[to]) {
      values.fill(values[from]!, from + 1, to);
      return;
    }
    const middle = (from + to) >> 1;
    values[middle] = step(times[middle]!);
    fill(from, middle);
    fill(middle, to);
  };
  fill(0, last);
  return values;
}

/**
 * Each bar's session, named by the regular open it follows, so the sums
 * restart at the open and a bar before it continues the previous session. A
 * venue without known hours starts over with each local day. The first
 * session is left out when the history begins after its open, since its sums
 * would be missing the bars before.
 */
function regularSessionKeys(bars: readonly StudyBar[], input: ResolvedSeries): Array<number | null> {
  const exchange = input.timeBasis?.exchange;
  const step = input.timeBasis?.cadenceMs ?? 60_000;
  const times = bars.map((bar) => bar.time);
  const opens = risingSteps(times, (time) => latestRegularSessionOpen(exchange, time));
  const days = opens.includes(null) ? risingSteps(times, (time) => localDay(time, input.timeBasis?.timeZone)) : [];
  const keys = opens.map((open, index) => open ?? -1 - days[index]!);
  const first = keys[0];
  if (first !== undefined && first >= 0 && bars[0]!.time >= first + step) {
    return keys.map((key) => key === first ? null : key);
  }
  return keys;
}

function vwapOutputs(
  spec: ChartStudySpec,
  input: ResolvedSeries,
  bars: ReadonlyArray<{ sample: NumericSample }>,
  values: readonly VwapValue[],
  options: { id: string; label: string; color: string; bands: number },
): ResolvedSeries[] {
  const at = (pick: (value: VwapValue) => number) => values.flatMap((value) => {
    const bar = bars[value.index];
    return bar ? [derivedPoint(bar.sample, pick(value))] : [];
  });
  const outputs = [outputSeries(spec, input, {
    id: options.id,
    label: options.label,
    points: at((value) => value.value),
    color: options.color,
  })];
  if (options.bands > 0) {
    outputs.push(
      outputSeries(spec, input, {
        id: `${options.id}:upper`,
        label: `${options.label} +${options.bands}σ`,
        points: at((value) => value.value + value.deviation * options.bands),
        color: options.color,
      }),
      outputSeries(spec, input, {
        id: `${options.id}:lower`,
        label: `${options.label} -${options.bands}σ`,
        points: at((value) => value.value - value.deviation * options.bands),
        color: options.color,
      }),
    );
  }
  return outputs;
}

function hasVolume(bars: readonly StudyBar[]): boolean {
  return bars.some((bar) => bar.volume > 0);
}

function resolveVwap(
  spec: ChartStudySpec,
  input: ResolvedSeries,
  color: string,
  nameInput: boolean,
  marketResolution: ManualChartResolution | undefined,
  warnings: string[],
): ResolvedSeries[] {
  const label = nameInput ? `VWAP ${input.label}` : "VWAP";
  if (!isIntradayInput(input, marketResolution)) {
    warnings.push(`${label} needs intraday bars: choose 1D or 1W, or a minute timeframe.`);
    return [];
  }
  const bars = studyBars(input);
  if (!hasVolume(bars)) {
    warnings.push(`${label} needs traded volume, which ${input.label} does not report.`);
    return [];
  }
  const keys = regularSessionKeys(bars, input);
  const bands = Math.min(3, Math.max(0, Math.round(isFiniteNumber(spec.parameters.bands) ? spec.parameters.bands : 0)));
  return vwapOutputs(spec, input, bars, sessionVwap(bars, (_bar, index) => keys[index] ?? null), {
    id: spec.id,
    label,
    color,
    bands,
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Sep 30 09:30` on intraday bars, in the exchange's time; `Sep 30 2025` on daily ones. */
function formatAnchor(anchor: number, input: ResolvedSeries, intraday: boolean): string {
  const parts = zonedDateTimeParts(anchor, intraday ? input.timeBasis?.timeZone ?? "UTC" : "UTC");
  const date = `${MONTHS[parts.month - 1]} ${parts.day}`;
  return intraday
    ? `${date} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`
    : `${date} ${parts.year}`;
}

/**
 * Whether the loaded bars reach back to an anchor: a bar at or before it, or
 * the first bar opening the same local day the anchor names.
 */
function historyReaches(bars: readonly StudyBar[], anchor: number, input: ResolvedSeries): boolean {
  const first = bars[0];
  if (!first) return false;
  if (first.time <= anchor) return true;
  const timeZone = input.timeBasis?.timeZone;
  if (localDay(first.time, timeZone) !== localDay(anchor, timeZone)) return false;
  const open = latestRegularSessionOpen(input.timeBasis?.exchange, first.time);
  return open === null || first.time < open + (input.timeBasis?.cadenceMs ?? DAY_MS);
}

function resolveAnchoredVwap(
  spec: ChartStudySpec,
  input: ResolvedSeries,
  color: string,
  marketResolution: ManualChartResolution | undefined,
  warnings: string[],
): ResolvedSeries[] {
  const anchors = vwapAnchors(spec);
  if (anchors.length === 0) return [];
  const bars = studyBars(input);
  if (!hasVolume(bars)) {
    warnings.push(`Anchored VWAP needs traded volume, which ${input.label} does not report.`);
    return [];
  }
  const intraday = isIntradayInput(input, marketResolution);
  const resolution = input.historyResolution ?? marketResolution;
  const barMs = input.timeBasis?.cadenceMs ?? (resolution ? CHART_RESOLUTION_STEP_MS[resolution] : 0);
  return anchors.flatMap((anchor, offset) => {
    const label = `AVWAP ${formatAnchor(anchor, input, intraday)}`;
    if (!historyReaches(bars, anchor, input)) {
      warnings.push(`${label} starts before the loaded history; choose a longer range.`);
      return [];
    }
    return vwapOutputs(spec, input, bars, anchoredVwap(bars, anchor, barMs), {
      id: `${spec.id}:${anchor}`,
      label,
      color: offset === 0 ? color : ANCHOR_COLORS[offset % ANCHOR_COLORS.length]!,
      bands: 0,
    });
  });
}

function resolveAtr(spec: ChartStudySpec, input: ResolvedSeries, color: string, nameInput: boolean): ResolvedSeries[] {
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

/** The input's bars, passed through for the chart to profile over what is in view. */
function resolveVolumeProfile(
  spec: ChartStudySpec,
  input: ResolvedSeries,
  color: string,
  warnings: string[],
): ResolvedSeries[] {
  if (input.transform !== "raw") {
    warnings.push("Volume profile needs prices; switch the price series back to its own values.");
    return [];
  }
  const bars = studyBars(input);
  if (!hasVolume(bars)) {
    warnings.push(`Volume profile needs traded volume, which ${input.label} does not report.`);
    return [];
  }
  const rows = Math.min(100, Math.max(4, Math.round(isFiniteNumber(spec.parameters.rows) ? spec.parameters.rows : DEFAULT_PROFILE_ROWS)));
  return [{
    ...outputSeries(spec, input, {
      label: "VP POC",
      points: bars.map(({ sample }) => ({
        ...derivedPoint(sample, sample.value),
        open: sample.point.open,
        high: sample.point.high,
        low: sample.point.low,
        close: sample.point.close,
        volume: sample.point.volume,
      })),
      color,
    }),
    profile: { rows },
  }];
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

function resolvePairStudy(
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
  nameVolumeInput: boolean,
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
    const segment = resolveStudySpecs(segmentInputs, [spec], nameVolumeInput);
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
  // With one security on the chart its volume is just "Volume"; beside a
  // comparison the legend names whose volume it is.
  const nameVolumeInput = baseSeries.filter((series) => series.observationKind === "market").length > 1;
  return resolveStudySpecs(baseSeries, studySpecs, nameVolumeInput, marketResolution, historicalPriceSeries);
}

function resolveStudySpecs(
  baseSeries: readonly ResolvedSeries[],
  studySpecs: readonly ChartStudySpec[],
  nameVolumeInput: boolean,
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
    const color = spec.color ?? KIND_COLORS[spec.kind] ?? STUDY_COLORS[index % STUDY_COLORS.length]!;
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
    const interrupted = resolveInterruptedStudy(inputs as ResolvedSeries[], { ...spec, color }, nameVolumeInput);
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
    else if (spec.kind === "atr") outputs = resolveAtr(spec, input, color, nameVolumeInput);
    else if (spec.kind === "vwap" || spec.kind === "anchored-vwap" || spec.kind === "volume-profile") {
      outputs = spec.kind === "vwap"
        ? resolveVwap(spec, input, color, nameVolumeInput, marketResolution, warnings)
        : spec.kind === "anchored-vwap"
          ? resolveAnchoredVwap(spec, input, color, marketResolution, warnings)
          : resolveVolumeProfile(spec, input, color, warnings);
      resolved.push(...outputs);
      return;
    }
    else if (spec.kind === "volume") {
      outputs = resolveVolume(spec, input, color, nameVolumeInput);
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
