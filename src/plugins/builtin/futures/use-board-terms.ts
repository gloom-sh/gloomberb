import { useEffect, useMemo, useState } from "react";
import { ApiRequestError } from "../../../api-client/errors";
import type { FuturesContractTermsPayload } from "../../../api-client/futures-curve";
import type { FuturesContract } from "../../../market-data/futures-board";
import { createTtlCache } from "../../../data/ttl-cache";
import { loadFuturesContractTerms } from "../../../market-data/futures-contract";
import { logFailure } from "../../../utils/log-failure";
import { coalescedBump } from "./coalesced-bump";
import { boardRead } from "./board-reads";

interface FuturesTermsState {
  /** The row's terms are still being asked for. */
  loading: boolean;
  /** Null while they are being asked for, when the server has none for the symbol, or when the read failed. */
  terms: FuturesContractTermsPayload | null;
}

export type FuturesTermsMap = ReadonlyMap<string, FuturesTermsState>;

/** The terms change with a roll, and a roll is decided once a day. */
const TERMS_TTL_MS = 30 * 60_000;
/**
 * A read that failed is asked again after this: one blip leaves a row without
 * its terms for a minute, not for the TTL, and a service that is down is asked
 * once a minute, not once a tick.
 */
const TERMS_RETRY_MS = 60_000;

/**
 * Null when the server has no terms for the symbol, which is an answer and is
 * kept like any other. A read that fails is not kept as one: it rejects, and
 * the cache holds the rejection for `TERMS_RETRY_MS`.
 */
const termsCache = createTtlCache<FuturesContractTermsPayload | null>({ ttlMs: TERMS_TTL_MS, rejectionMs: TERMS_RETRY_MS });

async function readTerms(symbol: string): Promise<FuturesContractTermsPayload | null> {
  try {
    return await loadFuturesContractTerms(symbol);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}

/** Whether the row has an answer; false when the read failed. */
function loadTerms(symbol: string): Promise<boolean> {
  return termsCache.load(symbol, () => readTerms(symbol))
    .then(() => true, logFailure("futures", "Read a futures row's contract terms failed", false));
}

/**
 * Each listed row's contract terms, as `quote` reads them: the unit its price
 * counts, the nearer month still trading once its continuous symbol has
 * rolled, and the day's most active month. Only the rows the board lists are asked for,
 * and a row whose terms have not arrived (or that has none) renders without them.
 */
export function useFuturesBoardTerms(contracts: readonly FuturesContract[], enabled: boolean): FuturesTermsMap {
  const symbolKey = contracts.map((contract) => contract.symbol).join(",");
  const [version, setVersion] = useState(0);
  // Bumped once the retry delay has passed after a failed read, to ask again.
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!enabled || !symbolKey) return;
    const queue = symbolKey.split(",").filter((symbol) => termsCache.peek(symbol) === undefined);
    if (queue.length === 0) return;
    let cancelled = false;
    let failed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const landed = coalescedBump(() => {
      if (!cancelled) setVersion((current) => current + 1);
    });
    // Twelve reads at a time, shared with the rows' histories (`boardRead`); a board that moved on skips its turn.
    void Promise.all(queue.map((symbol) => boardRead(async () => {
      if (cancelled) return;
      if (!await loadTerms(symbol)) failed = true;
      landed.bump();
    }))).then(() => {
      landed.flush();
      if (failed && !cancelled) retryTimer = setTimeout(() => setRetry((current) => current + 1), TERMS_RETRY_MS);
    });
    return () => {
      cancelled = true;
      landed.cancel();
      clearTimeout(retryTimer);
    };
  }, [enabled, symbolKey, retry]);

  return useMemo(() => {
    const result = new Map<string, FuturesTermsState>();
    if (!enabled) return result;
    for (const symbol of symbolKey ? symbolKey.split(",") : []) {
      // A row keeps the terms it had past their TTL until the next load lands, and
      // one whose read failed draws without them rather than waiting on a retry.
      const terms = termsCache.peek(symbol, { stale: true });
      result.set(symbol, { loading: terms === undefined && !termsCache.failed(symbol), terms: terms ?? null });
    }
    return result;
    // `version` re-reads the cache as loads land.
  }, [enabled, symbolKey, version]);
}

/** Forgets every cached row's terms (tests). */
export function resetFuturesBoardTerms(): void {
  termsCache.clear();
}
