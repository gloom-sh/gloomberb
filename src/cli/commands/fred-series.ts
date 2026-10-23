import { seriesMoves, type MoveHorizon } from "../../plugins/builtin/shared/move-rank";
import { seriesNotOnFred } from "../../sources/gloomberb-cloud/fred-series";
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
  // The 30-year mortgage rate less the 10-year Treasury, which Gloom Cloud computes on each PMMS date.
  "MORTGAGE30US10Y",
  ...ICE_SPREAD_SERIES.map((series) => series.seriesId),
]);

export function isSpreadSeries(seriesId: string): boolean {
  return SPREAD_SERIES.has(seriesId.toUpperCase());
}

/**
 * The unit a series' observations export in, for the `currency_or_unit`
 * column beside its bare `value`: `bp` for a spread (exported in basis
 * points), `pct` for a percent, otherwise FRED's own units, with "annual
 * rate" as the text header says it. Null when FRED's metadata did not come
 * back.
 */
export function fredUnit(seriesId: string, info: { units?: string | null; seasonalAdjustment?: string | null } | null | undefined): string | null {
  if (isSpreadSeries(seriesId)) return "bp";
  const units = info?.units?.trim();
  if (!units) return null;
  if (/^percent$/i.test(units)) return "pct";
  const annualRate = /annual rate/i.test(info?.seasonalAdjustment ?? "") && !/annual rate/i.test(units);
  return `${units}${annualRate ? ", annual rate" : ""}`;
}

/** How often a series observes, in FRED's word lower-cased: `Weekly, Ending Friday` is `weekly`. Null when FRED does not say. */
export function fredInterval(frequency: string | null | undefined): string | null {
  const word = frequency?.split(",")[0]?.trim().toLowerCase();
  return word || null;
}

/**
 * The observations from the series' first one on: Gloom Cloud answers a
 * `--start` before a series begins with a blank row for every day in between
 * (DEXSFUS from 1975 has five years of them before 1980-01-02). FRED's
 * `observationStart` says where it begins; without it the blank rows before
 * the first value go. Blank rows after it (a holiday's ".") stay.
 */
