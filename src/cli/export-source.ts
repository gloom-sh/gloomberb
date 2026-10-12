/**
 * Where exported data comes from, said the same way by every command that
 * writes CSV or JSON, so an export can go in an audit file as it is: CSV ends
 * with `#` lines and JSON carries a `source` object with the same fields.
 */
import { formatFreshnessLine, type ReportFreshness } from "./pane-functions/freshness";

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
}

export function exportSource(freshness: ReportFreshness): ExportSource {
  return {
    name: freshness.source,
    publisher: freshness.publisher ?? null,
    observationDate: freshness.asOf,
    ...(freshness.oldestObservation ? { oldestObservationDate: freshness.oldestObservation } : {}),
    publicationTime: freshness.publishedAt ?? null,
    retrievalTime: freshness.retrievedAt,
  };
}

/**
 * The lines an export ends with: the source line the text report ends with,
 * then the publisher, observation date (the newest; the oldest follows when
 * the data cites it), publication time and retrieval time, each `not
 * published` when the data does not say.
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
  ];
}
