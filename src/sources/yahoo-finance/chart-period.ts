import type { PricePoint } from "../../types/financials";

interface ChartMeta {
  regularMarketPrice?: unknown;
  regularMarketTime?: unknown;
  regularMarketDayHigh?: unknown;
  regularMarketDayLow?: unknown;
  regularMarketVolume?: unknown;
  regularMarketChangePercent?: unknown;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function periodEnd(start: number, interval: string): number | null {
  if (interval === "1d") return start + DAY_MS;
  if (interval === "1wk") return start + 7 * DAY_MS;
  if (interval === "1mo" || interval === "3mo") {
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + (interval === "1mo" ? 1 : 3));
    return end.getTime();
  }
  return null;
}

/**
 * Yahoo measures the regular-market change from the previous session's close.
 * A period row that ends at that close stops before the observation's session,
 * so the observation's volume is not in it yet.
 */
function endsBeforeObservation(close: number, meta: ChartMeta | undefined): boolean {
  const price = finite(meta?.regularMarketPrice);
  const change = finite(meta?.regularMarketChangePercent);
  if (price == null || change == null || change <= -100) return false;
  const priorClose = price / (1 + change / 100);
  // The change is rounded to thousandths of a percent.
  return Math.abs(close - priorClose) <= priorClose * 2e-5;
}

function foldedVolume(period: number | undefined, observation: number | undefined, add: boolean): number | undefined {
  if (period == null || observation == null) return period ?? observation;
  // A row already holding part of the session would count it twice.
  return add ? period + observation : Math.max(period, observation);
}

/**
 * Yahoo leaves the latest daily row's close null for hours after the close,
 * and appends the latest regular-market observation to weekly and monthly
 * charts as a separate row stamped at its trade time. Complete the current
 * period from the chart's own regular-market facts instead of dropping the
 * session or adding a second bar inside one period. Rows without a close
 * carry NaN.
 */
export function reconcileYahooCurrentPeriod(rows: PricePoint[], interval: string, meta: ChartMeta | undefined): PricePoint[] {
  if (!rows.length || periodEnd(0, interval) == null) return rows;
  const result = [...rows];
  const last = result.at(-1)!;
  const previous = result.at(-2);
  const previousEnd = previous ? periodEnd(previous.date.getTime(), interval) : null;
  // DST moves period labels by an hour; a trade-time observation sits well inside the period.
  if (interval !== "1d" && previous && previousEnd != null && last.date.getTime() < previousEnd - 2 * HOUR_MS) {
    result.pop();
    if (Number.isFinite(last.close) && last.close > 0) {
      const high = Math.max(previous.high ?? last.close, last.high ?? last.close);
      const low = Math.min(previous.low ?? last.close, last.low ?? last.close);
      // Monthly rows can already include the observation; weekly rows can stop a day earlier.
      const included = Math.fround(previous.close) === Math.fround(last.close) && high === previous.high && low === previous.low;
      if (!included) {
        result[result.length - 1] = {
          ...previous,
          high,
          low,
          close: last.close,
          volume: foldedVolume(previous.volume, last.volume, endsBeforeObservation(previous.close, meta)),
        };
      }
    }
  }
  const price = finite(meta?.regularMarketPrice);
  const time = (finite(meta?.regularMarketTime) ?? Number.NaN) * 1000;
  // A placeholder row for the next session can follow the one the quote closed.
  const index = result.findLastIndex((row) => {
    const start = row.date.getTime();
    return time >= start && time < (periodEnd(start, interval) ?? start);
  });
  const current = result[index];
  if (!current || (Number.isFinite(current.close) && current.close > 0) || price == null || price <= 0) return result;
  const daily = interval === "1d";
  const high = current.high ?? (daily ? finite(meta?.regularMarketDayHigh) : undefined);
  const low = current.low ?? (daily ? finite(meta?.regularMarketDayLow) : undefined);
  result[index] = {
    ...current,
    close: price,
    high: high == null ? undefined : Math.max(high, price),
    low: low == null ? undefined : Math.min(low, price),
    volume: current.volume ?? (daily ? finite(meta?.regularMarketVolume) : undefined),
  };
  return result;
}

// Yahoo builds an FX pair's calendar high and low from a different quote
// stream than its open and close, so they can miss each other by a few pips.
const FX_RANGE_TOLERANCE = 1e-3;

/**
 * Widen an FX calendar bar's high and low over an open or close that sits a
 * few pips outside them. A larger contradiction stays for the integrity checks.
 */
export function coverFxOpenClose(rows: PricePoint[]): PricePoint[] {
  return rows.map((row) => {
    const { open, high, low, close } = row;
    if (high == null || low == null || !(close > 0)) return row;
    const top = Math.max(close, open ?? close);
    const bottom = Math.min(close, open ?? close);
    if (top <= high && bottom >= low) return row;
    const tolerance = close * FX_RANGE_TOLERANCE;
    if (top - high > tolerance || low - bottom > tolerance) return row;
    return { ...row, high: Math.max(high, top), low: Math.min(low, bottom) };
  });
}

/**
 * Yahoo ends an intraday chart with the latest trade as its own row, stamped
 * at the trade time off the bar grid, with a placeholder volume of 0. That
 * volume is not known yet, so it must not read as a bar with no trading.
 */
export function withoutLiveRowVolume(rows: PricePoint[], intervalMs: number): PricePoint[] {
  const last = rows.at(-1);
  const previous = rows.at(-2);
  if (!last || !previous || last.volume !== 0) return rows;
  const offset = last.date.getTime() - previous.date.getTime();
  if (!(offset > 0) || offset % intervalMs === 0) return rows;
  return [...rows.slice(0, -1), { ...last, volume: undefined }];
}
