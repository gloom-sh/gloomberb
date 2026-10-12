import type { PricePoint } from "../../../types/financials";
import { rollingRealizedVolatility } from "../shared/volatility";
import type { IvCoverageStatus, IvHistoryPayload, IvMethod, IvPoint, IvScreenRow, IvStats } from "./client";

export const HV_WINDOWS = [20, 30] as const;
export type HvWindow = (typeof HV_WINDOWS)[number];
export type IvLookback = "1Y" | "2Y" | "ALL";
const RICH_PERCENTILE = 80;
const CHEAP_PERCENTILE = 20;

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
const MIN_RANK_SAMPLES = 120;
/**
 * Minutes a symbol's first backfill usually takes from the request that
 * queued it: nine in ten have history by then (docs/research-data.md).
 */
const FIRST_BACKFILL_MINUTES = 10;
const FIRST_BACKFILL_TEXT = `a first backfill usually takes under ${FIRST_BACKFILL_MINUTES} minutes`;

/** "06:41 UTC" today, with the date on another day: "2026-10-09 06:41 UTC". */
function utcClock(time: number, now: number): string {
  const iso = new Date(time).toISOString();
  return iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10)
    ? `${iso.slice(11, 16)} UTC` : `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

/** When a symbol was queued, or null when the answer does not say (older servers) or says a time still to come. */
function queuedTime(queuedAt: string | null | undefined, now: number): number | null {
  const time = queuedAt ? Date.parse(queuedAt) : Number.NaN;
  return Number.isFinite(time) && time <= now ? time : null;
}

/**
 * When to look again for history queued at `from`: "a first backfill usually
 * takes under 10 minutes, try again after 06:41 UTC". One queued for longer
 * than that is running late, and says so rather than give a time it cannot
 * know. A view that checks again by itself (`retry: false`) needs no time to
 * come back at.
 */
function firstBackfillText(from: number, now: number, retry: boolean): string {
  const retryAt = from + FIRST_BACKFILL_MINUTES * 60_000;
  if (retryAt <= now) return `longer than the usual ${FIRST_BACKFILL_MINUTES} minutes${retry ? ", try again shortly" : ""}`;
  return retry ? `${FIRST_BACKFILL_TEXT}, try again after ${utcClock(retryAt, now)}` : FIRST_BACKFILL_TEXT;
}

/** "queued for backfill since 06:31 UTC; a first backfill usually takes under 10 minutes, try again after 06:41 UTC" */
function queuedText(queuedAt: string | null | undefined, now: number): string {
  const queued = queuedTime(queuedAt, now);
  return `queued for backfill${queued == null ? "" : ` since ${utcClock(queued, now)}`}; ${firstBackfillText(queued ?? now, now, true)}`;
}
export interface IvHistoryModel {
  symbol: string;
  status: IvHistoryPayload["status"];
  iv30: DatedValue[];
  iv90: DatedValue[];
  /** Trade-close one-year IV; it starts later than IV30 and has gaps where long-dated series did not trade. */
  iv365: DatedValue[];
  /** Same-session quote captures, drawn as points over the trade-close line. */
  quoteIv30: DatedValue[];
  hv: DatedValue[];
  spread: DatedValue[];
  /**
   * Each session's 30-day 25-delta put IV minus call IV from its quote
   * capture (put-call: positive means puts are richer). The risk reversal,
   * call minus put, is its negative.
   */
  skew: DatedValue[];
  /** First session with a stored skew; skew is blank before it. */
  skewSince: string | null;
  /** "skew from 2026-09-23", or why there is no skew at all. */
  skewNote: string | null;
  stats: IvStatRow[];
  since: string | null;
  /** Where the 1Y series starts and how deep it is, when that differs from the rest or leaves it unranked. */
  oneYearNote: string | null;
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
function seriesStat(id: string, label: string, unit: IvStatUnit, points: readonly DatedValue[], method: IvStatRow["method"]): IvStatRow {
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

function byMethod(series: readonly IvPoint[], method: IvMethod, field: "iv30" | "iv90" | "iv365") {
  return series.filter((point) => point.method === method && point[field] != null)
    .map((point) => ({ date: utc(point.sessionDate), value: point[field] }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * 25-delta skew per session, put minus call, from the quote captures: the
 * only readings that store the wings. A server that sends no wing fields at
 * all predates them, which is not the same as a symbol with no capture yet.
 */
function skewSeries(series: readonly IvPoint[]): { points: DatedValue[]; note: string | null } {
  const points = series.filter((point) => point.method === "quote-mid" && point.put25_30 != null && point.call25_30 != null)
    .map((point) => ({ date: utc(point.sessionDate), value: point.put25_30! - point.call25_30! }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (points[0]) return { points, note: `skew from ${day(points[0].date)}` };
  if (!series.length) return { points, note: null };
  return { points, note: series.every((point) => point.put25_30 === undefined) ? "skew unavailable from this server" : "no skew history yet" };
}

/**
 * IV history against realized volatility of the same underlying. HV uses the
 * adjusted daily closes behind HVG; the spread pairs each trade-close IV30
 * with HV on the same session, so gaps in either series stay gaps.
 */
export function projectIvHistory(
  payload: IvHistoryPayload, prices: readonly PricePoint[],
  options: { lookback?: IvLookback; hvWindow?: HvWindow; now?: number } = {},
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
  // A newer quote capture is shown on its own row: its rank would mix methods.
  if (latest?.method === "quote-mid" && latest.iv30 != null && (!payload.stats.iv30 || latest.date > payload.stats.iv30.date)) {
    stats.push({ id: "iv30-quote", label: "IV 30d quote", unit: "vol", value: latest.iv30, date: latest.date, method: "quote-mid",
      low: null, high: null, rank: null, percentile: null, samples: 0 });
  }
  // IV1Y ranks trade closes only; until there is one, a stored quote gives its level, unranked.
  const oneYear = payload.stats.iv365 ?? null;
  stats.push(fromServer("iv90", "IV 90d ATM", payload.stats.iv90),
    !oneYear && latest?.iv365 != null
      ? { id: "iv365", label: "IV 1Y ATM", unit: "vol", value: latest.iv365, date: latest.date, method: latest.method,
        low: null, high: null, rank: null, percentile: null, samples: 0 }
      : fromServer("iv365", "IV 1Y ATM", oneYear),
    seriesStat("hv", `HV ${window}`, "vol", rolling, "prices"),
    seriesStat("spread", `IV 30d - HV ${window}`, "points", spreadAll, "trade-close"),
    seriesStat("term", "IV 30d / 90d", "ratio", termAll, "trade-close"));

  // Worded as VCA words each symbol (screenCoverage).
  if (payload.status === "queued") warnings.push(`${payload.symbol} ${queuedText(payload.coverage?.addedAt, options.now ?? Date.now())}.`);
  else if (payload.status === "backfilling") {
    const through = payload.coverage?.backfilledThrough;
    warnings.push(`${payload.symbol} backfilling${through ? ` through ${through}` : ""}.`);
  } else if (payload.status === "unavailable" && !payload.warnings.length) warnings.push(`No options history for ${payload.symbol}.`);
  if (!prices.length) warnings.push("Realized volatility unavailable: daily price history is missing.");

  const tradeIv365 = byMethod(payload.series, "trade-close", "iv365");
  const skew = skewSeries(payload.series);
  const since = payload.coverage?.since ?? earliest;
  const oneYearSince = payload.coverage?.iv365Since ?? (tradeIv365[0] ? day(tradeIv365[0].date) : null);
  const oneYearNote = !oneYearSince ? (since ? "no IV1Y history yet" : null)
    : oneYear?.percentile == null ? `IV1Y from ${oneYearSince}, ${tradeIv365.length} session${tradeIv365.length === 1 ? "" : "s"}`
    : since && oneYearSince > since ? `IV1Y from ${oneYearSince}` : null;

  return {
    symbol: payload.symbol, status: payload.status,
    iv30: visible(tradeIv30), iv90: visible(byMethod(payload.series, "trade-close", "iv90")), iv365: visible(tradeIv365),
    quoteIv30: visible(byMethod(payload.series, "quote-mid", "iv30")),
    hv, spread: visible(spreadAll), skew: visible(skew.points),
    skewSince: skew.points[0] ? day(skew.points[0].date) : null, skewNote: skew.note, stats,
    since, oneYearNote, asOf: latestDate, warnings,
  };
}

export type RichCheap = "rich" | "cheap" | "fair" | null;
export interface RichCheapRow {
  symbol: string;
  /** Where the symbol's history stands, as HIVG reads it; an older server says only ready or queued. */
  status: IvCoverageStatus;
  /** When the symbol was queued for backfill, when the server says. */
  queuedAt: string | null;
  /** The last session its backfill has reached. */
  backfilledThrough: string | null;
  /** Why an unavailable symbol is not covered yet (demand coverage is full): not final, unlike one with no options history. */
  warning: string | null;
  iv30: number | null;
  date: string | null;
  method: IvMethod | null;
  rank: number | null;
  percentile: number | null;
  /** Trade close the rank is measured on: the newest trade-close session, which a newer quote reading can be ahead of. */
  rankDate: string | null;
  termSlope: number | null;
  /** The latest reading's one-year IV, dated with IV30. */
  iv1y: number | null;
  /**
   * IV1Y percentile on the close IVR and IVP are ranked on. Empty when the 1Y
   * series has no reading that session, or there is no IV1Y beside it to describe.
   */
  iv1yPercentile: number | null;
  skew: number | null;
  /** Session of the quote capture the skew comes from. */
  skewDate: string | null;
  hv: number | null;
  ivHv: number | null;
  verdict: RichCheap;
}

/**
 * The dates the screened rows agree on, so each is said once instead of per
 * row. The reading (IV30, term slope, IV/HV) and the rank (IVR, IVP) are dated
 * apart: a quote reading can be a session ahead of the trade close its rank
 * is measured on. A group the rows disagree on gets its own column.
 */
export interface RichCheapDates {
  reading: { date: string; method: IvMethod } | null;
  /** The trade close every ranked row is ranked on. */
  rank: string | null;
  /** Ranked rows are ranked on different closes. */
  rankApart: boolean;
  /** Some skew comes from a different session than its row's reading. */
  skewApart: boolean;
}
export function richCheapDates(rows: readonly RichCheapRow[]): RichCheapDates {
  const read = rows.filter((row) => row.date && row.method);
  const ranked = rows.filter((row) => row.rankDate);
  const first = read[0], firstRanked = ranked[0];
  return {
    reading: first && read.every((row) => row.date === first.date && row.method === first.method)
      ? { date: first.date!, method: first.method! } : null,
    rank: firstRanked && ranked.every((row) => row.rankDate === firstRanked.rankDate) ? firstRanked.rankDate : null,
    rankApart: !!firstRanked && ranked.some((row) => row.rankDate !== firstRanked.rankDate),
    skewApart: rows.some((row) => row.skew != null && row.skewDate !== row.date),
  };
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
      symbol: row.symbol, status: row.coverageStatus ?? row.status, queuedAt: row.coverage?.addedAt ?? null,
      backfilledThrough: row.coverage?.backfilledThrough ?? null, warning: row.warnings?.[0] ?? null,
      iv30, date: latest?.date ?? null, method: latest?.method ?? null,
      rank: row.iv30?.rank ?? null, percentile, rankDate: row.iv30?.date ?? null,
      termSlope: iv30 != null && latest?.iv90 != null ? iv30 - latest.iv90 : null,
      iv1y: latest?.iv365 ?? null,
      iv1yPercentile: latest?.iv365 != null && row.iv365 && row.iv365.date === row.iv30?.date ? row.iv365.percentile : null,
      skew: row.skew?.skew ?? null, skewDate: row.skew?.date ?? null, hv: realized,
      ivHv: iv30 != null && realized != null && realized > 0 ? iv30 / realized : null,
      verdict: verdictFor(percentile),
    };
  });
}

interface ScreenCoverage {
  /** One line per state, each symbol dated: queued since when, backfilled through which session. */
  notes: string[];
  /** Symbols whose history is still to come or not covered yet: the screen is incomplete while there are any. */
  pending: string[];
  /** Those of them with no reading to show yet. */
  missing: string[];
}

/**
 * What VCA says about symbols without a full history, in the report's notes
 * and the pane's notices. A queued symbol says since when and, with `retry`,
 * when to look again: ten minutes after the newest of them was queued. One
 * backfilling says how far it has got. One that finished with no options
 * history is final and leaves the screen complete; one demand coverage could
 * not take is not final. An older server says only ready or queued, without
 * dates, so its queued symbols are counted from now as before. A symbol in
 * `explained` (a listing that stopped trading, which its row says) is not
 * listed again as having no options history.
 */
export function screenCoverage(
  rows: readonly RichCheapRow[],
  options: { now?: number; retry?: boolean; explained?: ReadonlySet<string> } = {},
): ScreenCoverage {
  const now = options.now ?? Date.now();
  const queued = rows.filter((row) => row.status === "queued");
  const backfilling = rows.filter((row) => row.status === "backfilling");
  const final = rows.filter((row) => row.status === "unavailable" && !row.warning && !options.explained?.has(row.symbol));
  const uncovered = rows.filter((row) => row.status === "unavailable" && row.warning);
  const notes: string[] = [];
  if (queued.length) {
    const times = queued.map((row) => queuedTime(row.queuedAt, now));
    const listed = queued.map((row, index) => times[index] == null ? row.symbol : `${row.symbol} since ${utcClock(times[index]!, now)}`);
    const newest = Math.max(...times.map((time) => time ?? now));
    notes.push(`Queued for backfill: ${listed.join(", ")}; ${firstBackfillText(newest, now, options.retry ?? true)}.`);
  }
  if (backfilling.length) {
    notes.push(`Backfilling: ${backfilling.map((row) => row.backfilledThrough ? `${row.symbol} through ${row.backfilledThrough}` : row.symbol).join(", ")}.`);
  }
  if (final.length) notes.push(`No options history: ${final.map((row) => row.symbol).join(", ")}.`);
  const reasons = new Map<string, string[]>();
  for (const row of uncovered) reasons.set(row.warning!, [...(reasons.get(row.warning!) ?? []), row.symbol]);
  for (const [reason, symbols] of reasons) notes.push(`Not queued: ${symbols.join(", ")}. ${reason}`);
  const pending = [...queued, ...backfilling, ...uncovered];
  return { notes, pending: pending.map((row) => row.symbol),
    missing: pending.filter((row) => row.iv30 == null && row.date == null).map((row) => row.symbol) };
}

/**
 * The VCA pane's notices: the report's wording without a time to come back
 * at, since the pane checks again by itself, and a count of ready symbols with
 * no IV30, which is how an older server reports one that found no options.
 */
export function screenPaneNotices(rows: readonly RichCheapRow[], now = Date.now()): string[] {
  const empty = rows.filter((row) => row.status === "ready" && row.iv30 == null).length;
  return [...screenCoverage(rows, { now, retry: false }).notes,
    ...(empty ? [`${empty} symbol${empty === 1 ? " has" : "s have"} no stored implied volatility yet.`] : [])];
}

export const VCA_PRESETS = {
  etfs: ["SPY", "QQQ", "IWM", "DIA", "EEM", "EFA", "FXI", "EWZ", "GLD", "SLV", "GDX", "USO", "TLT", "HYG",
    "XLE", "XLF", "XLK", "XLV", "XLY", "XLP", "XLI", "XLU", "SMH", "XBI", "KRE"],
  megacaps: ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "AMD", "NFLX", "ORCL", "CRM",
    "JPM", "BAC", "GS", "V", "MA", "XOM", "CVX", "LLY", "UNH", "WMT", "COST", "HD", "BA"],
} as const;
export type VcaPreset = keyof typeof VCA_PRESETS;
export const VCA_LIMIT = 60;
