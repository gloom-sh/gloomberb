import type { PricePoint } from "../types/financials";
import { marketPriceFractionDigitCeiling, resolveAssetDisplayKind } from "../market-data/market/format";
import { TIME_RANGES, type TimeRange } from "../time-series/range";
import { subtractTimeRange } from "../time-series/date-window";
import {
  CHART_RESOLUTION_STEP_MS,
  isIntradayResolution,
  RANGE_HISTORY_RESOLUTION,
  type ManualChartResolution,
} from "../time-series/resolution";
import { classifyInstrumentType } from "../tickers/instrument-kind";
import { isRoundTheClockCoin } from "../utils/crypto-pair";
import { currencyPairCode } from "../utils/currency-pair";
import { currencyUnitLabel } from "../utils/currency-units";
import { getPricePointTimestamp } from "../utils/price-history";
import { pricePointIntegrityFlags, pricePointValues } from "../utils/price-history-integrity";
import { formatUtcTime } from "../utils/utc-time";

const PRICE_KEYS = ["open", "high", "low", "close"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Daily bars are a day apart even when stamped at the session open. */
const INTRADAY_MAX_GAP_MS = 20 * 60 * 60 * 1000;
const INTRADAY_RESOLUTIONS = ["1m", "5m", "15m", "30m", "45m", "1h"] as const;
/** A first bar later than this after the range's start is a late start, not a weekend or holiday. */
const LATE_START_MIN_MS = 10 * DAY_MS;
const LATE_START_MIN_BARS = 3;

const BAR_INTERVAL_LABELS: Record<ManualChartResolution, string> = {
  "1m": "1-minute",
  "5m": "5-minute",
  "15m": "15-minute",
  "30m": "30-minute",
  "45m": "45-minute",
  "1h": "hourly",
  "1d": "daily",
  "1wk": "weekly",
  "1mo": "monthly",
};

export interface HistoryRow {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  /** Currency code of the prices; null for index points or when no source says. */
  currency: string | null;
  /** What one price is, as `historyUnit` names it: `USD`, `index points`, `ZAR per USD`; null when no source says. */
  unit: string | null;
  /** Bar size, in the codes of `resolution`: 5m, 1h, 1d, 1wk, 1mo. */
  interval: ManualChartResolution | null;
  /** Each way the bar's prices contradict each other, such as `high<open`; null when they agree. */
  flag: string | null;
  /** The bar's period had not ended when it was served: the close is the latest price. */
  partial?: true;
  /** The bar's prices were rebuilt from hourly bars where the source left the day empty. */
  filled?: true;
  /** What the volume counts, when the history says: a coin's is traded value in its quote currency (`USD`). */
  volumeUnit?: string;
  /** Why a coin's bar has no volume: `day in progress`, `rebuilt from hourly bars`, `not reported`. */
  volumeNote?: string;
}

/** A coin's volume: traded value in its quote currency, per UTC day on daily bars. */
export interface HistoryVolume {
  unit: string;
}

function decimalPlaces(value: number): number {
  const [mantissa = "", exponent = "0"] = Math.abs(value).toString().split("e");
  return Math.max(0, (mantissa.split(".")[1]?.length ?? 0) - Number(exponent));
}

/**
 * Providers serve prices as float32: The feed sends the exact float
 * (340.33 arrives as 340.3299865722656) and the cloud a float already rounded
 * to a few decimals (254.42999). Return the shortest decimal that is the same
 * float32. Values with fewer than five decimals are left alone, and a precise
 * double only moves within float32 precision (about seven significant digits).
 */
export function cleanFloat32Price(value: number): number {
  if (!Number.isFinite(value) || value === 0 || decimalPlaces(value) < 5) return value;
  const target = Math.fround(value);
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) !== target) continue;
    return candidate.toString().length < value.toString().length ? candidate : value;
  }
  return value;
}

function isUtcMidnight(time: number): boolean {
  return new Date(time).toISOString().endsWith("T00:00:00.000Z");
}

function medianGap(times: readonly number[]): number | null {
  const finite = times.filter(Number.isFinite).sort((left, right) => left - right);
  const gaps = finite.slice(1).map((time, index) => time - finite[index]!).filter((gap) => gap > 0).sort((left, right) => left - right);
  return gaps.length > 0 ? gaps[Math.floor((gaps.length - 1) / 2)]! : null;
}

/** Without a declared cadence, bar spacing decides: daily bars may be stamped at the session open. */
function looksIntraday(times: readonly number[]): boolean {
  const finite = times.filter(Number.isFinite);
  if (finite.length < 2) return finite.some((time) => !isUtcMidnight(time));
  const gap = medianGap(finite);
  return gap != null && gap < INTRADAY_MAX_GAP_MS;
}

