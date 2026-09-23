import type { PricePoint } from "../../../types/financials";
import { rollingRealizedVolatility } from "../shared/volatility";
import type { IvHistoryPayload, IvMethod, IvPoint, IvScreenRow, IvStats } from "./client";

export const HV_WINDOWS = [20, 30] as const;
export type HvWindow = (typeof HV_WINDOWS)[number];
export type IvLookback = "1Y" | "2Y" | "ALL";
export const RICH_PERCENTILE = 80;
export const CHEAP_PERCENTILE = 20;

export interface DatedValue { date: Date; value: number | null }
export type IvStatUnit = "vol" | "points" | "ratio";
/** One measure's latest value ranked against its own prior 52 weeks. */
export interface IvStatRow {
  id: string;
  label: string;
  unit: IvStatUnit;
  value: number | null;
  date: string | null;
  method: IvMethod | "prices" | null;
  low: number | null;
  high: number | null;
  rank: number | null;
  percentile: number | null;
  samples: number;
}
/** Rank and percentile need this many prior sessions, matching the server. */
export const MIN_RANK_SAMPLES = 120;
export interface IvHistoryModel {
  symbol: string;
  status: IvHistoryPayload["status"];
  iv30: DatedValue[];
  iv90: DatedValue[];
  /** Same-session quote captures, drawn as points over the trade-close line. */
  quoteIv30: DatedValue[];
  hv: DatedValue[];
  spread: DatedValue[];
  stats: IvStatRow[];
  since: string | null;
  asOf: string | null;
  warnings: string[];
}

const day = (value: Date | string) => typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
const utc = (date: string) => new Date(`${date}T00:00:00Z`);

/** Midrank percentile of value within samples, 0 to 100; null below the minimum. */
export function midrankPercentile(samples: readonly number[], value: number, minimum = MIN_RANK_SAMPLES): number | null {
  if (samples.length < minimum) return null;
  let below = 0, equal = 0;
  for (const sample of samples) {
    if (sample < value) below += 1;
    else if (sample === value) equal += 1;
  }
  return (below + equal / 2) / samples.length * 100;
}

function lookbackStart(asOf: string, lookback: IvLookback): string | null {
  if (lookback === "ALL") return null;
  const date = utc(asOf);
  date.setUTCFullYear(date.getUTCFullYear() - (lookback === "2Y" ? 2 : 1));
  return day(date);
}

/** The latest value against the 52 weeks before it, with the same rules as the server's IV rank. */
export function seriesStat(id: string, label: string, unit: IvStatUnit, points: readonly DatedValue[], method: IvStatRow["method"]): IvStatRow {
  const latest = [...points].reverse().find((point) => point.value != null);
  if (!latest) return { id, label, unit, value: null, date: null, method, low: null, high: null, rank: null, percentile: null, samples: 0 };
  const start = lookbackStart(day(latest.date), "1Y")!;
  const window = points.filter((point) => point.value != null && day(point.date) >= start && point.date < latest.date).map((point) => point.value!);
  const value = latest.value!;
  const low = window.length ? Math.min(value, ...window) : null, high = window.length ? Math.max(value, ...window) : null;
  const enough = window.length >= MIN_RANK_SAMPLES;
  return { id, label, unit, value, date: day(latest.date), method, low, high,
    rank: enough && high! > low! ? (value - low!) / (high! - low!) * 100 : null,
    percentile: midrankPercentile(window, value), samples: window.length };
}

