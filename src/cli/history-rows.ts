import type { PricePoint } from "../types/financials";
import { isIntradayResolution, type ManualChartResolution } from "../time-series/resolution";
import { getPricePointTimestamp } from "../utils/price-history";

const PRICE_KEYS = ["open", "high", "low", "close"] as const;

interface HistoryRow {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

/**
 * Yahoo serves prices as float32 (340.33 arrives as 340.3299865722656).
 * Return the shortest decimal with the same float32 value. A value that is
 * not exactly a float32 came from a double source and is returned unchanged.
 */
export function cleanFloat32Price(value: number): number {
  if (!Number.isFinite(value) || value === 0 || Math.fround(value) !== value) return value;
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === value) return candidate;
  }
  return value;
}

function isUtcMidnight(time: number): boolean {
  return new Date(time).toISOString().endsWith("T00:00:00.000Z");
}

/** Intraday bars keep their UTC time; daily and longer bars are trading dates. */
export function historyRows(points: readonly PricePoint[], resolution: ManualChartResolution | null): HistoryRow[] {
  const times = points.map(getPricePointTimestamp);
  const intraday = resolution ? isIntradayResolution(resolution)
    : times.some((time) => Number.isFinite(time) && !isUtcMidnight(time));
  return points.map((point, index) => {
    const time = times[index]!;
    const iso = Number.isFinite(time) ? new Date(time).toISOString() : "";
    const price = (value: number | undefined) => value == null ? null : cleanFloat32Price(value);
    return {
      date: intraday ? iso.replace(".000Z", "Z") : iso.slice(0, 10),
      open: price(point.open),
      high: price(point.high),
      low: price(point.low),
      close: cleanFloat32Price(point.close),
      volume: point.volume ?? null,
    };
  });
}

function neededDecimals(value: number, cap: number): number {
  for (let decimals = 0; decimals < cap; decimals++) {
    if (Number(value.toFixed(decimals)) === value) return decimals;
  }
  return cap;
}

/**
 * One decimal count for the whole table so the price columns line up. The
 * largest price sets a seven significant digit ceiling (BTC keeps cents, FX
 * keeps pips, sub-cent coins keep their digits), with at least cents above 1.
 */
export function historyPriceDecimals(rows: readonly HistoryRow[]): number {
  const values = rows.flatMap((row) => PRICE_KEYS.flatMap((key) => {
    const value = row[key];
    return value != null && Number.isFinite(value) && value !== 0 ? [Math.abs(value)] : [];
  }));
  if (!values.length) return 2;
  const largest = values.reduce((max, value) => Math.max(max, value), 0);
  const magnitude = Math.floor(Math.log10(largest));
  const cap = largest >= 1 ? Math.max(2, 6 - magnitude) : 6 - magnitude;
  const decimals = values.reduce((max, value) => Math.max(max, neededDecimals(value, cap)), 0);
  return largest >= 1 ? Math.max(2, decimals) : decimals;
}
