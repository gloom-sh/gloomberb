import { ICE_SPREAD_SERIES } from "../../time-series/ice-credit";
import { toBasisPoints } from "../../utils/basis-points";
import { parseReportTime } from "../../utils/utc-time";

/** Where `fred` starts when `--start` is not given. */
export const DEFAULT_FRED_START = "2021-01-01";

/**
 * FRED series that are spreads, which FRED serves in percentage points and
 * rates desks read in basis points: `fred` text prints them in bp.
 */
const SPREAD_SERIES: ReadonlySet<string> = new Set([
  "T10Y2Y", "T10Y3M",
  ...ICE_SPREAD_SERIES.map((series) => series.seriesId),
]);

export function isSpreadSeries(seriesId: string): boolean {
  return SPREAD_SERIES.has(seriesId.toUpperCase());
}

/**
 * The field a series' observations export under, named by their unit: a
 * spread in basis points (`value_bp`), a percent (`value_pct`), any other
 * unit slugged from FRED's own (`Index 1982-1984=100` is
 * `value_index_1982_1984_100`), and `value_unit_unknown` when FRED's
 * metadata did not come back. Never a bare `value`.
 */
export function fredValueKey(seriesId: string, units: string | null | undefined): string {
  if (isSpreadSeries(seriesId)) return "value_bp";
  const unit = units?.trim() ?? "";
  if (/^percent$/i.test(unit)) return "value_pct";
  const slug = unit.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `value_${slug || "unit_unknown"}`;
}

/**
 * The value column's header: FRED's units, and "annual rate" when a monthly or
 * quarterly flow is stated at a seasonally adjusted annual rate (GDP, FDEFX),
 * so a quarter's 1,100 billion does not read as spent in that quarter.
 */
export function fredValueHeader(info: { units?: string | null; seasonalAdjustment?: string | null } | null | undefined): string {
  const units = info?.units?.trim();
  if (!units) return "Value";
  const annualRate = /annual rate/i.test(info?.seasonalAdjustment ?? "") && !/annual rate/i.test(units);
  return `Value (${units}${annualRate ? ", annual rate" : ""})`;
}

/** An observation in the unit it exports in: a spread's percentage points as basis points (3.15 is 315), anything else as FRED gives it. */
export function fredExportValue(seriesId: string, value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return isSpreadSeries(seriesId) ? toBasisPoints(value, 4) : value;
}

/** Basis points as a text table prints them, to a tenth: 44 is `44`, -12.5 is `-12.5`. */
export function basisPointsCell(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const rounded = Math.round(value * 10) / 10;
  return String(rounded === 0 ? 0 : rounded);
}

/**
 * When FRED last updated a series, its `last_updated` (`2026-10-09 08:08:04-05`),
 * as an ISO instant in UTC: the publication time an export cites. Only when
 * that update covers the newest observation shown (`observationEnd` reaches
 * it): metadata from before it says nothing about when it was published.
 * Null when it does not, or when FRED's metadata does not say.
 */
export function fredPublicationTime(
  info: { lastUpdated?: string | null; observationEnd?: string | null } | null | undefined,
  newestDate: string | null | undefined,
): string | null {
  if (newestDate && !(info?.observationEnd && info.observationEnd >= newestDate)) return null;
  const iso = (info?.lastUpdated ?? "").trim().replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T").replace(/([+-]\d{2})$/, "$1:00");
  const time = parseReportTime(iso);
  return time && !time.dateOnly ? new Date(time.time).toISOString() : null;
}

/** Where a FRED report's figures come from, as its source line names them. */
export interface FredProvenance {
  source: string;
  publisher?: string;
  publishedAt?: string;
}

/**
 * Where the newest of these observations comes from: FRED, unless Gloom
 * Cloud carried a value FRED does not list yet and named its publisher. Then
 * the source line names that publisher and when it published, so a reader
 * looking for the figure in FRED's own data knows it is not there yet:
 * `U.S. Treasury via FRED, published 2026-10-09`. Null for FRED's own.
 */
export function fredProvenance(observations: ReadonlyArray<{ date: string; publisher?: string; publishedAt?: string }>): FredProvenance | null {
  const ahead = observations.filter((observation) => observation.publisher?.trim());
  if (ahead.length === 0) return null;
  const publishers = [...new Set(ahead.map((observation) => observation.publisher!.trim()))];
  const times = ahead.flatMap((observation) => {
    const time = parseReportTime(observation.publishedAt);
    return time ? [new Date(time.time).toISOString()] : [];
  }).sort();
  const publishedAt = times.at(-1);
  const publisher = publishers.join(" and ");
  return {
    source: `${publisher} via FRED${publishedAt ? `, published ${publishedAt.slice(0, 10)}` : ""}`,
    publisher,
    ...(publishedAt ? { publishedAt } : {}),
  };
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