function byMethod(series: readonly IvPoint[], method: IvMethod, field: "iv30" | "iv90") {
  return series.filter((point) => point.method === method && point[field] != null)
    .map((point) => ({ date: utc(point.sessionDate), value: point[field] }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * IV history against realized volatility of the same underlying. HV uses the
 * adjusted daily closes behind HVG; the spread pairs each trade-close IV30
 * with HV on the same session, so gaps in either series stay gaps.
 */
export function projectIvHistory(
  payload: IvHistoryPayload, prices: readonly PricePoint[],
  options: { lookback?: IvLookback; hvWindow?: HvWindow } = {},
): IvHistoryModel {
  const lookback = options.lookback ?? "1Y";
  const window = options.hvWindow ?? 20;
  const warnings = [...payload.warnings];
  const tradeIv30 = byMethod(payload.series, "trade-close", "iv30");
  const latestDate = [payload.latest?.date, tradeIv30.at(-1) && day(tradeIv30.at(-1)!.date)].filter((value): value is string => !!value).sort().at(-1) ?? null;
  const start = latestDate ? lookbackStart(latestDate, lookback) : null;
  const visible = <T extends { date: Date }>(points: T[]) => start ? points.filter((point) => day(point.date) >= start) : points;
  const rolling = rollingRealizedVolatility(prices, { windows: [window] })
    .map((point) => ({ date: utc(day(point.date)), value: point.values[window] ?? null }));
  const hvByDay = new Map(rolling.map((point) => [day(point.date), point.value]));
  const spreadAll = tradeIv30.map((point) => {
    const hv = hvByDay.get(day(point.date));
    return { date: point.date, value: hv == null || point.value == null ? null : point.value - hv };
  });
  const earliest = tradeIv30[0] ? day(tradeIv30[0].date) : null;
  // HV starts with the IV record so the two lines share one time axis.
  const hv = visible(rolling.filter((point) => !earliest || day(point.date) >= earliest));

  const latest = payload.latest;
  const iv90ByDay = new Map(byMethod(payload.series, "trade-close", "iv90").map((point) => [day(point.date), point.value]));
  const termAll = tradeIv30.map((point) => {
    const iv90 = iv90ByDay.get(day(point.date));
    return { date: point.date, value: point.value == null || iv90 == null || !(iv90 > 0) ? null : point.value / iv90 };
  });
  const fromServer = (id: string, label: string, stats: IvStats | null): IvStatRow => ({ id, label, unit: "vol",
    value: stats?.value ?? null, date: stats?.date ?? null, method: stats?.method ?? null, low: stats?.low ?? null, high: stats?.high ?? null,
    rank: stats?.rank ?? null, percentile: stats?.percentile ?? null, samples: stats?.samples ?? 0 });
  const stats: IvStatRow[] = [fromServer("iv30", "IV 30d ATM", payload.stats.iv30)];
  // A newer same-day quote capture is shown on its own row: its rank would mix methods.
  if (latest?.method === "quote-mid" && latest.iv30 != null && (!payload.stats.iv30 || latest.date > payload.stats.iv30.date)) {
    stats.push({ id: "iv30-live", label: "IV 30d live", unit: "vol", value: latest.iv30, date: latest.date, method: "quote-mid",
      low: null, high: null, rank: null, percentile: null, samples: 0 });
  }
  stats.push(fromServer("iv90", "IV 90d ATM", payload.stats.iv90),
    seriesStat("hv", `HV ${window}`, "vol", rolling, "prices"),
    seriesStat("spread", `IV 30d - HV ${window}`, "points", spreadAll, "trade-close"),
    seriesStat("term", "IV 30d / 90d", "ratio", termAll, "trade-close"));

  if (payload.status === "queued") warnings.push(`${payload.symbol} implied volatility history is queued; the first backfill takes a few minutes.`);
  else if (payload.status === "backfilling") warnings.push(`${payload.symbol} history is still backfilling (through ${payload.coverage?.backfilledThrough ?? "--"}).`);
  else if (payload.status === "unavailable" && !payload.warnings.length) warnings.push(`No listed options history found for ${payload.symbol}.`);
  if (!prices.length) warnings.push("Realized volatility unavailable: daily price history is missing.");

  return {
    symbol: payload.symbol, status: payload.status,
    iv30: visible(tradeIv30), iv90: visible(byMethod(payload.series, "trade-close", "iv90")),
    quoteIv30: visible(byMethod(payload.series, "quote-mid", "iv30")),
    hv, spread: visible(spreadAll), stats,
    since: payload.coverage?.since ?? earliest, asOf: latestDate, warnings,
  };
}

export type RichCheap = "rich" | "cheap" | "fair" | null;
export interface RichCheapRow {
  symbol: string;
  status: IvScreenRow["status"];
  iv30: number | null;
  date: string | null;
  method: IvMethod | null;
  rank: number | null;
  percentile: number | null;
  /** Session the rank belongs to (latest trade close). */
  rankDate: string | null;
  termSlope: number | null;
  skew: number | null;
  hv: number | null;
  ivHv: number | null;
  verdict: RichCheap;
}

/** Rich or cheap against the symbol's own year: IV30 percentile at or above 80, or at or below 20. */
export function verdictFor(percentile: number | null): RichCheap {
  if (percentile == null) return null;
  return percentile >= RICH_PERCENTILE ? "rich" : percentile <= CHEAP_PERCENTILE ? "cheap" : "fair";
}

export function projectRichCheap(rows: readonly IvScreenRow[], hv: ReadonlyMap<string, number | null> = new Map()): RichCheapRow[] {
  return rows.map((row) => {
    const latest = row.latest;
    const iv30 = latest?.iv30 ?? null;
    const realized = hv.get(row.symbol) ?? null;
    const percentile = row.iv30?.percentile ?? null;
    return {
      symbol: row.symbol, status: row.status, iv30, date: latest?.date ?? null, method: latest?.method ?? null,
      rank: row.iv30?.rank ?? null, percentile, rankDate: row.iv30?.date ?? null,
      termSlope: iv30 != null && latest?.iv90 != null ? iv30 - latest.iv90 : null,
      skew: row.skew?.skew ?? null, hv: realized,
      ivHv: iv30 != null && realized != null && realized > 0 ? iv30 / realized : null,
      verdict: verdictFor(percentile),
    };
  });
}

export const VCA_PRESETS = {
  etfs: ["SPY", "QQQ", "IWM", "DIA", "EEM", "EFA", "FXI", "EWZ", "GLD", "SLV", "GDX", "USO", "TLT", "HYG",
    "XLE", "XLF", "XLK", "XLV", "XLY", "XLP", "XLI", "XLU", "SMH", "XBI", "KRE"],
  megacaps: ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "AMD", "NFLX", "ORCL", "CRM",
    "JPM", "BAC", "GS", "V", "MA", "XOM", "CVX", "LLY", "UNH", "WMT", "COST", "HD", "BA"],
} as const;
export type VcaPreset = keyof typeof VCA_PRESETS;
export const VCA_LIMIT = 60;
