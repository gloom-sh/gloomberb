import type { PricePoint, Quote } from "../../../types/financials";
import { calendarMonthsBefore } from "../../../utils/calendar-date";
import type { FuturesContract } from "./contracts";
import { quotedContractMonth } from "./model";

export type FuturesReturnHorizon = "1W" | "1M" | "YTD";
export type FuturesReturnValues = Readonly<Record<FuturesReturnHorizon, number | null>>;

export const NO_FUTURES_RETURNS: FuturesReturnValues = { "1W": null, "1M": null, YTD: null };

const MONTH_CODES = "FGHJKMNQUVXZ";
const DAY_MS = 86_400_000;

/** Yahoo symbol of one listed contract: LEZ26.CME. */
export function listedContractSymbol(contract: FuturesContract, year: number, month: number): string {
  return `${contract.code}${MONTH_CODES[month]}${String(year % 100).padStart(2, "0")}.${contract.venue}`;
}

/**
 * A root listing every month never quotes the current month's contract (crude,
 * gas and products expire the month before delivery) and at most three months
 * out (Brent trades until two months before delivery).
 */
const MONTHLY_FRONT_OFFSETS = [1, 2, 3];

/**
 * The listed contracts the continuous alias may be quoting. A quote whose name
 * carries a month is that contract, the one the board already labels the row
 * with. A name without one (Dutch TTF gas, Brent on some routes) leaves each
 * month that could be front on a root listing every month, and the price
 * picks among them.
 */
export function frontContractCandidates(contract: FuturesContract, quote: Quote | null | undefined): string[] {
  const named = quotedContractMonth(contract, quote);
  if (named) return [listedContractSymbol(contract, named.year, named.month)];
  if (!contract.everyMonth || !quote || !Number.isFinite(quote.lastUpdated)) return [];
  const at = new Date(quote.lastUpdated);
  return MONTHLY_FRONT_OFFSETS.map((offset) => {
    const month = at.getUTCMonth() + offset;
    return listedContractSymbol(contract, at.getUTCFullYear() + Math.floor(month / 12), month % 12);
  });
}

interface DailyClose {
  day: string;
  close: number;
}

function utcDay(value: Date | string | number): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Dated closes, one per day, oldest first. History that crossed a JSON bridge carries string dates. */
function dailyCloses(history: readonly PricePoint[]): DailyClose[] {
  const byDay = new Map<string, number>();
  for (const point of history) {
    const day = utcDay(point.date as Date | string | number);
    if (day && Number.isFinite(point.close)) byDay.set(day, point.close);
  }
  return [...byDay].sort(([left], [right]) => left.localeCompare(right)).map(([day, close]) => ({ day, close }));
}

/**
 * Among contracts that could be front, the one whose latest close sits nearest
 * the alias's price. Neighbouring months can be a fraction of a percent apart,
 * so this only decides between candidates; it never vets a named contract.
 */
export function pickFrontContract(
  candidates: ReadonlyArray<{ symbol: string; history: readonly PricePoint[] }>,
  price: number | null | undefined,
): string | null {
  if (candidates.length === 1) return candidates[0]!.symbol;
  if (price == null || !Number.isFinite(price) || price === 0) return null;
  let best: { symbol: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const latest = dailyCloses(candidate.history).at(-1);
    if (!latest) continue;
    const distance = Math.abs(latest.close / price - 1);
    if (!best || distance < best.distance) best = { symbol: candidate.symbol, distance };
  }
  return best?.symbol ?? null;
}

/**
 * A baseline further than this before its target date is a hole in the
 * contract's trading (or a contract listed after the target), not its close.
 */
const MAX_BASELINE_GAP_DAYS = 10;

function closeOnOrBefore(closes: readonly DailyClose[], target: string): number | null {
  const earliest = shiftDay(target, -MAX_BASELINE_GAP_DAYS);
  for (let index = closes.length - 1; index >= 0; index -= 1) {
    const bar = closes[index]!;
    if (bar.day > target) continue;
    return bar.day >= earliest && bar.close > 0 ? bar.close : null;
  }
  return null;
}

/**
 * One contract's returns: the latest price against that same contract's close
 * a week, a calendar month, and a year-end earlier. The continuous alias's own
 * series jumps at every roll (LE=F fell 6.3% on a July roll day), so its
 * history is never the baseline. `price` is the live quote, dated `asOf`;
 * without one the contract's last close stands in.
 */
export function frontContractReturns(
  history: readonly PricePoint[],
  price: number | null | undefined,
  asOf: number | null | undefined,
): FuturesReturnValues {
  const closes = dailyCloses(history);
  const live = price != null && Number.isFinite(price) && asOf != null && Number.isFinite(asOf);
  const latest = live ? price : closes.at(-1)?.close;
  const latestDay = live ? utcDay(asOf) : closes.at(-1)?.day;
  if (latest == null || !latestDay) return NO_FUTURES_RETURNS;
  const change = (target: string) => {
    const base = closeOnOrBefore(closes, target);
    return base == null ? null : (latest / base - 1) * 100;
  };
  const monthBack = calendarMonthsBefore(new Date(`${latestDay}T00:00:00Z`), 1).toISOString().slice(0, 10);
  return {
    "1W": change(shiftDay(latestDay, -7)),
    "1M": change(monthBack),
    YTD: change(`${Number(latestDay.slice(0, 4)) - 1}-12-31`),
  };
}
