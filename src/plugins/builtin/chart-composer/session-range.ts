import type { HeadlessPaneEntry } from "../../../types/headless";
import type { PricePoint } from "../../../types/financials";
import { exportNumber } from "../../../cli/report-tables";
import { publicTickerKey } from "../../../utils/exchanges";
import { formatUtcTime } from "../../../utils/utc-time";

interface SessionExtreme {
  price: number;
  /** The open of the first bar that reached it. */
  at: Date;
}

interface SessionRange {
  low: SessionExtreme;
  high: SessionExtreme;
}

/**
 * The lowest and highest price the bars traded, each at the first bar that
 * reached it: a bar's low and high where it has them, else its close.
 */
function sessionRange(points: readonly PricePoint[]): SessionRange | null {
  let low: SessionExtreme | null = null;
  let high: SessionExtreme | null = null;
  for (const point of points) {
    const at = point.date;
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) continue;
    const pointLow = finitePositive(point.low) ?? finitePositive(point.close);
    const pointHigh = finitePositive(point.high) ?? finitePositive(point.close);
    if (pointLow != null && (!low || pointLow < low.price)) low = { price: pointLow, at };
    if (pointHigh != null && (!high || pointHigh > high.price)) high = { price: pointHigh, at };
  }
  return low && high ? { low, high } : null;
}

function finitePositive(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

interface SessionRangeWindow {
  symbol: string;
  exchange: string;
  points: readonly PricePoint[];
  sessionDates?: readonly string[];
  quote?: { currency?: string } | null;
}

export interface SessionRangeReport {
  /** For the Statistics section: `USDT-USD:CCC session low  0.99833 at 2026-10-17 11:30 UTC`. */
  entries: HeadlessPaneEntry[];
  /** For JSON: each listing's extremes with their instants. */
  ranges: Array<{ symbol: string; exchange: string | null; low: number; lowAt: string; high: number; highAt: string }>;
}

/**
 * Each listing an intraday graph read, its window's low and high and when
 * they traded. A window of several sessions says low and high, not session.
 */
export function sessionRangeReport(windows: readonly SessionRangeWindow[]): SessionRangeReport {
  const report: SessionRangeReport = { entries: [], ranges: [] };
  for (const window of windows) {
    const range = sessionRange(window.points);
    if (!range) continue;
    const listing = publicTickerKey(window.symbol, window.exchange);
    const span = (window.sessionDates?.length ?? 1) > 1 ? "" : "session ";
    const currency = window.quote?.currency?.trim();
    const low = exportNumber(range.low.price);
    const high = exportNumber(range.high.price);
    const entry = (side: "low" | "high", price: number, at: Date): HeadlessPaneEntry => ({
      key: side === "low" ? "sessionLow" : "sessionHigh",
      label: `${listing} ${span}${side}`,
      value: price,
      formatted: `${price} at ${formatUtcTime(at)}`,
      ...currency ? { unit: currency } : {},
    });
    report.entries.push(entry("low", low, range.low.at), entry("high", high, range.high.at));
    report.ranges.push({
      symbol: window.symbol,
      exchange: window.exchange || null,
      low,
      lowAt: range.low.at.toISOString(),
      high,
      highAt: range.high.at.toISOString(),
    });
  }
  return report;
}
