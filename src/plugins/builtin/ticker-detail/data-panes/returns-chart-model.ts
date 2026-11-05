import { barSessionDay } from "../../../../market-data/market/period-return";
import { isIntradayResolution, type ManualChartResolution } from "../../../../time-series/resolution";
import { summarizeReturns, type ReturnRow } from "./returns-model";

/** One interval of the chart: a bar from zero to its return. */
export interface ReturnBar {
  key: string;
  /** Where the chart puts it (returnBarTime). */
  time: number;
  /** The interval's return, a fraction; null for a gap (the bar before it had no price). */
  move: number | null;
}

export interface ReturnBars {
  /** Every row of the window, oldest first. */
  bars: ReturnBar[];
  /** The intervals that moved most each way, as the figures above name them. */
  best: ReturnBar | null;
  worst: ReturnBar | null;
  /** The newest interval with a return, which the chart rests on. */
  latest: ReturnBar | null;
  /** The newest interval is still trading: today, this week or this month so far. */
  forming: boolean;
}

/**
 * Where the chart draws a bar: an intraday bar at its open, a daily or
 * longer bar at midnight UTC of the session day the table dates it by, so a
 * JPX bar stamped 15:00 UTC the day before reads as its own day on the axis.
 */
export function returnBarTime(timestamp: number, resolution: ManualChartResolution, venue: string | undefined): number {
  if (isIntradayResolution(resolution)) return timestamp;
  const day = Date.parse(`${barSessionDay(timestamp, venue)}T00:00:00Z`);
  return Number.isFinite(day) ? day : timestamp;
}

/**
 * The window's rows as the chart's bars, oldest first, with the best, worst
 * and newest interval marked. Best and worst are summarizeReturns' own, so
 * the chart marks the bars the figures name, and none when no interval
 * stands out (one interval, or only equal ones). `formingKey` is the row the
 * table marks as still trading; the newest bar is forming only when it is
 * that row.
 */
export function buildReturnBars(
  rows: readonly ReturnRow[],
  resolution: ManualChartResolution,
  venue: string | undefined,
  formingKey?: string,
): ReturnBars {
  // Rows are newest first.
  const toBar = (row: ReturnRow): ReturnBar => ({
    key: row.key,
    time: returnBarTime(row.timestamp, resolution, venue),
    move: row.intervalPercent,
  });
  const bars = rows.map(toBar).reverse();
  const byKey = new Map(bars.map((bar) => [bar.key, bar]));
  const { best, worst } = summarizeReturns(rows);
  const latestRow = rows.find((row) => row.intervalPercent !== null);
  const latest = latestRow ? byKey.get(latestRow.key) ?? null : null;
  return {
    bars,
    best: best ? byKey.get(best.key) ?? null : null,
    worst: worst ? byKey.get(worst.key) ?? null : null,
    latest,
    forming: !!latest && formingKey !== undefined && latest.key === formingKey,
  };
}
