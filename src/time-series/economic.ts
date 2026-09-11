import type { TimeSeriesPoint } from "./types";
import type { CloudFredSeriesInfoPayload } from "../api-client";

const ICE_CREDIT_SERIES = new Set([
  "BAMLC0A0CM", "BAMLC0A1CAAA", "BAMLC0A2CAA", "BAMLC0A3CA", "BAMLC0A4CBBB",
  "BAMLH0A0HYM2", "BAMLC0A0CMEY", "BAMLH0A0HYM2EY",
]);

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
): string | null {
  const id = seriesId.trim().toUpperCase();
  if (!ICE_CREDIT_SERIES.has(id) || info?.id.trim().toUpperCase() !== id) return null;
  const start = sourceDate(info.observationStart);
  const end = sourceDate(info.observationEnd);
  if (start === null || end === null || start > end) return null;
  if (visibleStart !== null && visibleStart >= start) return null;
  const retention = /Starting in April 2026, this series will only include 3 years of observations\./.test(info.notes)
    ? " FRED limits this ICE series to 3 years."
    : "";
  return `FRED coverage: ${info.observationStart} to ${info.observationEnd}. Earlier dates are unavailable from this source.${retention}`;
}

export interface FredObservationLike {
  date: string;
  value: string | number | null;
  realtime_start?: string;
  realtimeStart?: string;
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
    points.push({
      date: options.timestampMode !== "period-end" && availableAt ? availableAt : observedAt,
      observedAt,
      availableAt: availableAt ?? undefined,
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
