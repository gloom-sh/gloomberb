import type { PricePoint, Quote } from "../../../types/financials";
import { periodBaseDay, periodReturn } from "../../../market-data/market/period-return";
import type { FuturesContract } from "../../../market-data/futures-board";
import { quotedContractMonth } from "./model";

/** The board draws 1W, 1M and YTD; its JSON and CSV add 3M, 6M and 1Y. */
export type FuturesReturnHorizon = "1W" | "1M" | "3M" | "6M" | "1Y" | "YTD";
export type FuturesReturnValues = Readonly<Record<FuturesReturnHorizon, number | null>>;

const HORIZONS: readonly FuturesReturnHorizon[] = ["1W", "1M", "3M", "6M", "1Y", "YTD"];

export const NO_FUTURES_RETURNS: FuturesReturnValues = { "1W": null, "1M": null, "3M": null, "6M": null, "1Y": null, YTD: null };

/** The day of the close each return is measured from (`YYYY-MM-DD`), null where it has none. */
export type FuturesReturnBases = Readonly<Record<FuturesReturnHorizon, string | null>>;

const MONTH_CODES = "FGHJKMNQUVXZ";

/** Gloom symbol of one listed contract: LEZ26.CME. */
function listedContractSymbol(contract: FuturesContract, year: number, month: number): string {
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
  // A VIX generic (VX1) names no listed contract the history endpoints read: its row has no returns.
  if (contract.venue === "CFE") return [];
  const named = quotedContractMonth(contract, quote);
  if (named) return [listedContractSymbol(contract, named.year, named.month)];
  if (!contract.everyMonth || !quote || !Number.isFinite(quote.lastUpdated)) return [];
  const at = new Date(quote.lastUpdated);
  return MONTHLY_FRONT_OFFSETS.map((offset) => {
    const month = at.getUTCMonth() + offset;
    return listedContractSymbol(contract, at.getUTCFullYear() + Math.floor(month / 12), month % 12);
  });
}

/**
 * Why a row's return is empty: a generic (VX1) that names no listed contract
 * the history reads cover, a quote that names no contract to measure, a
 * contract with no daily history, a read that failed, or a contract whose
 * daily history starts after the close the return runs from (a contract
 * listed since, or a source holding only its latest session).
 */
export type FuturesReturnGap =
  | { kind: "generic" }
  | { kind: "no-contract" }
  | { kind: "failed" }
  | { kind: "no-history"; contract: string }
  | { kind: "starts-later"; contract: string; firstDay: string }
  | { kind: "no-base"; contract: string; baseDay: string };

export type FuturesReturnGaps = Readonly<Partial<Record<FuturesReturnHorizon, FuturesReturnGap>>>;

/** The same gap for every horizon. */
export function allReturnGaps(gap: FuturesReturnGap): FuturesReturnGaps {
  return Object.fromEntries(HORIZONS.map((horizon) => [horizon, gap]));
}

/** ESZ26 for ESZ26.CME: the contract as its row's month names it. */
export const contractCode = (symbol: string) => symbol.replace(/\.[A-Z]+$/, "");

/**
 * Why each empty return of a contract with a history read is empty: its
 * first close comes after the day the return runs from, or it has no close
 * near that day.
 */
export function frontContractReturnGaps(
  symbol: string,
  history: readonly PricePoint[],
  values: FuturesReturnValues,
  price: number | null | undefined,
  asOf: number | null | undefined,
): FuturesReturnGaps {
  const contract = contractCode(symbol);
  const closes = dailyCloses(history);
  const first = closes[0]?.day;
  const live = price != null && Number.isFinite(price) && asOf != null && Number.isFinite(asOf);
  const end = (live ? utcDay(asOf) : null) ?? closes.at(-1)?.day;
  const gaps: Partial<Record<FuturesReturnHorizon, FuturesReturnGap>> = {};
  for (const horizon of HORIZONS) {
    if (values[horizon] != null) continue;
    const baseDay = end ? periodBaseDay(end, horizon) : null;
    gaps[horizon] = !first ? { kind: "no-history", contract }
      : baseDay && first > baseDay ? { kind: "starts-later", contract, firstDay: first }
        : { kind: "no-base", contract, baseDay: baseDay ?? first };
  }
  return gaps;
}

interface DailyClose {
  day: string;
  close: number;
}

function utcDay(value: Date | string | number): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
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
 * One contract's returns: the latest price against that same contract's close
 * on or before the same date a week and one, three, six and twelve calendar
 * months earlier, and its last close of the year before (periodReturn). The continuous alias's own
 * series jumps at every roll (LE=F fell 6.3% on a July roll day), so its
 * history is never the baseline. `price` is the live quote, dated `asOf`;
 * without one the contract's last close stands in.
 */
export function frontContractReturns(
  history: readonly PricePoint[],
  price: number | null | undefined,
  asOf: number | null | undefined,
): FuturesReturnValues {
  return frontContractPeriodReturns(history, price, asOf).values;
}

/**
 * frontContractReturns with the day of each return's base close, which the
 * board's JSON and CSV carry and its report names: `fn FUT ZC`'s
 * 1M on Thu 5 Nov runs from Mon 5 Oct's close, as CTM's 1M curve and RETURN do.
 */
export function frontContractPeriodReturns(
  history: readonly PricePoint[],
  price: number | null | undefined,
  asOf: number | null | undefined,
): { values: FuturesReturnValues; bases: FuturesReturnBases } {
  const closes = dailyCloses(history);
  const live = price != null && Number.isFinite(price) && asOf != null && Number.isFinite(asOf);
  const liveDay = live ? utcDay(asOf) : null;
  const latest = live && liveDay ? { day: liveDay, close: price } : closes.at(-1);
  if (!latest) return { values: NO_FUTURES_RETURNS, bases: { "1W": null, "1M": null, "3M": null, "6M": null, "1Y": null, YTD: null } };
  const periods = HORIZONS.map((period) => [period, periodReturn(closes, period, latest)] as const);
  return {
    values: Object.fromEntries(periods.map(([period, result]) => [period, result?.percent ?? null])) as FuturesReturnValues,
    bases: Object.fromEntries(periods.map(([period, result]) => [period, result?.base.day ?? null])) as FuturesReturnBases,
  };
}