export function fredObservationsFromStart<T extends { date: string; value: number | null }>(
  observations: readonly T[],
  seriesStart: string | null | undefined,
): T[] {
  const first = seriesStart && /^\d{4}-\d{2}-\d{2}$/.test(seriesStart)
    ? seriesStart
    : observations.reduce<string | null>((earliest, observation) => (
      observation.value != null && Number.isFinite(observation.value) && (!earliest || observation.date < earliest) ? observation.date : earliest
    ), null);
  return first ? observations.filter((observation) => observation.date >= first) : [...observations];
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

/** Decimals past which a value's digits are float noise, not the series' precision. */
const MAX_FRED_DECIMALS = 6;

/**
 * The decimals a series is published to: the most any of its observations
 * carries, float noise aside (DGS10 to the hundredth, DEXSFUS to the
 * ten-thousandth). FRED drops trailing zeros, so 5.10 and 5.00 arrive as 5.1
 * and 5, which printed bare read as rounder figures than 5.09 beside them.
 */
export function fredDecimals(values: ReadonlyArray<number | null>): number {
  return values.reduce<number>((most, value) => {
    if (value == null || !Number.isFinite(value)) return most;
    const text = String(Number(value.toPrecision(10)));
    return Math.max(most, text.includes("e") ? MAX_FRED_DECIMALS : Math.min(MAX_FRED_DECIMALS, text.split(".")[1]?.length ?? 0));
  }, 0);
}

/** An observation as a `fred` table prints it, at the series' decimals (`fredDecimals`); exports keep the value as FRED gives it. */
export function fredValueCell(decimals: number): (value: unknown) => string {
  return (value) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(decimals) : "";
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
export function fredProvenance(
  observations: ReadonlyArray<{ date: string; publisher?: string; publishedAt?: string }>,
  seriesId?: string,
): FredProvenance | null {
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
    // A series FRED does not carry names whose publication it is read from instead (TurkStat via the CBRT).
    source: `${publisher} via ${(seriesId ? seriesNotOnFred(seriesId)?.via : null) ?? "FRED"}${publishedAt ? `, published ${publishedAt.slice(0, 10)}` : ""}`,
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

/**
 * `--change 1D|1W`, in any case: the horizon each row's change is over, or
 * null for anything else. 1D is from the previous observation, 1W from the
 * last one on or before the same day a week earlier, each within ten days, so
 * a holiday is skipped (shared/move-rank.ts).
 */
export function parseFredChange(value: string | undefined): MoveHorizon | null {
  const horizon = value?.trim().toUpperCase();
  return horizon === "1D" || horizon === "1W" ? horizon : null;
}

/**
 * Where a `--change` fetch starts: a week and the ten-day window before
 * `--start`, so the first row shown has the observation it is measured from.
 */
export function fredChangeFetchStart(startDate: string): string {
  return new Date(Date.parse(`${startDate}T00:00:00Z`) - 17 * 86_400_000).toISOString().slice(0, 10);
}

/** Why a series has no changes over a horizon: a 1D change of a weekly series is a week's, and longer intervals have neither. Null when it has them. */
export function fredChangeMismatch(seriesId: string, interval: string | null, horizon: MoveHorizon): string | null {
  if (interval == null || interval === "daily" || (interval === "weekly" && horizon === "1W")) return null;
  return interval === "weekly"
    ? `${seriesId} is weekly, so its changes are 1W.`
    : `${seriesId} is ${interval}: --change works on daily and weekly series.`;
}

/**
 * The change column's header, in the series' own unit: basis points for a
 * spread (its values print in bp), percentage points for a percent, else
 * FRED's units.
 */
export function fredChangeHeader(seriesId: string, horizon: MoveHorizon, info: { units?: string | null } | null | undefined): string {
  if (isSpreadSeries(seriesId)) return `${horizon} chg (bp)`;
  const units = info?.units?.trim();
  if (!units) return `${horizon} chg`;
  return `${horizon} chg (${/^percent\b/i.test(units) ? "pp" : units})`;
}

/**
 * A change as its column prints it: signed, a spread's basis points to a
 * tenth, anything else at the series' decimals (`fredDecimals`), as its values.
 */
export function fredChangeCell(spread: boolean, decimals: number): (value: unknown) => string {
  const format = spread ? basisPointsCell : fredValueCell(decimals);
  return (value) => {
    const text = format(value);
    return typeof value === "number" && Number(text) > 0 ? `+${text}` : text.replace(/^-(?=0(\.0+)?$)/, "");
  };
}

/**
 * Each observation's change over the horizon, in the unit it exports in, and
 * the date it is measured from, by observation date. A holiday's blank and an
 * observation with nothing within ten days before have none.
 */
export function fredChanges(
  seriesId: string,
  observations: ReadonlyArray<{ date: string; value: number | null }>,
  horizon: MoveHorizon,
): Map<string, { change: number | null; changeFrom: string }> {
  const ascending = [...observations].sort((a, b) => a.date.localeCompare(b.date));
  return new Map(seriesMoves(ascending, horizon).map((move) => [
    move.date, { change: fredExportValue(seriesId, move.change), changeFrom: move.from },
  ]));
}

/** What `fred` says when nothing falls on or after `--start`: where the series actually ends. */
export function fredEmptyMessage(startDate: string, latest: { date: string; value: number | null } | null): string {
  return latest
    ? `Latest observation: ${latest.date}${latest.value == null ? "" : ` (${latest.value})`}. Nothing on or after ${startDate}.`
    : "No results.";
}

/** What an export of nothing on or after `--start` says to try instead: a start that reaches the latest observation. */
export function fredEmptyAdvice(seriesId: string, latest: { date: string } | null): string {
  return latest
    ? `Latest observation: ${latest.date}. Try: gloomberb fred ${seriesId} --start ${latest.date.slice(0, 4)}`
    : `No observations came back for ${seriesId}. Try an earlier --start, or gloomberb fred --list for the series served.`;
}

/** A series as `fred --list` shows it. */
export interface FredListRow {
  id: string;
  title: string;
  group: string;
}

/** Lower case without accents, so `turk` and `turkiye` find Türkiye. */
function foldAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** How well a word of the filter matches a series, best first: its id or group name, a word of its group or title, the start of its id, then any text. */
function matchTier(term: string, row: FredListRow, words: readonly string[]): number {
  if (row.id.toLowerCase() === term || row.group.toLowerCase() === term) return 0;
  if (words.some((word) => word.startsWith(term))) return 1;
  if (row.id.toLowerCase().startsWith(term)) return 2;
  return 3;
}

/**
 * The series that carry every word of the filter in their id, title or group,
 * the ones it names first: a group or a word of the title ahead of the id that
 * only has it inside (`fx` is the FX group, not FDEFX, whose id spells it).
 * Catalog order breaks ties; an empty filter keeps the catalog as it is.
 */
export function filterFredSeries(rows: readonly FredListRow[], filter: string): FredListRow[] {
  const terms = foldAccents(filter).split(/\s+/).filter(Boolean);
  const ranked = rows.flatMap((row, index) => {
    const text = foldAccents(`${row.id} ${row.title} ${row.group}`);
    if (!terms.every((term) => text.includes(term))) return [];
    const words = foldAccents(`${row.title} ${row.group}`).split(/[^a-z0-9]+/).filter(Boolean);
    const tiers = terms.map((term) => matchTier(term, row, words));
    return [{ row, index, worst: Math.max(0, ...tiers), total: tiers.reduce((sum, tier) => sum + tier, 0) }];
  });
  return ranked.sort((a, b) => a.worst - b.worst || a.total - b.total || a.index - b.index).map((entry) => entry.row);
}
