import type { CloudHistoryParams } from "../api-client/paths";
import type { CloudMarketResponse, CloudPricePointPayload } from "../api-client/types";
import { isCurrencyCode } from "../utils/currency-pair";
import { fxLegForCurrency, type FxLeg } from "./coordinator/fx-legs";

/** USD per unit of one currency at each completed daily FX close, by date. */
export interface FxCloses {
  currency: string;
  closes: ReadonlyMap<string, number>;
  first: string;
  asOf: string;
}

/** Why a daily FX history cannot be used: no usable closes, or none in the last week. */
export class FxHistoryError extends Error {
  constructor(readonly problem: "unavailable" | "stale") {
    super(problem === "stale" ? "Daily FX history is stale" : "Daily FX history unavailable");
    this.name = "FxHistoryError";
  }
}

const DAY_MS = 86_400_000;
/** A pair's latest completed close older than this is stale; a weekend and a holiday fit well inside it. */
const FX_MAX_AGE_DAYS = 7;

const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value;

/**
 * Completed daily closes of the pair as USD per unit, today's still-trading
 * bar left out. A malformed row, two different closes on one date, or more
 * rows than asked for rejects the whole history rather than a part of it.
 */
export function dailyFxCloses(
  response: CloudMarketResponse<CloudPricePointPayload[]>,
  leg: FxLeg,
  now = new Date(),
  maxRows = 1500,
): FxCloses {
  if (response.status !== "success" || !Array.isArray(response.data) || response.data.length < 2) throw new FxHistoryError("unavailable");
  if (response.stale || response.providerMeta?.stale) throw new FxHistoryError("stale");
  if (response.data.length > maxRows) throw new FxHistoryError("unavailable");
  const today = now.toISOString().slice(0, 10);
  const closes = new Map<string, number>();
  for (const row of response.data) {
    if (!row || typeof row.date !== "string" || !Number.isFinite(Date.parse(row.date)) || !isDay(row.date.slice(0, 10))
      || !Number.isFinite(row.close) || row.close <= 0) throw new FxHistoryError("unavailable");
    const date = new Date(row.date).toISOString().slice(0, 10);
    if (date >= today) continue;
    const rate = leg.invert ? 1 / row.close : row.close;
    const previous = closes.get(date);
    if (previous != null && previous !== rate) throw new FxHistoryError("unavailable");
    closes.set(date, rate);
  }
  const dates = [...closes.keys()].sort();
  const asOf = dates.at(-1);
  if (!asOf || Date.parse(today) - Date.parse(asOf) > FX_MAX_AGE_DAYS * DAY_MS) throw new FxHistoryError("stale");
  return { currency: leg.currency, closes, first: dates[0]!, asOf };
}

/**
 * The last completed close on or before `date` (YYYY-MM-DD), looking back at
 * most a week so a weekend or holiday finds the close before it but a gap in
 * the history is not bridged.
 */
export function fxCloseOnOrBefore(fx: FxCloses, date: string): { date: string; rate: number } | null {
  const end = Date.parse(`${(date < fx.asOf ? date : fx.asOf)}T00:00:00Z`);
  for (let back = 0; back <= FX_MAX_AGE_DAYS; back++) {
    const day = new Date(end - back * DAY_MS).toISOString().slice(0, 10);
    const rate = fx.closes.get(day);
    if (rate != null) return { date: day, rate };
  }
  return null;
}

/** Reads a pair's daily bars: `apiClient` in the app, a fake in tests. */
export interface FxHistoryClient {
  getCloudHistory(symbol: string, exchange: string, params: CloudHistoryParams): Promise<CloudMarketResponse<CloudPricePointPayload[]>>;
}

/** One unit of a currency in USD at a dated daily close. */
export interface FxCloseReading {
  /** USD per unit. */
  rate: number;
  /** The UTC day of the close: the day asked for, or the last trading day before it. */
  date: string;
}

