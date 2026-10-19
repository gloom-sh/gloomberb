import { apiClient } from "../../api-client";
import { ApiRequestError } from "../../api-client/errors";
import type { InstrumentSearchResult } from "../../types/instrument";
import type { TickerChanges } from "../../types/ticker-changes";
import { logFailure } from "../../utils/log-failure";
import { chunked, mapWithConcurrency } from "../../utils/concurrency";

/** Symbols asked for in one batched ticker change request; the service reads up to 500. */
const TICKER_CHANGES_BATCH_SIZE = 500;
/** Queries in one batched search; the service runs up to 100, as many as a signed-out quote batch reads. */
const SEARCH_BATCH_SIZE = 100;
/** Batch requests of one lookup in flight at once, so a long list does not ask the service for everything at the same moment. */
const BATCHES_IN_FLIGHT = 3;

type BatchRoute = "ticker-changes" | "search";

/** Batch routes the service answered 404 for: an older service, asked one symbol at a time from then on. */
const unsupported = new Set<BatchRoute>();

/** A service without the batch route answers 404 (or 405, the path served for another method). */
const isMissingRoute = (error: unknown) => error instanceof ApiRequestError && (error.status === 404 || error.status === 405);

/**
 * The answers to `keys`, a request per `size` of them, a few in flight at a
 * time. A request that fails leaves its keys out, to be asked one at a time; a
 * service without the route answers null, and is not asked for it again.
 */
async function inBatches<T>(
  route: BatchRoute,
  keys: readonly string[],
  size: number,
  load: (chunk: string[]) => Promise<Map<string, T>>,
): Promise<Map<string, T> | null> {
  if (unsupported.has(route)) return null;
  const answers = new Map<string, T>();
  await mapWithConcurrency(chunked([...new Set(keys)], size), BATCHES_IN_FLIGHT, async (chunk) => {
    // The first chunk an older service refused says the rest would be refused too.
    if (unsupported.has(route)) return;
    try {
      for (const [key, value] of await load(chunk)) answers.set(key, value);
    } catch (error) {
      if (isMissingRoute(error)) unsupported.add(route);
      else logFailure("sources.gloomberb-cloud.batched-lookups", `Batched ${route} request failed`)(error);
    }
  });
  return unsupported.has(route) ? null : answers;
}

/** Each symbol's ticker changes, by symbol as asked (null: none on record); null from a service that cannot batch them. */
export function cloudTickerChangesBatch(
  symbols: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<Map<string, TickerChanges | null> | null> {
  return inBatches("ticker-changes", symbols, TICKER_CHANGES_BATCH_SIZE, (chunk) => apiClient.getCloudTickerChangesBatch(chunk, options));
}

/**
 * Each query's listings as the service's search answers it, by query as asked;
 * null from a service that cannot batch searches. Perpetual markets, which
 * `search` asks the board for beside the listings, are not included: the
 * symbols a list is looked up by never name one.
 */
export function cloudSearchBatch(
  queries: readonly string[],
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<Map<string, InstrumentSearchResult[]> | null> {
  return inBatches("search", queries, SEARCH_BATCH_SIZE, (chunk) => apiClient.searchInstrumentsBatch(chunk, options.limit ?? 10, options));
}

/** Forgets which batch routes the service lacked. */
export function resetCloudBatchSupport(): void {
  unsupported.clear();
}
