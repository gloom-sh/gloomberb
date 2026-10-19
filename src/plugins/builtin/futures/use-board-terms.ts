import { useEffect, useMemo, useState } from "react";
import type { FuturesContractTermsPayload } from "../../../api-client/futures-curve";
import type { FuturesContract } from "../../../market-data/futures-board";
import { loadFuturesContractTerms } from "../../../market-data/futures-contract";

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

interface CachedTerms {
  at: number;
  /** Null when the server has no terms for the symbol, or could not answer. */
  terms: FuturesContractTermsPayload | null;
}

const termsCache = new Map<string, CachedTerms>();
const inFlight = new Map<string, Promise<void>>();

function fresh(symbol: string, now: number): CachedTerms | undefined {
  const cached = termsCache.get(symbol);
  return cached && now - cached.at < TERMS_TTL_MS ? cached : undefined;
}

function loadTerms(symbol: string): Promise<void> {
  const pending = inFlight.get(symbol);
  if (pending) return pending;
  const request = loadFuturesContractTerms(symbol)
    .then((terms) => { termsCache.set(symbol, { at: Date.now(), terms }); })
    .catch(() => { termsCache.set(symbol, { at: Date.now(), terms: null }); })
    .finally(() => { inFlight.delete(symbol); });
  inFlight.set(symbol, request);
  return request;
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
    const now = Date.now();
    const queue = symbolKey.split(",").filter((symbol) => !fresh(symbol, now));
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
      const cached = termsCache.get(symbol);
      result.set(symbol, { loading: !cached, terms: cached?.terms ?? null });
    }
    return result;
    // `version` re-reads the cache as loads land.
  }, [enabled, symbolKey, version]);
}

/** Forgets every cached row's terms (tests). */
export function resetFuturesBoardTerms(): void {
  termsCache.clear();
}
