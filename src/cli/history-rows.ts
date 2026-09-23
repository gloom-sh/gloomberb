import type { PricePoint } from "../types/financials";
import { marketPriceFractionDigitCeiling, resolveAssetDisplayKind } from "../market-data/market/format";
import { isIntradayResolution, type ManualChartResolution } from "../time-series/resolution";
import { getPricePointTimestamp } from "../utils/price-history";

const PRICE_KEYS = ["open", "high", "low", "close"] as const;
/** Daily bars are a day apart even when stamped at the session open. */
const INTRADAY_MAX_GAP_MS = 20 * 60 * 60 * 1000;

interface HistoryRow {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

function decimalPlaces(value: number): number {
  const [mantissa = "", exponent = "0"] = Math.abs(value).toString().split("e");
  return Math.max(0, (mantissa.split(".")[1]?.length ?? 0) - Number(exponent));
}

/**
 * Providers serve prices as float32: Yahoo sends the exact float
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

/** Without a declared cadence, bar spacing decides: daily bars may be stamped at the session open. */
function looksIntraday(times: readonly number[]): boolean {
  const finite = times.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length < 2) return finite.some((time) => !isUtcMidnight(time));
  const gaps = finite.slice(1).map((time, index) => time - finite[index]!).filter((gap) => gap > 0).sort((left, right) => left - right);
  return gaps.length > 0 && gaps[Math.floor((gaps.length - 1) / 2)]! < INTRADAY_MAX_GAP_MS;
}

/** Intraday bars keep their UTC time; daily and longer bars are trading dates. */
export function historyRows(points: readonly PricePoint[], resolution: ManualChartResolution | null): HistoryRow[] {
  const times = points.map(getPricePointTimestamp);
  const intraday = resolution ? isIntradayResolution(resolution) : looksIntraday(times);
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
 * One decimal count for the whole table so the price columns line up: the
 * count nine in ten prices need, so a stray long value does not widen every
 * row. A known asset kind caps it with the app's price display rules; without
 * one, the largest price sets a seven significant digit ceiling (BTC keeps
 * cents, FX keeps pips, sub-cent coins keep their digits). Cents at least above 1.
 */
export function historyPriceDecimals(rows: readonly HistoryRow[], assetCategory?: string): number {
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
