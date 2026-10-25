import type { CloudMarketResponse, CloudPricePointPayload } from "../../../api-client/types";
import { fxLegForCurrency, type FxLeg } from "../../../market-data/coordinator/fx-legs";
import { dailyFxCloses, FxHistoryError, type FxCloses } from "../../../market-data/fx-closes";
import { getPublishedUsEquityCalendarDay } from "../../../market-data/published-us-sessions";
import type { PricePoint } from "../../../types/financials";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import type { DatedReturn } from "./metrics";

export type { FxCloses };

/**
 * The daily closes that restate a non-USD account's returns, as the market
 * load keeps them (plain data, so the cache can hold them), or why there are none.
 */
export interface AccountFx {
  currency: string;
  /** "USD/TRY" or "EUR/USD", as the pair trades; null when no daily pair prices the currency. */
  pair: string | null;
  /** USD per unit of the account currency at each completed daily close; empty with an error. */
  closes: Record<string, number>;
  first: string | null;
  asOf: string | null;
  /** Why returns cannot convert into the account currency; every holding is left out with it. */
  error: string | null;
}

/** How a listing quoted in another currency is restated in USD. */
export interface RiskConversion {
  /** The listing currency as quoted, sub-units included (GBp, ZAc). */
  listingCurrency: string;
  /** The currency the FX pair prices (GBP for GBp). */
  currency: string;
  /** Listing units per currency unit: 100 for pence. */
  divisor: number;
  leg: FxLeg;
}

export const FX_UNAVAILABLE = "Foreign holdings: daily FX closes unavailable";
export const FX_NO_PAIR = "Foreign holdings: no daily FX pair for this currency";
export const FX_STALE = "Foreign holdings: daily FX history is stale";
export const FX_GAP = "Foreign holdings: daily FX history has gaps longer than three days on the holding's dates";
export const FX_DISAGREES = "Foreign holdings: daily FX closes disagree with the current rate";
export const LOCAL_GAP = "Foreign holdings: local daily history has a gap longer than a market holiday";

/**
 * Most FX trading days in a row (weekdays) a pair may go without a daily
 * close and still be bridged with the last close before them: Good Friday and
 * Easter Monday, 25 December, 1 January, which the daily source skips while
 * US sessions continue. A longer run is missing data and rejects the series.
 */
const MAX_BRIDGED_FX_DAYS = 3;

/**
 * Longest run of calendar days a listing may go without a close while US
 * sessions continue (Golden Week, Lunar New Year, national holidays). A longer
 * silence is missing data, not a holiday, and is never carried across.
 */
const MAX_LOCAL_CLOSED_DAYS = 10;
/** The calendar the basket, SPY and the factor proxies share. */
const BASKET_CALENDAR = "NYSE";
const DAY_MS = 86_400_000;

/** The daily pair of an account currency as dealers quote it ("USD/TRY", "EUR/USD"), or null when none prices it. */
export function accountFxPair(currency: string): string | null {
  const leg = fxLegForCurrency(currency);
  return !leg ? null : leg.invert ? `USD/${leg.currency}` : `${leg.currency}/USD`;
}

/**
 * Why the account currency's daily closes cannot convert a holding: the
 * problem a listing's own conversion would report (stale, unavailable,
 * gapped, disagreeing with the current rate), said of the account's pair.
 */
export function accountFxReason(currency: string, problem: string): string {
  const pair = accountFxPair(currency);
  if (!pair) return `No daily FX pair converts USD into the account currency ${currency}`;
  const tail = /^Foreign holdings: (daily FX .*)$/.exec(problem)?.[1];
  return `${pair} ${tail ?? "daily FX closes unavailable"}`;
}

/**
 * The FX close a date converts at: the pair's own close that day, or the last
 * close before it across at most MAX_BRIDGED_FX_DAYS weekdays without one
 * (`bridged`). Null when the gap is longer, or no close comes before it.
 */
export function bridgedFxClose(rateOn: (date: string) => number | undefined, date: string): { rate: number; bridged: boolean } | null {
  let missing = 0;
  for (let time = Date.parse(`${date}T00:00:00Z`), step = 0; step <= 7 + MAX_BRIDGED_FX_DAYS; step++, time -= DAY_MS) {
    const day = new Date(time).toISOString().slice(0, 10);
    const rate = rateOn(day);
    if (rate != null && rate > 0) return { rate, bridged: day !== date };
    const weekday = new Date(time).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && ++missing > MAX_BRIDGED_FX_DAYS) return null;
  }
  return null;
}

/**
 * "GBP/USD has no daily close on 2025-04-18 and 2025-04-21; the returns across
 * them use the close before": what a conversion bridged (bridgedFxClose), said
 * once per pair. Null when it bridged nothing.
 */
