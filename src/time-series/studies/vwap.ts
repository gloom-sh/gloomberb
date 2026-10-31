import { latestTradingSessionOpen } from "../../market-data/market/trading-sessions";
import { CHART_RESOLUTION_STEP_MS, isIntradayResolution, type ManualChartResolution } from "../resolution";
import { anchoredVwap, sessionVwap, type StudyBar, type VwapValue } from "../trader-studies";
import { zonedDateTimeParts } from "../../utils/zoned-date-time";
import type { ChartStudySpec, ResolvedSeries } from "../types";
import { isFiniteNumber } from "../../utils/guards";
import { ANCHOR_COLORS, derivedPoint, outputSeries, studyBars, type NumericSample } from "./shared";

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

export function resolveVwap(
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

export function resolveAnchoredVwap(
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

/** The input's bars, passed through for the chart to profile over what is in view. */
export function resolveVolumeProfile(
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
