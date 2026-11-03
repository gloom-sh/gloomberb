import type { HeadlessPaneEntry } from "../../../types/headless";
import type { PricePoint } from "../../../types/financials";
import { cleanFloat32Price } from "../../../cli/history-rows";
import { exportNumber } from "../../../cli/report-tables";
import { isUsListingExchange, publicTickerKey } from "../../../utils/exchanges";
import { formatUtcTime } from "../../../utils/utc-time";
import { pricePointWicks } from "../../../utils/price-history-integrity";
import { futuresSessionOpenMinute } from "../../../market-data/market/trading-sessions";
import { getPublishedUsEquitySession } from "../../../market-data/published-us-sessions";
import { zonedDateKey, zonedDateTimeParts } from "../../../utils/zoned-date-time";

const NEW_YORK = "America/New_York";
const REGULAR_OPEN_MINUTE = 9 * 60 + 30;
const REGULAR_CLOSE_MINUTE = 16 * 60;

/** A US stock or fund line, whose day's range `quote` reads from its regular session; not a future on a US venue. */
function usStockLine(symbol: string, exchange: string): boolean {
  return isUsListingExchange(exchange) && futuresSessionOpenMinute(symbol, exchange) == null;
}

/**
 * The bars that start in a US regular session: from the venue's published
 * open to its close, 13:00 New York on an early close (the day after
 * Thanksgiving, Christmas Eve). A day the calendar does not publish is taken
 * as 09:30 to 16:00.
 */
function regularSessionBars<T extends Pick<PricePoint, "date">>(points: readonly T[], exchange: string): T[] {
  return points.filter(({ date }) => {
    const time = new Date(date).getTime();
    if (!Number.isFinite(time)) return false;
    const session = getPublishedUsEquitySession(exchange, zonedDateKey(time, NEW_YORK));
    if (session?.kind === "session") return time >= session.open && time < session.close;
    const { hour, minute } = zonedDateTimeParts(time, NEW_YORK);
    const at = hour * 60 + minute;
    return at >= REGULAR_OPEN_MINUTE && at < REGULAR_CLOSE_MINUTE;
  });
}

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
    // A wick too far from the bar's body to have traded is not a price the bars traded.
    const wicks = pricePointWicks(point);
    const pointLow = finitePositive(wicks.low) ?? finitePositive(point.close);
    const pointHigh = finitePositive(wicks.high) ?? finitePositive(point.close);
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

/**
 * What a US line's intraday bars count and how many of the regular session's
 * spans had no bar: `Bars are of every US venue's prints that set a
 * price; odd lots and special-condition prints count only in volume. 3 of 276
 * minutes had none, so no bar.` Each session is counted from the 09:30 open to
 * its close, or to its newest bar while it trades. Null for another venue.
 */
export function usBarCoverageNotice(
  windows: ReadonlyArray<SessionRangeWindow & { resolution?: string | null }>,
  now = Date.now(),
): string | null {
  const counts = windows.flatMap((window) => {
    const step = barStepMs(window.resolution);
    if (!step || !usStockLine(window.symbol, window.exchange)) return [];
    const bars = regularSessionBars(window.points, window.exchange).map(({ date }) => new Date(date).getTime());
    if (!bars.length) return [];
    let expected = 0;
    let present = 0;
    for (const date of new Set(bars.map((time) => zonedDateKey(time, NEW_YORK)))) {
      const session = getPublishedUsEquitySession(window.exchange, date);
      if (session?.kind !== "session") continue;
      const starts = new Set(bars.filter((time) => time >= session.open && time < session.close));
      // A session still trading is counted to its newest bar: the spans after it have not been served yet.
      const through = now < session.close ? Math.max(...starts) : session.close - step;
      for (let start = session.open; start <= through; start += step) {
        expected++;
        if (starts.has(start)) present++;
      }
    }
    return expected ? [{ listing: publicTickerKey(window.symbol, window.exchange), missing: expected - present, expected, step }] : [];
  });
  if (!counts.length) return null;
  const spans = (step: number, count: number) => step === 60_000 ? (count === 1 ? "minute" : "minutes")
    : step % 3_600_000 === 0 ? `${step / 3_600_000}-hour ${count === 1 ? "span" : "spans"}` : `${step / 60_000}-minute ${count === 1 ? "span" : "spans"}`;
  const each = counts.map(({ listing, missing, expected, step }) =>
    `${counts.length > 1 ? `${listing}: ` : ""}${missing} of ${expected} ${spans(step, expected)} had none, so no bar.`);
  return ["Bars are of every US venue's prints that set a price; odd lots and special-condition prints count only in volume.", ...each].join(" ");
}

/** A bar size as `1m`, `5m` or `1h` in milliseconds; null for a daily or longer one. */
function barStepMs(resolution: string | null | undefined): number | null {
  const match = /^(\d+)(m|h)$/.exec(resolution ?? "");
  if (!match) return null;
  return Number(match[1]) * (match[2] === "h" ? 3_600_000 : 60_000);
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
    // A US line's range is its regular session's, the rule `quote` reads the day's low and high by.
    const regular = usStockLine(window.symbol, window.exchange);
    const range = sessionRange(regular ? regularSessionBars(window.points, window.exchange) : window.points);
    if (!range) continue;
    const listing = publicTickerKey(window.symbol, window.exchange);
    const several = (window.sessionDates?.length ?? 1) > 1;
    const span = regular ? (several ? "regular-hours " : "regular-session ") : several ? "" : "session ";
    const currency = window.quote?.currency?.trim();
    // As the bars export them: the decimal the feed's float stands for (85.1, not 85.099998).
    const low = cleanFloat32Price(exportNumber(range.low.price));
    const high = cleanFloat32Price(exportNumber(range.high.price));
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