/**
 * The daily pair a currency's USD value is read from: the leg the app streams
 * it on, or USD/XXX for any other ISO currency, which the service also keeps
 * daily closes of. Null for a code that is no currency.
 */
export function dailyFxLeg(currency: string): FxLeg | null {
  const code = currency.trim().toUpperCase();
  const leg = fxLegForCurrency(code);
  if (leg) return leg;
  return isCurrencyCode(code) ? { currency: code, instrument: { symbol: `${code}=X`, exchange: "" }, invert: true } : null;
}

const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * USD per unit of the leg's currency at its last completed daily close on or
 * before `date` (YYYY-MM-DD), looking back a week at most, so a weekend or a
 * holiday finds the close before it but a gap in the data is not bridged.
 * Today's bar, still trading, is never read. Null when the pair has no close
 * in that week. A cost bought on a date and `fx --date` both read it.
 */
export async function fxCloseOnDate(leg: FxLeg, date: string, client: FxHistoryClient, now = new Date()): Promise<FxCloseReading | null> {
  return (await readFxCloseOnDate(leg, date, client, now)).reading;
}

/**
 * `fxCloseOnDate`'s reading, and whether the service answered with any daily
 * bars of the pair at all: an `empty` or `unsupported` answer is a pair it
 * keeps no daily closes of, not a week without one.
 */
export async function readFxCloseOnDate(
  leg: FxLeg,
  date: string,
  client: FxHistoryClient,
  now = new Date(),
): Promise<{ reading: FxCloseReading | null; served: boolean }> {
  const day = Date.parse(`${date}T00:00:00Z`);
  const response = await client.getCloudHistory(leg.instrument.symbol, leg.instrument.exchange ?? "", {
    interval: "1day", startDate: isoDay(day - FX_MAX_AGE_DAYS * DAY_MS), endDate: isoDay(day + DAY_MS), outputsize: FX_MAX_AGE_DAYS + 4,
  });
  const served = response.status !== "empty" && response.status !== "unsupported";
  if (response.status !== "success" && response.status !== "partial") return { reading: null, served };
  const today = isoDay(now.getTime());
  let best: FxCloseReading | null = null;
  for (const row of Array.isArray(response.data) ? response.data : []) {
    const at = typeof row?.date === "string" ? Date.parse(row.date) : Number.NaN;
    if (!Number.isFinite(at) || !Number.isFinite(row.close) || row.close <= 0) continue;
    const rowDay = isoDay(at);
    if (rowDay > date || rowDay >= today || Date.parse(`${rowDay}T00:00:00Z`) < day - FX_MAX_AGE_DAYS * DAY_MS) continue;
    if (!best || rowDay > best.date) best = { rate: leg.invert ? 1 / row.close : row.close, date: rowDay };
  }
  return { reading: best, served };
}

/**
 * The completed daily closes of a currency's USD pair (`dailyFxLeg`) from a
 * week before `since` (YYYY-MM-DD) to today, read by `dailyFxCloses`, so the
 * first day finds the close before it. Throws `FxHistoryError` when the pair
 * has no usable history, and a plain error for a code that is no currency.
 */
export async function loadDailyFxCloses(
  currency: string,
  since: string,
  client: FxHistoryClient,
  now = new Date(),
): Promise<FxCloses> {
  const leg = dailyFxLeg(currency);
  if (!leg) throw new Error(`${currency} is not a currency with daily FX closes`);
  const start = Math.min(Date.parse(`${since}T00:00:00Z`), now.getTime()) - FX_MAX_AGE_DAYS * DAY_MS;
  // A trading week has five closes; seven a week leaves room for a source that also dates weekends.
  const rows = Math.ceil((now.getTime() - start) / DAY_MS) + 4;
  const response = await client.getCloudHistory(leg.instrument.symbol, leg.instrument.exchange ?? "", {
    interval: "1day", startDate: isoDay(start), endDate: isoDay(now.getTime()), outputsize: rows,
  });
  return dailyFxCloses(response, leg, now, Math.max(rows, 1500));
}
