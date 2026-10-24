import type { TimeSeriesPoint } from "./types";
import type { CloudFredSeriesInfoPayload, CloudFredSeriesPayload } from "../api-client";
import { ICE_CREDIT_SERIES_IDS } from "./ice-credit";

function sourceDate(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

/** Source coverage is separate from query limits and calculation buffers. */
export function fredCreditCoverageNotice(
  seriesId: string,
  info: CloudFredSeriesInfoPayload | null,
  visibleStart: number | null,
  observations: CloudFredSeriesPayload["observations"] = [],
): string | null {
  const id = seriesId.trim().toUpperCase();
  if (!ICE_CREDIT_SERIES_IDS.has(id) || info?.id.trim().toUpperCase() !== id) return null;
  const start = sourceDate(info.observationStart);
  const end = sourceDate(info.observationEnd);
  if (start === null || end === null || start > end) return null;
  if (visibleStart !== null && visibleStart >= start) return null;
  const retention = /Starting in April 2026, this series will only include 3 years of observations\./.test(info.notes)
    ? " FRED limits this ICE series to 3 years."
    : "";
  // Series metadata and observations can refresh independently. An observation
  // outside the declared span disproves that span; the query's first/last row
  // cannot establish replacement source coverage either.
  const contradictory = observations.some((observation) => {
    const date = sourceDate(observation.date);
    return date !== null && observation.value !== null && Number.isFinite(observation.value)
      && (date < start || date > end);
  });
  if (contradictory) {
    return `FRED coverage metadata does not match the returned observations; exact coverage dates are unavailable.${retention}`;
  }
  return `FRED coverage: ${info.observationStart} to ${info.observationEnd}. Earlier dates are unavailable from this source.${retention}`;
}

export interface FredObservationLike {
  date: string;
  value: string | number | null;
  realtime_start?: string;
  realtimeStart?: string;
  /** The day the value was released, which Gloom Cloud sets on a series' newest observation. */
  releasedOn?: string;
}

export interface FredExtractionOptions {
  timestampMode?: "available-at" | "period-end";
  providerId?: string;
}

function parsedDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Converts FRED observations or vintage observations without coupling to a network client. */
export function extractFredSeries(
  observations: readonly FredObservationLike[],
  options: FredExtractionOptions = {},
): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  for (const observation of observations) {
    const observedAt = parsedDate(observation.date);
    const numericValue = typeof observation.value === "number"
      ? observation.value
      : typeof observation.value === "string" && observation.value.trim() !== ""
        ? Number(observation.value)
        : Number.NaN;
    if (!observedAt || !Number.isFinite(numericValue)) continue;
    const availableAt = parsedDate(observation.realtime_start ?? observation.realtimeStart);
    // One observation's release is not a vintage: the series stays drawn by period, and the line says when it was released.
    const releasedOn = parsedDate(observation.releasedOn)?.toISOString().slice(0, 10);
    points.push({
      date: options.timestampMode !== "period-end" && availableAt ? availableAt : observedAt,
      observedAt,
      availableAt: availableAt ?? undefined,
      ...(releasedOn ? { releasedOn } : {}),
      value: numericValue,
      periodLabel: observation.date,
      provenance: {
        providerId: options.providerId ?? "fred",
        quality: "reported",
      },
    });
  }
  return points.sort((left, right) => left.date.getTime() - right.date.getTime());
}
