import { parseReportTime } from "../../utils/utc-time";
import { seriesNotOnFred, type FredSeriesData } from "./fred-series";

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

/** Who a series FRED does not carry comes from, for a source line whose rows do not name it: `TurkStat via the CBRT`. */
export function notOnFredSource(seriesId: string): string | null {
  const elsewhere = seriesNotOnFred(seriesId);
  return elsewhere ? `${elsewhere.publisher} via ${elsewhere.via}` : null;
}

/**
 * Who publishes a served series and when its newest observation was
 * published, as `fred` cites it and every chart, catalog row and export of
 * the series must too: its newest value's own publisher when Gloom Cloud
 * carried one FRED does not list yet (`TurkStat via the CBRT, published
 * 2026-11-03`), else FRED, naming the publisher FRED's metadata gives and
 * when FRED last updated the series.
 */
export function fredSeriesAttribution(
  seriesId: string,
  data: Pick<FredSeriesData, "observations" | "info">,
): FredProvenance {
  const newestDate = data.observations.reduce<string | null>((newest, observation) => (
    observation.value != null && (!newest || observation.date > newest) ? observation.date : newest
  ), null);
  const ahead = fredProvenance(data.observations.filter((observation) => observation.date === newestDate), seriesId);
  if (ahead) return ahead;
  const publisher = data.info?.source?.trim();
  const publishedAt = fredPublicationTime(data.info, newestDate);
  return {
    source: notOnFredSource(seriesId) ?? "FRED",
    ...(publisher ? { publisher } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}
