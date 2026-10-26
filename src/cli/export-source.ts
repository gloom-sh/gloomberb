/**
 * Where exported data comes from, said the same way by every command that
 * writes CSV or JSON, so an export can go in an audit file as it is: CSV ends
 * with `#` lines and JSON carries a `source` object with the same fields.
 * CSV and NDJSON rows also end with five fixed columns naming what each row
 * is (`EXPORT_IDENTITY_COLUMNS`), less any the table already has by name; a
 * dated export adds `period`, `released` and `retrieved` after them.
 */
import { formatFreshnessLine, type ReportFreshness } from "./pane-functions/freshness";
import { parseReportTime } from "../utils/utc-time";

/** What CSV writes for a field the data does not state. JSON writes null. */
const NOT_PUBLISHED = "not published";

/** JSON's `source`: one field per footer line after the first. */
export interface ExportSource {
  /** Who the data is cited to: `FRED`, `DTCC`, `Gloom Cloud`. */
  name: string;
  /** Who published the figures, when the data names them. */
  publisher: string | null;
  /** The newest observation: an ISO date, or an ISO instant in UTC. */
  observationDate: string | null;
  /**
   * The oldest observation, for data that cites it (`citeOldest`) when its rows
   * are dated apart: a portfolio's Friday close beside a later print.
   */
  oldestObservationDate?: string;
  /** When the publisher released the data, when the data states it. */
  publicationTime: string | null;
  /** When the data was retrieved for this export: an ISO instant in UTC. */
  retrievalTime: string;
  /** Refreshing the data failed and a copy saved earlier answered: when it was saved, an ISO instant in UTC. */
  savedTime?: string;
}

export function exportSource(freshness: ReportFreshness): ExportSource {
  return {
    name: freshness.source,
    publisher: freshness.publisher ?? null,
    // A figure as of its release is still dated by the period it covers; the release is its publication time.
    observationDate: freshness.referencePeriod ?? freshness.asOf,
    ...(freshness.oldestObservation ? { oldestObservationDate: freshness.oldestObservation } : {}),
    publicationTime: freshness.publishedAt ?? (freshness.referencePeriod ? freshness.asOf : null),
    retrievalTime: freshness.retrievedAt,
    ...(freshness.savedAt ? { savedTime: freshness.savedAt } : {}),
  };
}

/**
 * The columns every row of an export that ends with these lines carries,
 * last and in this order, so a row says what it is after `head`, a filter or
 * concatenating files: what was asked for, the unit of its values, the bar
 * interval or observation frequency served, and the source and as-of date the
 * closing lines give.
 */
export const EXPORT_IDENTITY_COLUMNS = ["symbol_or_series", "currency_or_unit", "interval", "source", "as_of"] as const;

/**
 * The columns a dated export (`econ`, `fred`, `fn ECST`) ends with after the
 * five: the period a figure covers, when it was released, and when this export
 * retrieved it. `as_of` is then the release, and these three say the rest, so a
 * row never has to be read against the closing lines to be dated.
 */
export const EXPORT_DATING_COLUMNS = ["period", "released", "retrieved"] as const;

/** What a command knows about the rows it exports; source and as-of come from its freshness. */
export interface ExportIdentity {
  /** The symbol or series ID asked for: `USDZAR=X`, `SAN:EPA`, `DEXSFUS`. */
  symbolOrSeries?: string | null;
  /** The currency or unit the values are in: `ZAR`, `USD`, `bp`, `pct`, `index points`. */
  currencyOrUnit?: string | null;
  /** The bar interval or observation frequency actually returned: `1d`, `1mo`, `daily`, `monthly`. */
  interval?: string | null;
  /**
   * When this row was observed, where a table's rows are dated apart (each
   * ticker's price in a ranking): an ISO date or instant. Null leaves `as_of`
   * blank; absent, it is the closing lines' observation date.
   */
  asOf?: string | null;
  /** In a dated export: the period the figure covers, as its publisher names it (`Sep 2026`, `2026-09-01`). */
  period?: string | null;
  /** In a dated export: when the figure was released, an ISO date or instant; null when the data does not say. */
  released?: string | null;
}

/** A row's own as-of in the closing lines' form: a date stays a date, an instant is ISO in UTC. */
function rowAsOf(value: string | null): string {
  const time = parseReportTime(value);
  if (!time) return "";
  return time.dateOnly ? new Date(time.time).toISOString().slice(0, 10) : new Date(time.time).toISOString();
}

/**
 * The five cells of `EXPORT_IDENTITY_COLUMNS` for a row: blank where the
 * command cannot say, and `as_of` the row's own observation time when it has
 * one, else the observation date of the closing lines, blank when they read
 * `not published`.
 */
export function exportIdentityCells(freshness: ReportFreshness, identity: ExportIdentity = {}): string[] {
  const source = exportSource(freshness);
  return [
    identity.symbolOrSeries?.trim() ?? "",
    identity.currencyOrUnit?.trim() ?? "",
    identity.interval?.trim() ?? "",
    source.name,
    identity.asOf !== undefined ? rowAsOf(identity.asOf) : source.observationDate ?? "",
  ];
}

/**
 * The cells of `EXPORT_DATING_COLUMNS` for a row: its period and release as
 * the data states them, blank when it does not, and the time this export
 * retrieved the data.
 */
export function exportDatingCells(freshness: ReportFreshness, identity: ExportIdentity = {}): string[] {
  return [identity.period?.trim() ?? "", rowAsOf(identity.released ?? null), exportSource(freshness).retrievalTime];
}

/** The three dating fields of an NDJSON row, null where blank. */
export function exportDatingFields(freshness: ReportFreshness, identity: ExportIdentity = {}): Record<string, string | null> {
  const cells = exportDatingCells(freshness, identity);
  return Object.fromEntries(EXPORT_DATING_COLUMNS.map((column, index) => [column, cells[index] || null]));
}

/** The same five as fields of an NDJSON row, null where blank. */
export function exportIdentityFields(freshness: ReportFreshness, identity: ExportIdentity = {}): Record<string, string | null> {
  const cells = exportIdentityCells(freshness, identity);
  return Object.fromEntries(EXPORT_IDENTITY_COLUMNS.map((column, index) => [column, cells[index] || null]));
}

/**
 * The lines an export ends with: the source line the text report ends with,
 * then the publisher, observation date (the newest; the oldest follows when
 * the data cites it), publication time and retrieval time, each `not
 * published` when the data does not say, and when the copy was saved when a
 * saved copy answered because refreshing it failed.
 */
export function exportSourceLines(freshness: ReportFreshness): string[] {
  const source = exportSource(freshness);
  const stated = (value: string | null) => value ?? NOT_PUBLISHED;
  return [
    formatFreshnessLine(freshness),
    `Publisher: ${stated(source.publisher)}`,
    `Observation date: ${stated(source.observationDate)}`,
    ...(source.oldestObservationDate ? [`Oldest observation: ${source.oldestObservationDate}`] : []),
    `Publication time: ${stated(source.publicationTime)}`,
    `Retrieval time: ${source.retrievalTime}`,
    ...(source.savedTime ? [`Saved time: ${source.savedTime}`] : []),
  ];
}
