import { useEffect, useMemo, useState } from "react";
import type { FuturesContractTermsPayload } from "../../../api-client/futures-curve";
import type { FuturesContract } from "../../../market-data/futures-board";
import { createTtlCache } from "../../../data/ttl-cache";
import { loadFuturesContractTerms } from "../../../market-data/futures-contract";
import { logFailure } from "../../../utils/log-failure";

interface FuturesTermsState {
  /** The row's terms are still being asked for. */
  loading: boolean;
  /** Null when the server has no terms for the symbol, or could not answer. */
  terms: FuturesContractTermsPayload | null;
}

export type FuturesTermsMap = ReadonlyMap<string, FuturesTermsState>;

/** The terms change with a roll, and a roll is decided once a day. */
const TERMS_TTL_MS = 30 * 60_000;
/** Forty-odd rows open at once; a few requests at a time keep the board's quotes first. */
const TERMS_CONCURRENCY = 4;

/** Null when the server has no terms for the symbol, or could not answer; kept the same as any answer. */
const termsCache = createTtlCache<FuturesContractTermsPayload | null>({ ttlMs: TERMS_TTL_MS });

function loadTerms(symbol: string): Promise<unknown> {
  return termsCache.load(symbol, () => loadFuturesContractTerms(symbol)
    .catch(logFailure("futures", "Read a futures row's contract terms failed", null)));
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

  useEffect(() => {
    if (!enabled || !symbolKey) return;
    const queue = symbolKey.split(",").filter((symbol) => termsCache.peek(symbol) === undefined);
    if (queue.length === 0) return;
    let cancelled = false;
    const worker = async () => {
      for (let symbol = queue.shift(); symbol; symbol = queue.shift()) {
        await loadTerms(symbol);
        if (!cancelled) setVersion((current) => current + 1);
      }
    };
    void Promise.all(Array.from({ length: Math.min(TERMS_CONCURRENCY, queue.length) }, worker));
    return () => {
      cancelled = true;
      queue.length = 0;
    };
  }, [enabled, symbolKey]);

  return useMemo(() => {
    const result = new Map<string, FuturesTermsState>();
    if (!enabled) return result;
    for (const symbol of symbolKey ? symbolKey.split(",") : []) {
      // A row keeps the terms it had past their TTL until the next load lands.
      const terms = termsCache.peek(symbol, { stale: true });
      result.set(symbol, { loading: terms === undefined, terms: terms ?? null });
    }
    return result;
    // `version` re-reads the cache as loads land.
  }, [enabled, symbolKey, version]);
}

/** Forgets every cached row's terms (tests). */
export function resetFuturesBoardTerms(): void {
  termsCache.clear();
}
