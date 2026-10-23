import { alignTimeSeries, effectiveTimeSeriesPointTime, scalarPointValue } from "./alignment";
import { mergePriceHistoryIntegrity } from "../utils/price-history-integrity";
import { resolveCurrencyUnit } from "../utils/currency-units";
import { isRealizedVolatilityEstimator, realizedVolatilityCadenceIssue, rollingRealizedVolatility } from "../market-data/realized-volatility";
import { latestTradingSessionOpen } from "../market-data/market/trading-sessions";
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
import { studyMessageName } from "./series-name";
import { dailyLeverageGrowth, isLeverageFactor, leverageDecayPoints, leverageFactorLabel, leverageSymbol, sessionCloses, type StudyAnchor } from "./leverage";
import { GALLONS_PER_BARREL, isPerBarrelUnit, isPerGallonUnit, perBarrelUnit, quantityIdentity, unitCurrencyToken } from "./price-units";

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
  leverage: "#e599f7",
};
/** The decay study's two lines: the fund against the daily line, the daily line against the period multiple. */
const DECAY_COLORS = ["#ffa94d", "#66d9e8"] as const;
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
    /** The unit the legend states; by default the input's, while the output keeps its unit. */
    statedUnit?: string | null;
    /** The kind of price the output is, for its decimals; by default the input's, while the output keeps its unit. */
    priceAssetCategory?: string | null;
  },
): ResolvedSeries {
  const historyResolution = options.historyResolution === undefined ? input.historyResolution : options.historyResolution;
  const sameUnit = (options.unit ?? input.unit) === input.unit && (options.unitGroup ?? input.unitGroup) === input.unitGroup;
  const statedUnit = options.statedUnit === undefined ? sameUnit ? input.statedUnit : undefined : options.statedUnit ?? undefined;
  return {
    id: options.id ?? spec.id,
    label: options.label,
    color: options.color,
    unit: options.unit ?? input.unit,
    unitGroup: options.unitGroup ?? input.unitGroup,
    ...(statedUnit ? { statedUnit } : {}),
    priceAssetCategory: options.priceAssetCategory === undefined
      ? sameUnit ? input.priceAssetCategory : undefined
      : options.priceAssetCategory ?? undefined,
    nativeFrequency: options.nativeFrequency ?? input.nativeFrequency,
    ...(historyResolution !== undefined ? { historyResolution } : {}),
    ...(input.historyStart && historyResolution === input.historyResolution ? { historyStart: input.historyStart } : {}),
    ...(input.barSize && historyResolution === input.historyResolution ? { barSize: input.barSize } : {}),
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
  // No bar has volume to plot (spot FX quotes 0 for every bar; a coin's window
  // can miss every bar's), so the study adds no panel rather than an empty one.
  if (input.points.length > 0 && !input.points.some((point) => isFiniteNumber(point.volume) && point.volume !== 0)) return [];
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

/** When the session holding `time` opened on the input's listing, or null for a venue without known hours. */
function sessionOpenOf(input: ResolvedSeries): (time: number) => number | null {
  const symbol = input.listing?.symbol;
  const exchange = input.listing?.exchange || input.timeBasis?.exchange;
  return (time) => latestTradingSessionOpen(symbol, exchange, time);
}

/** The bar spacing: the requested cadence, else the history's resolution, else a minute. */
function barStep(input: ResolvedSeries): number {
  return input.timeBasis?.cadenceMs
    ?? (input.historyResolution ? CHART_RESOLUTION_STEP_MS[input.historyResolution] : undefined)
    ?? 60_000;
}

/**
 * Each bar's session, named by the open it follows, so the sums restart at
 * the open and a bar before it continues the previous session: the regular
 * open for stocks, the venue's published session open for futures (17:00
 * Central on CME Globex). A venue without known hours starts over with each
 * local day. The first session is left out when the history begins after its
 * open, since its sums would be missing the bars before.
 */
function regularSessionKeys(bars: readonly StudyBar[], input: ResolvedSeries): Array<number | null> {
  const step = barStep(input);
  const times = bars.map((bar) => bar.time);
  const opens = risingSteps(times, sessionOpenOf(input));
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
  options: { id: string; label: string; color: string; bands: number; sessionOf?: (index: number) => number | null },
): ResolvedSeries[] {
  // A value opening a new session follows a missing one just before it, so
  // the line restarts there instead of joining the sessions with a diagonal.
  const at = (pick: (value: VwapValue) => number) => values.flatMap((value, position) => {
    const bar = bars[value.index];
    if (!bar) return [];
    const point = derivedPoint(bar.sample, pick(value));
    const previous = values[position - 1];
    if (!previous || !options.sessionOf || options.sessionOf(previous.index) === options.sessionOf(value.index)) return [point];
    const before = new Date(point.date.getTime() - 1);
    return [{ ...derivedPoint(bar.sample, null), date: before, observedAt: before }, point];
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
    sessionOf: (index) => keys[index] ?? null,
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
  const open = sessionOpenOf(input)(first.time);
  return open === null || first.time < open + barStep(input);
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
  // "US cents", as futures terms word a grain's quote, is the USX the quote names.
  const token = unitCurrencyToken(value) ?? value.trim();
  if (/^[A-Za-z]{3}$/.test(token)) {
    const { currency, divisor } = resolveCurrencyUnit(token);
    return `${currency}:${divisor}`;
  }
  return quantityIdentity(token);
}

function knownUnitSignature(series: Pick<ResolvedSeries, "unit" | "unitGroup">): string | null {
  const unit = series.unit.trim();
  if (!unit || /(?:^|\W)(?:currency|unknown|unspecified|n\/a)(?:$|\W)/i.test(unit)
    || /^(?:units?|[-?]+)$/i.test(unit)) return null;
  const parts = unit.split("/");
  if (parts.some((part) => !part.trim() || /^[-?]+$/.test(part.trim()))) return null;

  const monetary = series.unitGroup.match(/^(price|currency-total|per-share)(?::([^:]+))?$/);
  // A futures contract writes its unit spaced ("USD / gallon"); a catalog series does not ("USD/gallon").
  const currency = unitCurrencyToken(parts[0]!);
  if (monetary && (!currency || (monetary[2] && unitFactorIdentity(monetary[2]) !== unitFactorIdentity(currency)))) return null;

  // Currency alone does not establish a price's physical/share basis. A scalar
  // multiplier cannot establish it either. Explicit USD/share price and EPS
  // units, however, match despite different groups.
  if (monetary?.[1] === "price" && !unit.includes("/")) return null;
  const basis = monetary && !unit.includes("/") ? monetary[1] : "";
  // Keep currency scale and compound order: GBp/GBX are pence, not pounds;
  // USD/EUR cannot subtract EUR/USD.
  return `${basis ?? ""}|${parts.map(unitFactorIdentity).join("/")}`;
}

/** A leg as an error names it: its ticker (HO=F), else its label. */
function legName(series: ResolvedSeries): string {
  return series.listing?.symbol || series.label;
}

/** What a leg's unit is, in words: "is USD / gallon", "is in %", "is in USD per an unknown quantity". */
function unitPhrase(series: ResolvedSeries, unit: string): string {
  const text = unit.trim();
  // A rate reads as itself (HO=F is USD / gallon); an amount or a scale is what a leg is in (REVENUE is in USD).
  if (knownUnitSignature({ unit: text, unitGroup: series.unitGroup }) !== null) return text.includes("/") ? `is ${text}` : `is in ${text}`;
  if (unitCurrencyToken(text) && /^price(?::|$)/.test(series.unitGroup)) return `is in ${text} per an unknown quantity`;
  return "has no known unit";
}

function unitCurrency(series: ResolvedSeries, unit: string): string | null {
  const token = unitCurrencyToken(unit.split("/")[0] ?? "");
  return token ? unitFactorIdentity(token) : seriesCurrency(series);
}

/**
 * Why two legs cannot be added or subtracted, naming each one's unit and the
 * fix: a per-gallon leg beside a per-barrel one is 42 gallons short of it.
 */
function unitMismatchMessage(
  kind: "spread" | "formula",
  left: { series: ResolvedSeries; unit: string },
  right: { series: ResolvedSeries; unit: string },
): string {
  // Two fields of one listing are told apart by their labels.
  const [leftName, rightName] = legName(left.series) === legName(right.series)
    ? [left.series.label, right.series.label]
    : [legName(left.series), legName(right.series)];
  const named = `${leftName} ${unitPhrase(left.series, left.unit)} and ${rightName} ${unitPhrase(right.series, right.unit)}`;
  const leftCurrency = unitCurrency(left.series, left.unit);
  const rightCurrency = unitCurrency(right.series, right.unit);
  const gallons = isPerGallonUnit(left.unit) && isPerBarrelUnit(right.unit) ? leftName
    : isPerBarrelUnit(left.unit) && isPerGallonUnit(right.unit) ? rightName : null;
  if (gallons && leftCurrency === rightCurrency) {
    return `${named}: write ${GALLONS_PER_BARREL}*${gallons} to compare per barrel.`;
  }
  const subject = kind === "spread" ? "a spread" : "a formula";
  if (leftCurrency && rightCurrency && leftCurrency !== rightCurrency) return `${named}: ${subject} does not convert currencies.`;
  const known = knownUnitSignature({ unit: left.unit, unitGroup: left.series.unitGroup }) !== null
    && knownUnitSignature({ unit: right.unit, unitGroup: right.series.unitGroup }) !== null;
  return `${named}: ${subject} needs ${kind === "spread" ? "both" : "every leg"} in one${known ? "" : " known"} unit.`;
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

/** Formulas of levels, which carry each input's latest value to the other inputs' dates. */
function isLevelFormula(kind: ChartStudyKind): boolean {
  return kind === "ratio" || kind === "spread" || kind === "formula";
}

interface FormulaTerms {
  /** Each input's multiplier, in input order. */
  weights: number[];
  /** Whether an input's multiplier carries the 42 gallons that make its per-gallon price per barrel. */
  perBarrel: boolean[];
  divisor: number;
}

/**
 * A formula study's terms: `weight1`, `perBarrel1`, ... per input, and an
 * optional `divisor`. A saved or hand-edited spec can carry a multiplier or
 * divisor no formula was written with (a value that is not a number is
 * dropped when the spec loads, so it arrives missing); that is an error, not
 * a silent 1.
 */
function formulaTerms(spec: ChartStudySpec, inputs: readonly ResolvedSeries[]): FormulaTerms | { error: string } {
  const weights: number[] = [];
  for (const [index, input] of inputs.entries()) {
    const weight = spec.parameters[`weight${index + 1}`];
    if (!isFiniteNumber(weight)) return { error: `The multiplier of ${legName(input)} is missing or not a number; write the formula again.` };
    if (weight === 0) return { error: `${legName(input)} has a multiplier of 0, which removes it; leave it out of the formula instead.` };
    weights.push(weight);
  }
  const divisor = spec.parameters.divisor ?? 1;
  if (!isFiniteNumber(divisor)) return { error: "The formula's divisor is not a number; write the formula again." };
  if (divisor === 0) return { error: "A formula cannot be divided by 0." };
  return {
    weights,
    perBarrel: inputs.map((_, index) => spec.parameters[`perBarrel${index + 1}`] === 1),
    divisor,
  };
}

/** Each input's unit once its multiplier is applied: 42 gallons of a per-gallon price are a barrel's worth. */
function formulaLegUnits(terms: FormulaTerms, inputs: readonly ResolvedSeries[]): string[] {
  return inputs.map((input, index) => terms.perBarrel[index] ? perBarrelUnit(input.unit) : input.unit);
}

/** Why a formula's legs cannot be summed, or null when every leg counts the same known unit. */
function formulaUnitMismatch(terms: FormulaTerms, inputs: readonly ResolvedSeries[]): string | null {
  if (inputs.length < 2) return null;
  const units = formulaLegUnits(terms, inputs);
  const signatures = inputs.map((input, index) => knownUnitSignature({ unit: units[index]!, unitGroup: input.unitGroup }));
  const other = signatures.findIndex((signature, index) => index > 0 && (signature === null || signature !== signatures[0]));
  if (signatures[0] !== null && other < 0) return null;
  const right = Math.max(1, other);
  return unitMismatchMessage("formula", { series: inputs[0]!, unit: units[0]! }, { series: inputs[right]!, unit: units[right]! });
}

function formatFormulaNumber(value: number): string {
  return String(Number(value.toPrecision(10)));
}

/**
 * A formula as the legend names it, from the terms it was written with:
 * `42×HO=F - CL=F`, `(2×42×RB=F + 42×HO=F - 3×CL=F)/3`.
 */
function formulaLabel(inputs: readonly ResolvedSeries[], terms: FormulaTerms): string {
  const sum = inputs.map((input, index) => {
    const weight = terms.weights[index]!;
    const magnitude = Math.abs(weight);
    const factors = terms.perBarrel[index]
      ? [...(magnitude === GALLONS_PER_BARREL ? [] : [formatFormulaNumber(magnitude / GALLONS_PER_BARREL)]), String(GALLONS_PER_BARREL)]
      : magnitude === 1 ? [] : [formatFormulaNumber(magnitude)];
    const term = [...factors, legName(input)].join("×");
    if (index === 0) return weight < 0 ? `-${term}` : term;
    return `${weight < 0 ? "-" : "+"} ${term}`;
  }).join(" ");
  return terms.divisor === 1 ? sum : `(${sum})/${formatFormulaNumber(terms.divisor)}`;
}

/** Every input's value on each date they share, each carried forward to the others' dates. */
function alignedSamples(inputs: readonly ResolvedSeries[]): Array<{ point: TimeSeriesPoint; values: number[] }> {
  return alignTimeSeries(inputs, { mode: "intersection", carryForward: true }).flatMap((row) => {
    const aligned = inputs.map((input) => row.values[input.id]);
    if (aligned.some((entry) => !isFiniteNumber(entry?.value))) return [];
    const availability = Math.max(...aligned.map((entry) => entry!.point.availableAt?.getTime() ?? entry!.point.date.getTime()));
    return [{
      values: aligned.map((entry) => entry!.value as number),
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

/** A weighted sum of the inputs over a divisor, in the unit the legs share once converted. */
function resolveFormula(
  spec: ChartStudySpec,
  inputs: readonly ResolvedSeries[],
  terms: FormulaTerms,
  color: string,
): ResolvedSeries[] {
  const first = inputs[0]!;
  const unit = formulaLegUnits(terms, inputs)[0]!;
  // Rounded off the float's last digits: 42 × 4.6233 - 96.12 is 98.0586, not 98.05860000000001.
  const points = alignedSamples(inputs).map(({ point, values }) => derivedPoint(
    { point, value: 0 },
    Number((values.reduce((sum, value, index) => sum + value * terms.weights[index]!, 0) / terms.divisor).toPrecision(12)),
  ));
  const frequencies = new Set(inputs.map((input) => input.nativeFrequency));
  const resolutions = new Set(inputs.map((input) => input.historyResolution));
  return [outputSeries(spec, first, {
    label: formulaLabel(inputs, terms),
    points,
    color,
    unit,
    unitGroup: first.unitGroup,
    statedUnit: inputs.some((input) => input.statedUnit) ? unit : null,
    // A weighted sum is no traded price: its decimals are a value's, not a contract's tick.
    priceAssetCategory: null,
    // As the pair formulas: as-of levels, constant until an input changes.
    style: "step",
    interpolation: "step-after",
    axis: "left",
    nativeFrequency: frequencies.size === 1 ? first.nativeFrequency : "auto",
    historyResolution: resolutions.size === 1 ? first.historyResolution : null,
  })];
}

function requiredInputs(kind: ChartStudyKind): number {
  return kind === "ratio" || kind === "spread" || kind === "correlation" || kind === "leverage-decay" ? 2 : 1;
}

/** The objective's line and its decay compound session returns: they need daily bars, whatever the chart's range. */
function dailyBarsIssue(spec: ChartStudySpec, input: ResolvedSeries, marketResolution: ManualChartResolution | undefined): string | null {
  const resolution = input.historyResolution === undefined ? marketResolution : input.historyResolution;
  if (input.nativeFrequency === "daily" && (resolution === undefined || resolution === "1d")) return null;
  return `${studyMessageName(spec)}: ${leverageFactorLabel(Number(spec.parameters.factor))} daily needs daily bars. Choose D bars.`;
}

/**
 * The line a leveraged or inverse fund's daily objective draws from its index
 * fund, in percent from where the chart compares (3× daily QQQ beside TQQQ),
 * on the percent axis the compared legs share.
 */
function resolveLeverageLine(spec: ChartStudySpec, index: ResolvedSeries, color: string, anchor: StudyAnchor | undefined): ResolvedSeries[] {
  const factor = spec.parameters.factor as number;
  const closes = sessionCloses(index, anchor);
  const growth = dailyLeverageGrowth(closes.map((entry) => entry.close), factor);
  return [outputSeries(spec, index, {
    label: `${leverageFactorLabel(factor)} daily ${leverageSymbol(index)}`,
    points: closes.map((entry, position) => derivedPoint({ point: entry.point, value: entry.close }, (growth[position]! - 1) * 100)),
    color,
    unit: "%",
    unitGroup: "percent",
    statedUnit: null,
    priceAssetCategory: null,
    axis: "left",
  })];
}

/**
 * How far the fund falls short of its daily objective, in percentage points
 * from where the chart compares: the fund against the daily line (fees,
 * financing, tracking), and the daily line against the factor times the index
 * fund's return over the period (compounding, which daily resets cost in a
 * market that swings).
 */
function resolveLeverageDecay(
  spec: ChartStudySpec,
  fund: ResolvedSeries,
  index: ResolvedSeries,
  anchors: ReadonlyMap<string, StudyAnchor> | undefined,
): ResolvedSeries[] {
  const factor = spec.parameters.factor as number;
  const decay = leverageDecayPoints(sessionCloses(fund, anchors?.get(fund.id)), sessionCloses(index, anchors?.get(index.id)), factor);
  const daily = `${leverageFactorLabel(factor)} daily`;
  const line = (id: string, label: string, color: string, value: (point: (typeof decay)[number]) => number) => outputSeries(spec, fund, {
    id: `${spec.id}:${id}`,
    label,
    points: decay.map((entry) => derivedPoint({ point: entry.point, value: entry.fund }, value(entry))),
    color: spec.color ?? color,
    unit: "pp",
    // Not a percent group: a difference of returns reads in points (-0.96 pp), not as a return.
    unitGroup: "pp",
    statedUnit: null,
    priceAssetCategory: null,
    axis: "left",
  });
  return [
    line("fund", `${leverageSymbol(fund)} decay vs ${daily} ${leverageSymbol(index)}`, DECAY_COLORS[0], (entry) => entry.fund - entry.daily),
    // `3× QQQ`: three times QQQ's return over the period, the multiple a daily reset does not deliver.
    line("compounding", `${daily} ${leverageSymbol(index)} decay vs ${leverageFactorLabel(factor)} ${leverageSymbol(index)}`, DECAY_COLORS[1], (entry) => entry.daily - entry.period),
  ];
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
      if (isLevelFormula(spec.kind)) {
        if (previous && !previous.provenance?.priceHistoryIntegrity && !previous.provenance?.valuationPriceIssues?.length) points.unshift(previous);
      }
      return { ...cursor.input, points };
    });
    const segment = resolveStudySpecs(segmentInputs, [spec], nameVolumeInput);
    for (const output of segment.series) {
      const points = output.points.filter((point) => effectiveTimeSeriesPointTime(point) > start);
      const gap = gaps.get(start);
      if (gap && !isLevelFormula(spec.kind) && spec.kind !== "volume") {
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

/**
 * `anchors`: where each input series is measured from and to, for studies
 * that read returns over the chart's period (a leveraged fund's daily line and
 * its decay start where a comparison starts its legs). Without one, a series'
 * own first and last observations.
 */
export function resolveStudies(
  baseSeries: readonly ResolvedSeries[],
  studySpecs: readonly ChartStudySpec[],
  marketResolution?: ManualChartResolution,
  historicalPriceSeries?: ReadonlyMap<string, ResolvedSeries>,
  anchors?: ReadonlyMap<string, StudyAnchor>,
): StudyResolutionResult {
  // With one security on the chart its volume is just "Volume"; beside a
  // comparison the legend names whose volume it is.
  const nameVolumeInput = baseSeries.filter((series) => series.observationKind === "market").length > 1;
  return resolveStudySpecs(baseSeries, studySpecs, nameVolumeInput, marketResolution, historicalPriceSeries, anchors);
}

function resolveStudySpecs(
  baseSeries: readonly ResolvedSeries[],
  studySpecs: readonly ChartStudySpec[],
  nameVolumeInput: boolean,
  marketResolution?: ManualChartResolution,
  historicalPriceSeries?: ReadonlyMap<string, ResolvedSeries>,
  anchors?: ReadonlyMap<string, StudyAnchor>,
): StudyResolutionResult {
  const byId = new Map(baseSeries.map((series) => [series.id, series]));
  const resolved: ResolvedSeries[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  studySpecs.forEach((spec, index) => {
    if (spec.visible === false) return;
    const required = spec.kind === "formula" ? Math.max(1, spec.inputSeriesIds.length) : requiredInputs(spec.kind);
    const inputs = spec.inputSeriesIds.map((id) => spec.kind === "realized-vol"
      ? historicalPriceSeries?.get(id) ?? byId.get(id) : byId.get(id));
    if (inputs.length !== required || inputs.some((input) => !input)) {
      errors.push(`${studyMessageName(spec)}: ${spec.kind} requires ${required} valid input series.`);
      return;
    }
    const input = inputs[0]!;
    if (spec.kind === "spread") {
      const pairedInput = inputs[1]!;
      const inputUnit = knownUnitSignature(input);
      if (inputUnit === null || inputUnit !== knownUnitSignature(pairedInput)) {
        errors.push(`${studyMessageName(spec)}: ${unitMismatchMessage("spread", { series: input, unit: input.unit }, { series: pairedInput, unit: pairedInput.unit })}`);
        return;
      }
    }
    let terms: FormulaTerms | null = null;
    if (spec.kind === "formula") {
      const read = formulaTerms(spec, inputs as ResolvedSeries[]);
      const mismatch = "error" in read ? read.error : formulaUnitMismatch(read, inputs as ResolvedSeries[]);
      if (mismatch) {
        errors.push(`${studyMessageName(spec)}: ${mismatch}`);
        return;
      }
      terms = read as FormulaTerms;
    }
    const color = spec.color ?? KIND_COLORS[spec.kind] ?? STUDY_COLORS[index % STUDY_COLORS.length]!;
    if (spec.kind === "leverage" || spec.kind === "leverage-decay") {
      const index = inputs.at(-1)!;
      if (!isLeverageFactor(spec.parameters.factor)) {
        errors.push(`${studyMessageName(spec)}: choose a nonzero leverage factor of at most 5.`);
        return;
      }
      const issue = inputs.map((entry) => dailyBarsIssue(spec, entry!, marketResolution)).find(Boolean);
      if (issue) {
        warnings.push(issue);
        return;
      }
      const outputs = spec.kind === "leverage"
        ? resolveLeverageLine(spec, index, color, anchors?.get(index.id))
        : resolveLeverageDecay(spec, input, index, anchors);
      if (outputs.every((output) => output.points.length < 2)) {
        warnings.push(`${studyMessageName(spec)}: not enough shared daily closes to measure ${leverageFactorLabel(spec.parameters.factor as number)} daily ${leverageSymbol(index)}.`);
      }
      resolved.push(...outputs);
      return;
    }
    if (spec.kind === "realized-vol") {
      const window = spec.parameters.window ?? 30;
      if (typeof window !== "number" || !Number.isInteger(window) || window < 2
        || (spec.parameters.estimator !== undefined && !isRealizedVolatilityEstimator(spec.parameters.estimator))) {
        errors.push(`${studyMessageName(spec)}: choose a supported volatility estimator and a whole window of at least two sessions.`);
        return;
      }
      const inputResolution = input.historyResolution === undefined ? marketResolution : input.historyResolution;
      if (input.nativeFrequency !== "daily"
        || (inputResolution !== undefined && inputResolution !== "1d")
        || (input.timeBasis?.cadenceMs !== undefined && input.timeBasis.cadenceMs !== 86_400_000)
        || !(input.unitGroup === "price" || input.unitGroup.startsWith("price:"))) {
        errors.push(`${studyMessageName(spec)}: realized volatility requires daily prices. Choose Auto or 1D resolution and a daily price source.`);
        return;
      }
      const cadenceIssue = realizedVolatilityCadenceIssue(input.points);
      if (cadenceIssue) {
        errors.push(`${studyMessageName(spec)}: ${cadenceIssue}`);
        return;
      }
      const outputs = resolveRealizedVolatility(spec, input, color);
      if (outputs.every((output) => output.points.every((point) => point.value === null))) {
        warnings.push(`${studyMessageName(spec)}: not enough valid daily history to calculate ${spec.parameters.estimator ?? "close-to-close"} realized volatility.`);
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
    else if (spec.kind === "formula" && terms) outputs = resolveFormula(spec, inputs as ResolvedSeries[], terms, color);
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
          `${studyMessageName(spec)}: ${spec.kind} inputs use different currencies (${inputCurrency} and ${pairedCurrency}); raw values are not FX-converted.`,
        );
      }
      if (spec.kind === "correlation" && input.nativeFrequency !== pairedInput.nativeFrequency) {
        warnings.push(`${studyMessageName(spec)}: correlation mixes ${input.nativeFrequency} and ${pairedInput.nativeFrequency} observations; only matching observation times contribute.`);
      }
      outputs = resolvePairStudy(spec, input, pairedInput, color);
    }
    if (
      spec.kind !== "volume"
      && (outputs.length === 0 || outputs.every((output) => output.points.length === 0))
    ) {
      warnings.push(`${studyMessageName(spec)}: not enough valid history to calculate ${spec.kind}.`);
    }
    resolved.push(...outputs);
  });
  return { series: resolved, warnings, errors };
}