/** The bar size served: as the source declared it, otherwise read from the typical spacing of the bars. */
function historyInterval(times: readonly number[], resolution: ManualChartResolution | null): ManualChartResolution | null {
  if (resolution) return resolution;
  const gap = medianGap(times);
  if (gap == null) return null;
  if (gap < INTRADAY_MAX_GAP_MS) {
    return INTRADAY_RESOLUTIONS.reduce((best, candidate) => (
      Math.abs(CHART_RESOLUTION_STEP_MS[candidate] - gap) < Math.abs(CHART_RESOLUTION_STEP_MS[best] - gap) ? candidate : best
    ));
  }
  const days = gap / DAY_MS;
  return days >= 25 ? "1mo" : days >= 6 ? "1wk" : "1d";
}

/**
 * Intraday bars keep their UTC time; daily and longer bars are trading dates.
 * A bar whose prices contradict each other is blanked exactly as HP blanks it,
 * and says why in `flag`.
 */
export function historyRows(
  points: readonly PricePoint[],
  resolution: ManualChartResolution | null,
  currency: string | null = null,
  unit: string | null = null,
  volume: HistoryVolume | null = null,
): HistoryRow[] {
  const times = points.map(getPricePointTimestamp);
  const intraday = resolution ? isIntradayResolution(resolution) : looksIntraday(times);
  const interval = historyInterval(times, resolution);
  return points.map((point, index) => {
    const time = times[index]!;
    const iso = Number.isFinite(time) ? new Date(time).toISOString() : "";
    const values = pricePointValues(point);
    const flags = pricePointIntegrityFlags(point);
    const price = (value: number | null) => value == null ? null : cleanFloat32Price(value);
    return {
      date: intraday ? iso.replace(".000Z", "Z") : iso.slice(0, 10),
      open: price(values.open),
      high: price(values.high),
      low: price(values.low),
      close: price(values.close),
      volume: values.volume,
      currency,
      unit,
      interval,
      flag: flags.length > 0 ? flags.join(",") : null,
      ...(point.partial ? { partial: true as const } : {}),
      ...(point.filled ? { filled: true as const } : {}),
      ...(volume ? { volumeUnit: volume.unit } : {}),
      // A coin trades every day, so a bar without volume says why.
      ...(volume && values.volume == null
        ? { volumeNote: point.partial ? "day in progress" : point.filled ? "rebuilt from hourly bars" : "not reported" }
        : {}),
    };
  });
}

/**
 * The volume of a coin's history: traded value in the quote currency the
 * prices are in. Null for anything else, whose volume stays unlabelled.
 */
export function historyVolume(
  unit: HistoryUnit,
  market: { listing: string; exchange?: string; instrumentType?: string },
): HistoryVolume | null {
  const coin = isRoundTheClockCoin(market.listing, market.exchange) || classifyInstrumentType(market.instrumentType) === "crypto";
  return coin && unit.kind === "currency" && unit.currency ? { unit: unit.currency } : null;
}

/** `volume in USD per UTC day` for a coin's daily bars; `volume in USD` for others. */
export function historyVolumeText(volume: HistoryVolume, interval: ManualChartResolution | null): string {
  return interval === "1d" ? `volume in ${volume.unit} per UTC day` : `volume in ${volume.unit}`;
}

function listDates(dates: readonly string[]): string {
  const shown = dates.slice(-LISTED_GAPS);
  const earlier = dates.length - shown.length;
  const items = [...earlier > 0 ? [`${earlier} earlier`] : [], ...shown];
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";
}

/**
 * What the partial and filled bars are: "2026-10-12 is still forming
 * (partial), with no volume until the day closes", and the bars rebuilt from
 * hourly bars. Null when no bar is either.
 */
export function historyBarStatusNote(rows: readonly Pick<HistoryRow, "date" | "partial" | "filled" | "volume">[]): string | null {
  const partial = rows.filter((row) => row.partial);
  const filled = rows.filter((row) => row.filled);
  const notes = [
    partial.length > 0
      ? `${listDates(partial.map((row) => row.date))} ${partial.length === 1 ? "is" : "are"} still forming (partial)`
        + (partial.every((row) => row.volume == null) ? ", with no volume until the day closes" : "")
      : null,
    filled.length > 0
      ? `${listDates(filled.map((row) => row.date))} ${filled.length === 1 ? "was" : "were"} rebuilt from hourly bars (filled)`
        + (filled.every((row) => row.volume == null) ? ", without volume" : "")
      : null,
  ].filter((note): note is string => note != null);
  return notes.length > 0 ? notes.join("; ") : null;
}

