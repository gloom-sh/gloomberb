import { hasUsablePriceHistory } from "../../utils/price-history";
import type { PricePoint, Quote, TickerFinancials } from "../../types/financials";
import { hasFreshQuoteForCurrentSession, isQuoteStaleForCurrentSession } from "../quotes/freshness";
import type { InstrumentRef } from "../request-types";
import type { ProviderAttempt, ProviderReasonCode, QueryEntry } from "../result-types";
import { resolveEntryData } from "../selectors";

const EMPTY_MESSAGE = "No data available";
export const EXPECTED_EMPTY = /no data|not found|delisted|unavailable|unsupported/i;
export const SNAPSHOT_CACHE_TTL_MS = 5 * 60_000;
export const CHART_CACHE_TTL_MS = 10 * 60_000;
export const OPTIONS_CACHE_TTL_MS = 10 * 60_000;
export const SEC_FILINGS_CACHE_TTL_MS = 10 * 60_000;
export const SEC_CONTENT_CACHE_TTL_MS = 24 * 60 * 60_000;
export const ARTICLE_SUMMARY_CACHE_TTL_MS = 24 * 60 * 60_000;
export const FX_CACHE_TTL_MS = 30 * 60_000;

export function classifyError(error: unknown): { reasonCode: ProviderReasonCode; message: string } {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/timeout/i.test(message)) return { reasonCode: "TIMEOUT", message };
  if (/unsupported/i.test(message)) return { reasonCode: "UNSUPPORTED_RANGE", message };
  if (/mapping|symbol/i.test(message)) return { reasonCode: "BAD_MAPPING", message };
  if (/not found|no data|unavailable|delisted/i.test(message)) return { reasonCode: "NOT_FOUND", message };
  return { reasonCode: "UPSTREAM_ERROR", message };
}

export function hasFreshEntryData<T>(entry: QueryEntry<T>, ttlMs: number, now = Date.now()): boolean {
  if (resolveEntryData(entry) == null) return false;
  return entry.fetchedAt != null && now - entry.fetchedAt < ttlMs;
}

export function hasFreshReadyEntry<T>(entry: QueryEntry<T>, ttlMs: number, now = Date.now()): boolean {
  return entry.phase === "ready" && entry.fetchedAt != null && now - entry.fetchedAt < ttlMs;
}

export function hasFreshQuoteEntry(
  entry: QueryEntry<Quote>,
  instrument: InstrumentRef,
  ttlMs: number,
  now = Date.now(),
): boolean {
  const quote = resolveEntryData(entry);
  if (!quote || entry.fetchedAt == null || now - entry.fetchedAt >= ttlMs) return false;
  const quoteForFreshness = instrument.exchange && !quote.listingExchangeName && !quote.exchangeName
    ? { ...quote, listingExchangeName: instrument.exchange }
    : quote;
  return !isQuoteStaleForCurrentSession(quoteForFreshness, now);
}

export function createAttempt(
  providerId: string,
  startedAt: number,
  status: ProviderAttempt["status"],
  reasonCode?: ProviderReasonCode,
  message?: string,
): ProviderAttempt {
  const finishedAt = Date.now();
  return {
    providerId,
    status,
    startedAt,
    finishedAt,
    latencyMs: Math.max(0, finishedAt - startedAt),
    reasonCode,
    message,
  };
}

export function loadingEntry<T>(current: QueryEntry<T>): QueryEntry<T> {
  return {
    ...current,
    phase: current.lastGoodData || current.data ? "refreshing" : "loading",
    error: null,
    attempts: [],
  };
}

export function readyEntry<T>(
  current: QueryEntry<T>,
  data: T | null,
  source: string,
  attempts: ProviderAttempt[],
  options: { keepLastGoodOnEmpty?: boolean } = {},
): QueryEntry<T> {
  const resolvedData = data ?? (options.keepLastGoodOnEmpty ? current.lastGoodData : null);
  return {
    phase: "ready",
    data,
    lastGoodData: resolvedData,
    source,
    fetchedAt: Date.now(),
    staleAt: null,
    error: data == null ? { reasonCode: "NO_DATA", message: EMPTY_MESSAGE } : null,
    attempts,
  };
}

/** Keep all-missing observation dates while marking price coverage unavailable. */
export function readyChartEntry(
  current: QueryEntry<PricePoint[]>, data: PricePoint[] | null, source: string, attempts: ProviderAttempt[],
  history?: QueryEntry<PricePoint[]>["history"],
): QueryEntry<PricePoint[]> {
  const entry = readyEntry(current, data, source, attempts, { keepLastGoodOnEmpty: true });
  if (data == null && current.lastGoodData != null) {
    return { ...entry, source: current.source, fetchedAt: current.fetchedAt, staleAt: current.staleAt,
      history: current.history };
  }
  return { ...entry, ...(history ? { history } : {}),
    ...(data && !hasUsablePriceHistory(data) ? { error: { reasonCode: "NO_DATA", message: EMPTY_MESSAGE } } : {}) };
}

export function readyQuoteEntry(
  current: QueryEntry<Quote>,
  quote: Quote,
  source: string,
  attempts: ProviderAttempt[],
): QueryEntry<Quote> {
  if (isQuoteStaleForCurrentSession(quote)) {
    const keepFreshQuote = hasFreshQuoteForCurrentSession([current.data, current.lastGoodData]);
    return readyEntry(current, null, current.source ?? source, attempts, { keepLastGoodOnEmpty: keepFreshQuote });
  }
  return readyEntry(current, quote, source, attempts, { keepLastGoodOnEmpty: true });
}

export function errorEntry<T>(current: QueryEntry<T>, attempt: ProviderAttempt): QueryEntry<T> {
  return {
    ...current,
    phase: current.lastGoodData ? "ready" : "error",
    data: current.lastGoodData,
    error: {
      reasonCode: attempt.reasonCode ?? "UPSTREAM_ERROR",
      message: attempt.message ?? EMPTY_MESSAGE,
    },
    attempts: [attempt],
  };
}

export function hasCachedSnapshotData(financials: TickerFinancials): boolean {
  return !!financials.profile
    || Object.keys(financials.fundamentals ?? {}).length > 0
    || financials.annualStatements.length > 0
    || financials.quarterlyStatements.length > 0;
}
