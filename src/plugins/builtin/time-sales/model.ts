import { sampleStatistics } from "../../../components/chart/curve/model";
import type { TapeQuote, TapeSnapshot, TapeTrade } from "../../../api-client/tape";

/** Preserve source order within a millisecond instead of rounding nanoseconds. */
export function tapeTimeKey(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  return match ? `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z` : value;
}
export const tapeTime = (value: string | null) => value ? value.replace("T", " ").replace(/Z$/, "") : "--";
/** Footer and session stamps read to the second; row detail keeps the exact SIP nanoseconds. */
export const tapeTimeSeconds = (value: string | null) => tapeTime(value).replace(/\.\d+$/, "");
export const tapeClock = (value: string) => value.slice(11).replace(/Z$/, "");
/** Tape rows read at millisecond precision; the row detail keeps the exact SIP nanoseconds. */
export const tapeClockMs = (value: string) => tapeClock(value).replace(/(\.\d{3})\d+$/, "$1");
/** Fixed decimals keep a column aligned: pass one digit count for the prices shown together. */
export const tapePrice = (value: number | null, digits?: number) => value == null ? "--"
  : value.toLocaleString("en-US", { minimumFractionDigits: digits ?? 2, maximumFractionDigits: digits ?? 4 });
const subPenny = (price: number | null) => price != null && Math.abs(price * 100 - Math.round(price * 100)) > 1e-6;
/** Two decimals, or four for a name below $1 (its SIP tick is $0.0001) or once any print in view is sub-penny. */
export const tapePriceDigits = (prices: readonly (number | null)[]) =>
  prices.some((price) => subPenny(price) || (price != null && price > 0 && price < 1)) ? 4 : 2;
export type TapeDigits = { symbol: string; digits: number };
/**
 * The first prices seen for a symbol set its decimals, and they only widen while
 * it stays on screen: a sub-penny print leaving the rolling window must not flip
 * every row and stat back to cents. Null until the symbol has a price.
 */
export function stickyTapePriceDigits(previous: TapeDigits | null, symbol: string, prices: readonly (number | null)[]): TapeDigits | null {
  if (previous?.symbol !== symbol) return prices.some((price) => price != null) ? { symbol, digits: tapePriceDigits(prices) } : null;
  return previous.digits < 4 && prices.some(subPenny) ? { symbol, digits: 4 } : previous;
}
export const tapeQuantity = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });
const tradeDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
export const tradeKey = (row: TapeTrade) => `${tradeDate.format(new Date(row.timestamp))}:${row.exchange}:${row.id}`;
export const quoteKey = (row: TapeQuote) => JSON.stringify([tapeTimeKey(row.timestamp), row.bidExchange, row.askExchange, row.bid, row.ask, row.bidSize, row.askSize, row.conditions, row.tape]);
export function newestFirst<T extends { timestamp: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => tapeTimeKey(b.timestamp).localeCompare(tapeTimeKey(a.timestamp)));
}
export function tapeStatistics(data: Pick<TapeSnapshot, "trades">) {
  const trades = newestFirst(data.trades);
  const prices = trades.map((row) => row.price);
  const sizes = trades.map((row) => row.size);
  const volume = sizes.reduce((sum, size) => sum + size, 0);
  const latest = trades[0] ?? null;
  return {
    latest, count: trades.length, volume,
    vwap: volume > 0 ? trades.reduce((sum, row) => sum + row.price * (row.size / volume), 0) : null,
    high: prices.length ? Math.max(...prices) : null,
    low: prices.length ? Math.min(...prices) : null,
    pricePercentile: prices.length < 20 ? null : sampleStatistics(prices, latest?.price ?? null).percentile,
    sizePercentile: sizes.length < 20 ? null : sampleStatistics(sizes, latest?.size ?? null).percentile,
    from: trades.at(-1)?.timestamp ?? null,
    asOf: latest?.timestamp ?? null,
  };
}
export function quoteSpread(row: TapeQuote) {
  if (row.bid == null || row.ask == null) return { spread: null, bps: null, state: "one-sided" as const };
  const spread = row.ask - row.bid, midpoint = (row.ask + row.bid) / 2;
  return { spread, bps: midpoint > 0 ? spread / midpoint * 10_000 : null,
    state: spread < 0 ? "crossed" as const : spread === 0 ? "locked" as const : "normal" as const };
}