function neededDecimals(value: number, cap: number): number {
  for (let decimals = 0; decimals < cap; decimals++) {
    if (Number(value.toFixed(decimals)) === value) return decimals;
  }
  return cap;
}

/**
 * One decimal count for the whole table so the price columns line up: the
 * count nine in ten prices need, so a stray long value does not widen every
 * row. A known asset kind caps it with the app's price display rules; without
 * one, the largest price sets a seven significant digit ceiling (BTC keeps
 * cents, FX keeps pips, sub-cent coins keep their digits). Cents at least above 1.
 */
export function historyPriceDecimals(rows: readonly Pick<HistoryRow, typeof PRICE_KEYS[number]>[], assetCategory?: string): number {
  const values = rows.flatMap((row) => PRICE_KEYS.flatMap((key) => {
    const value = row[key];
    return value != null && Number.isFinite(value) && value !== 0 ? [Math.abs(value)] : [];
  }));
  if (!values.length) return 2;
  const largest = values.reduce((max, value) => Math.max(max, value), 0);
  const magnitude = Math.floor(Math.log10(largest));
  const significantCap = largest >= 1 ? Math.max(2, 6 - magnitude) : 6 - magnitude;
  const cap = resolveAssetDisplayKind({ assetCategory }) === "other"
    ? significantCap
    : Math.min(significantCap, marketPriceFractionDigitCeiling(largest, { assetCategory }));
  const needed = values.map((value) => neededDecimals(value, cap)).sort((left, right) => left - right);
  const decimals = needed[Math.floor(0.9 * (needed.length - 1))]!;
  return largest >= 1 ? Math.max(2, decimals) : decimals;
}

/** How far back ALL reaches, in whole years, from the window a history request for it asks for. */
export function historyAllRangeYears(now = new Date()): number {
  return Math.round((now.getTime() - subtractTimeRange(now, "ALL").getTime()) / (365.25 * DAY_MS));
}

/** "1D 5-minute, 1W hourly, 1M to 1Y daily, 5Y weekly, ALL monthly", from the table history requests use. */
export function historyIntervalsByRange(): string {
  const groups: Array<{ ranges: TimeRange[]; resolution: ManualChartResolution }> = [];
  for (const range of TIME_RANGES) {
    const resolution = RANGE_HISTORY_RESOLUTION[range];
    const last = groups.at(-1);
    if (last?.resolution === resolution) last.ranges.push(range);
    else groups.push({ ranges: [range], resolution });
  }
  return groups.map(({ ranges, resolution }) => (
    `${ranges.length > 1 ? `${ranges[0]} to ${ranges.at(-1)}` : ranges[0]} ${BAR_INTERVAL_LABELS[resolution]}`
  )).join(", ");
}

export interface HistoryUnit {
  kind: "currency" | "pair" | "points" | "unknown";
  /** Currency code of the prices; null for index points or when no source says. */
  currency: string | null;
  /** What one price is: "USD", "ILA (agorot, 1/100 ILS)", "ZAR per USD", "index points"; null when unknown. */
  unit: string | null;
}

/**
 * What the prices are in. An FX pair is named by its listing (ZAR=X is ZAR per
 * USD; EURUSD=X, EUR/USD and EURUSD:CCY are USD per EUR), an index is in
 * points, and anything else is in the currency its quote states, a sub-unit
 * named as such. Without one the unit is unknown rather than guessed from the
 * exchange.
 */
export function historyUnit(listing: string, quote: { currency?: string; instrumentType?: string } | null | undefined): HistoryUnit {
  const pair = currencyPairCode(listing.trim().toUpperCase());
  if (pair) {
    const [base, counter] = [pair.slice(0, 3), pair.slice(3)];
    return { kind: "pair", currency: counter, unit: `${counter} per ${base}` };
  }
  if (quote?.instrumentType?.trim().toUpperCase() === "INDEX") return { kind: "points", currency: null, unit: "index points" };
  const code = quote?.currency?.trim();
  return code
    ? { kind: "currency", currency: code, unit: currencyUnitLabel(code, { ofMajor: true }) }
    : { kind: "unknown", currency: null, unit: null };
}

function historyDate(value: string): string {
  return value.length > 10 ? formatUtcTime(value) : value;
}

/** The facts line under a history heading: "Currency USD", "daily bars", "2025-10-09 to 2026-10-08", "251 bars". */
export function historyFacts(unit: HistoryUnit, rows: readonly Pick<HistoryRow, "date" | "interval">[]): string[] {
  const first = rows[0]?.date;
  const last = rows.at(-1)?.date;
  const interval = rows[0]?.interval;
  return [
    unit.kind === "pair" ? unit.unit! : unit.kind === "points" ? "Index points" : `Currency ${unit.unit ?? "unknown"}`,
    interval ? `${BAR_INTERVAL_LABELS[interval]} bars` : "",
    first && last ? (first === last ? historyDate(first) : `${historyDate(first)} to ${historyDate(last)}`) : "",
    `${rows.length} ${rows.length === 1 ? "bar" : "bars"}`,
  ].filter(Boolean);
}

