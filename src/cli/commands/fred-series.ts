import { toBasisPoints } from "../../utils/basis-points";

/** Where `fred` starts when `--start` is not given. */
export const DEFAULT_FRED_START = "2021-01-01";

/**
 * FRED series that are spreads, which FRED serves in percentage points and
 * rates desks read in basis points: `fred` text prints them in bp.
 */
const SPREAD_SERIES: ReadonlySet<string> = new Set([
  "T10Y2Y", "T10Y3M",
  "BAMLC0A0CM", "BAMLC0A1CAAA", "BAMLC0A2CAA", "BAMLC0A3CA", "BAMLC0A4CBBB", "BAMLH0A0HYM2",
]);

export function isSpreadSeries(seriesId: string): boolean {
  return SPREAD_SERIES.has(seriesId.toUpperCase());
}

/** A spread in percentage points as the bp a text table prints: 0.44 is `44`, -0.125 is `-12.5`. */
export function spreadBasisPointsCell(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(toBasisPoints(value, 1)) : "";
}

/**
 * Series FRED itself publishes late, with what a reader should know under the
 * table. Add a series here when its newest FRED observation is not the newest
 * reading the source has put out.
 */
const LAGGING_SERIES: Readonly<Record<string, string>> = {
  UMCSENT: "FRED publishes the University of Michigan survey with a lag; latest preliminary reading: fn ECO",
};

export function laggingSeriesNote(seriesId: string): string | null {
  return LAGGING_SERIES[seriesId.toUpperCase()] ?? null;
}

/**
 * Where a series' history starts relative to what was asked for: the default
 * start hides everything before it, and a start before the series begins
 * silently begins later.
 */
export function fredHistoryNotes(input: {
  startDate: string;
  startGiven: boolean;
  /** The series' first observation date, when FRED's metadata says. */
  seriesStart: string | null | undefined;
}): string[] {
  const seriesStart = input.seriesStart && /^\d{4}-\d{2}-\d{2}$/.test(input.seriesStart) ? input.seriesStart : null;
  if (!seriesStart) return [];
  if (seriesStart > input.startDate) return [`Series begins ${seriesStart}.`];
  return input.startGiven
    ? []
    : [`Showing from ${input.startDate}; earlier: --start YYYY-MM-DD (series begins ${seriesStart}).`];
}

/** What `fred` says when nothing falls on or after `--start`: where the series actually ends. */
export function fredEmptyMessage(startDate: string, latest: { date: string; value: number | null } | null): string {
  return latest
    ? `Latest observation: ${latest.date}${latest.value == null ? "" : ` (${latest.value})`}. Nothing on or after ${startDate}.`
    : "No results.";
}
