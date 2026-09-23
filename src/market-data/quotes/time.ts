import type { Quote } from "../../types/financials";

function clampQuoteTimestamp(lastUpdated: number | undefined, now = Date.now()): number | null {
  if (typeof lastUpdated !== "number" || !Number.isFinite(lastUpdated) || lastUpdated <= 0) {
    return null;
  }
  return Math.min(lastUpdated, now);
}

export interface QuoteAgeFormatOptions {
  /** Whole seconds only, for a surface whose clock ticks once a second:
   * milliseconds from that clock would be up to a second out. */
  seconds?: boolean;
}

export function formatQuoteAge(lastUpdated: number | undefined, now = Date.now(), options: QuoteAgeFormatOptions = {}): string {
  const clamped = clampQuoteTimestamp(lastUpdated, now);
  if (clamped == null) return "—";

  // A receipt or source time ahead of the clock is fresh, never negative.
  const ageMs = Math.max(0, now - clamped);
  if (ageMs < 1000) return options.seconds ? "0s" : `${Math.floor(ageMs)}ms`;

  const ageSeconds = ageMs / 1000;
  if (ageSeconds < 60) return `${Math.floor(ageSeconds)}s`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m`;
  if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h`;
  return `${Math.floor(ageSeconds / 86400)}d`;
}

export function resolveQuoteAgeTimestamp(
  quote: Pick<Quote, "lastUpdated" | "receivedAt"> | null | undefined,
  now = Date.now(),
): number | null {
  if (!quote) return null;
  const receivedAt = clampQuoteTimestamp(quote.receivedAt, now);
  return receivedAt ?? clampQuoteTimestamp(quote.lastUpdated, now);
}

export function formatQuoteAgeWithSource(
  quote: Pick<Quote, "lastUpdated" | "receivedAt" | "dataSource"> | null | undefined,
  now = Date.now(),
  options: QuoteAgeFormatOptions = {},
): string {
  if (!quote) return "—";

  const timestamp = resolveQuoteAgeTimestamp(quote, now);
  const age = timestamp == null ? "—" : formatQuoteAge(timestamp, now, options);
  if (age === "—") return age;

  const prefix = quote.dataSource === "delayed" ? "◷" : "";
  return prefix ? `${prefix}${age}` : age;
}

export function getMostRecentQuoteUpdate(
  quotes: Iterable<Pick<Quote, "lastUpdated" | "receivedAt"> | null | undefined>,
  now = Date.now(),
): number | null {
  let latest: number | null = null;
  for (const quote of quotes) {
    const timestamp = resolveQuoteAgeTimestamp(quote, now);
    if (timestamp != null && (latest == null || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}