/**
 * What an export should know that its rows do not show: bars coarser than the
 * range is served in, or a first bar well after the start asked for, as for a
 * listing younger than the range. Weekends and holidays are within tolerance.
 */
export function historyNotes(
  range: TimeRange,
  interval: ManualChartResolution | null,
  firstDate: string | undefined,
  now = Date.now(),
): string[] {
  if (!firstDate) return [];
  const notes: string[] = [];
  const expected = RANGE_HISTORY_RESOLUTION[range];
  if (interval && CHART_RESOLUTION_STEP_MS[interval] > CHART_RESOLUTION_STEP_MS[expected]) {
    const from = interval === "1mo" ? firstDate.slice(0, 7) : firstDate.slice(0, 10);
    notes.push(`Asked ${range}, got ${BAR_INTERVAL_LABELS[interval]} bars from ${from}`);
  }
  const first = Date.parse(firstDate);
  if (range !== "ALL" && Number.isFinite(first)) {
    const tolerance = Math.max(LATE_START_MIN_MS, LATE_START_MIN_BARS * CHART_RESOLUTION_STEP_MS[interval ?? expected]);
    if (first - subtractTimeRange(new Date(now), range).getTime() > tolerance) {
      notes.push(`Asked ${range}, data starts ${firstDate.slice(0, 10)} (first available bar)`);
    }
  }
  return notes;
}

/** Gaps listed by date before the rest are only counted. */
const LISTED_GAPS = 3;

/**
 * "No bar for 2026-10-10": the days a coin, which trades every day, has no
 * daily bar for between its first and last bar. Days before the first bar are
 * before the listing. A market that closes skips weekends and holidays, so its
 * gaps say nothing and get no note.
 */
export function historyGapNote(
  rows: readonly Pick<HistoryRow, "date" | "interval">[],
  market: { listing: string; exchange?: string; instrumentType?: string },
): string | null {
  const everyDay = isRoundTheClockCoin(market.listing, market.exchange)
    || classifyInstrumentType(market.instrumentType) === "crypto";
  if (!everyDay || rows[0]?.interval !== "1d") return null;
  const days = new Set(rows.map((row) => Date.parse(`${row.date.slice(0, 10)}T00:00:00Z`)).filter(Number.isFinite));
  const sorted = [...days].sort((left, right) => left - right);
  const gaps: Array<[number, number]> = [];
  for (const [index, day] of sorted.slice(1).entries()) {
    const previous = sorted[index]!;
    if (day - previous > DAY_MS) gaps.push([previous + DAY_MS, day - DAY_MS]);
  }
  if (!gaps.length) return null;
  const date = (time: number) => new Date(time).toISOString().slice(0, 10);
  const length = (gaps: Array<[number, number]>) => gaps.reduce((count, [from, to]) => count + (to - from) / DAY_MS + 1, 0);
  // The latest gaps by date, the rest as a count.
  const shown = gaps.slice(-LISTED_GAPS);
  const earlier = length(gaps) - length(shown);
  const listed = [
    ...earlier > 0 ? [`${earlier} earlier ${earlier === 1 ? "day" : "days"}`] : [],
    ...shown.map(([from, to]) => from === to ? date(from) : `${date(from)} to ${date(to)}`),
  ];
  const list = listed.length > 1 ? `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}` : listed[0];
  return `${length(gaps) === 1 ? "No bar" : "No bars"} for ${list}`;
}

/** "37 of 251 bars have high below open or close in the source data; ...", or null when every bar agrees. */
export function historyFlagNote(rows: readonly Pick<HistoryRow, "flag">[]): string | null {
  const flagged = rows.filter((row) => row.flag);
  if (flagged.length === 0) return null;
  const codes = new Set(flagged.flatMap((row) => row.flag!.split(",")));
  const kinds = [
    codes.has("high<open") || codes.has("high<close") ? "high below open or close" : "",
    codes.has("low>open") || codes.has("low>close") ? "low above open or close" : "",
    codes.has("low>high") ? "low above high" : "",
  ].filter(Boolean);
  const count = `${flagged.length} of ${rows.length} ${flagged.length === 1 && rows.length === 1 ? "bar" : "bars"}`;
  return `${count} ${flagged.length === 1 ? "has" : "have"} ${kinds.join(", or ")} in the source data; their prices are left blank`;
}
