import { sampleStatistics } from "../../../components/chart/curve/model";
import type { TapeQuote, TapeSnapshot, TapeTrade } from "../../../api-client/tape";

/** Preserve source order within a millisecond instead of rounding nanoseconds. */
export function tapeTimeKey(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  return match ? `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z` : value;
}
export const tapeTime = (value: string | null) => value ? value.replace("T", " ").replace(/Z$/, "") : "--";
export const tapeClock = (value: string) => value.slice(11).replace(/Z$/, "");
export const tapePrice = (value: number | null) => value == null ? "--" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
export const tapeQuantity = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });
export const tradeKey = (row: TapeTrade) => `${row.timestamp.slice(0, 10)}:${row.exchange}:${row.id}`;
export const quoteKey = (row: TapeQuote) => `${tapeTimeKey(row.timestamp)}:${row.bidExchange}:${row.askExchange}:${row.bid}:${row.ask}:${row.bidSize}:${row.askSize}`;
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