export function fxBridgeNote(pair: string, dates: Iterable<string>): string | null {
  const days = [...new Set(dates)].sort();
  if (!days.length) return null;
  const shown = days.length > 4 ? [...days.slice(0, 3), `${days.length - 3} more days`] : days;
  const list = shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)!}`;
  return `${pair} has no daily close on ${list}; the returns across ${days.length === 1 ? "it use the close before it" : "them use the close before each"}.`;
}

/** Account returns, and the dates whose FX close was the last one before them (bridgedFxClose). */
export interface AccountReturns {
  returns: DatedReturn[];
  bridged: string[];
}

/**
 * Restates daily USD returns in the account currency at the FX closes of each
 * return's own start and end dates: the holding's USD value is divided by the
 * USD price of one account unit on both dates, so a return becomes
 * (1 + r) * fx(start) / fx(end) - 1. A listing already converted from its own
 * currency to USD therefore converts at the cross of the two closes of the
 * same date. Returns before the first FX close or after the last are dropped,
 * so the series starts and ends with the FX history. An endpoint without an FX
 * close converts at the last close before it across a gap of up to
 * MAX_BRIDGED_FX_DAYS FX trading days (Good Friday and Easter Monday), and
 * says so in `bridged`; a longer gap rejects the whole series.
 */
export function convertReturnsToAccount(
  returns: readonly DatedReturn[],
  fx: Pick<AccountFx, "currency" | "closes" | "first" | "asOf">,
): AccountReturns {
  if (!fx.first || !fx.asOf) throw new Error(accountFxReason(fx.currency, FX_UNAVAILABLE));
  const converted: DatedReturn[] = [];
  const bridged = new Set<string>();
  const rateOn = (date: string) => fx.closes[date];
  for (const point of returns) {
    if (point.startDateKey < fx.first || point.dateKey > fx.asOf) continue;
    const start = bridgedFxClose(rateOn, point.startDateKey),
      end = bridgedFxClose(rateOn, point.dateKey);
    if (!start || !end) throw new Error(accountFxReason(fx.currency, FX_GAP));
    if (start.bridged) bridged.add(point.startDateKey);
    if (end.bridged) bridged.add(point.dateKey);
    converted.push({ ...point, value: (1 + point.value) * (start.rate / end.rate) - 1 });
  }
  return { returns: converted, bridged: [...bridged].sort() };
}

/** The pair that restates a listing currency in USD, or null when there is none. */
export function riskConversion(listingCurrency: string): RiskConversion | null {
  const unit = resolveCurrencyUnit(listingCurrency);
  if (!unit.currency || unit.currency === "USD") return null;
  const leg = fxLegForCurrency(unit.currency);
  return leg ? { listingCurrency, currency: unit.currency, divisor: unit.divisor, leg } : null;
}

/** Completed daily closes of the pair as USD per unit, today's still-trading bar left out. */
export function validateFxHistory(
  response: CloudMarketResponse<CloudPricePointPayload[]>,
  leg: FxLeg,
  now = new Date(),
): FxCloses {
  try {
    return dailyFxCloses(response, leg, now);
  } catch (error) {
    if (error instanceof FxHistoryError) throw new Error(error.problem === "stale" ? FX_STALE : FX_UNAVAILABLE);
    throw error;
  }
}

/**
 * Restates a listing's completed local closes in USD on every NYSE session
 * they span, each at the FX close of that same date, so the converted series
 * shares the basket's calendar and its returns pair with SPY and the other
 * holdings interval for interval.
 *
 * On a US session the listing did not trade (its own holiday), the holding is
 * worth its last local close at that day's FX close: its USD value moves with
 * the currency alone, as it would in the account. A US session with no FX
 * close converts at the last close before it across a gap of up to
 * MAX_BRIDGED_FX_DAYS FX trading days, listed in `bridged`; a longer FX gap,
 * or a local silence longer than any market holiday, rejects the whole
 * series instead of bridging it. The series ends at the earlier of the last
 * local close and the last FX close, so no close is carried past the data.
 */
export function convertClosesToUsd(
  local: readonly { date: string; close: number }[],
  fx: FxCloses,
  divisor: number,
): { points: PricePoint[]; bridged: string[] } {
  const points = [...local]
    .map((point) => ({ date: point.date.slice(0, 10), close: point.close }))
    .sort((left, right) => left.date.localeCompare(right.date));
  if (points.length < 2) throw new Error("Daily history unavailable");
  const start = points[0]!.date > fx.first ? points[0]!.date : fx.first;
  const end = points.at(-1)!.date < fx.asOf ? points.at(-1)!.date : fx.asOf;
  const converted: PricePoint[] = [];
  const bridged: string[] = [];
  const rateOn = (date: string) => fx.closes.get(date);
  let cursor = 0;
  for (let time = Date.parse(`${start}T00:00:00Z`); time <= Date.parse(`${end}T00:00:00Z`); time += DAY_MS) {
    const date = new Date(time).toISOString().slice(0, 10);
    const day = getPublishedUsEquityCalendarDay(BASKET_CALENDAR, date);
    if (day == null) throw new Error("Daily calendar unavailable");
    if (day !== "session") continue;
    while (cursor + 1 < points.length && points[cursor + 1]!.date <= date) cursor += 1;
    const last = points[cursor]!;
    if (last.date > date) continue;
    if (time - Date.parse(`${last.date}T00:00:00Z`) > MAX_LOCAL_CLOSED_DAYS * DAY_MS) throw new Error(LOCAL_GAP);
    const fxClose = bridgedFxClose(rateOn, date);
    if (!fxClose) throw new Error(FX_GAP);
    if (fxClose.bridged) bridged.push(date);
    const close = (last.close * fxClose.rate) / divisor;
    converted.push({ date: new Date(time), open: close, high: close, low: close, close });
  }
  if (converted.length < 2) throw new Error("Daily history unavailable");
  return { points: converted, bridged };
}
