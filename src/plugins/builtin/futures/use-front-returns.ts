import { useEffect, useMemo, useState } from "react";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import type { BoardQuoteMap } from "../shared/use-quote-board";
import type { FuturesContract } from "./contracts";
import {
  frontContractCandidates,
  frontContractReturns,
  NO_FUTURES_RETURNS,
  pickFrontContract,
  type FuturesReturnValues,
} from "./returns";

export interface FrontReturnsState {
  /** A candidate contract's history is still loading. */
  loading: boolean;
  values: FuturesReturnValues;
}

export type FrontReturnsMap = ReadonlyMap<string, FrontReturnsState>;

/**
 * The baselines are earlier days' closes, so a contract's history is reused
 * for half an hour; the live quote moves the returns in between.
 */
const HISTORY_TTL_MS = 30 * 60_000;
/** Forty-odd contracts open at once; a few requests at a time keep the board's quotes first. */
const HISTORY_CONCURRENCY = 4;

interface CachedHistory {
  at: number;
  /** Null when the contract has no history to read (delisted, unknown). */
  points: readonly PricePoint[] | null;
}

const historyCache = new Map<string, CachedHistory>();
const inFlight = new Map<string, Promise<void>>();

function freshHistory(symbol: string, now: number): CachedHistory | undefined {
  const cached = historyCache.get(symbol);
  return cached && now - cached.at < HISTORY_TTL_MS ? cached : undefined;
}

function loadHistory(provider: DataProvider, symbol: string): Promise<void> {
  const pending = inFlight.get(symbol);
  if (pending) return pending;
  const request = provider.getPriceHistory(symbol, "", "1Y")
    .then((points) => { historyCache.set(symbol, { at: Date.now(), points: points.length > 0 ? points : null }); })
    .catch(() => { historyCache.set(symbol, { at: Date.now(), points: null }); })
    .finally(() => { inFlight.delete(symbol); });
  inFlight.set(symbol, request);
  return request;
}

/**
 * 1W, 1M and YTD returns for each board row, measured on the contract its
 * quote prices rather than on the continuous alias. Histories load only while
 * `enabled` (a returns column is on screen and the pane can be seen).
 */
export function useFrontContractReturns(
  contracts: readonly FuturesContract[],
  quotes: BoardQuoteMap,
  provider: DataProvider | null | undefined,
  enabled: boolean,
): FrontReturnsMap {
  // Candidates change on a roll, not on a tick: the key keeps the loader still.
  const candidateKey = contracts
    .map((contract) => `${contract.symbol}\u001f${frontContractCandidates(contract, quotes.get(contract.symbol)?.quote).join(",")}`)
    .join("\u001e");
  const candidates = useMemo(() => new Map(candidateKey.split("\u001e").map((entry) => {
    const [symbol = "", list = ""] = entry.split("\u001f");
    return [symbol, list ? list.split(",") : []] as const;
  })), [candidateKey]);
  const [version, setVersion] = useState(0);
  // A board left open overnight reloads once the day turns.
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    if (!enabled || !provider) return;
    const now = Date.now();
    const queue = [...new Set([...candidates.values()].flat())].filter((symbol) => !freshHistory(symbol, now));
    if (queue.length === 0) return;
    let cancelled = false;
    const worker = async () => {
      for (let symbol = queue.shift(); symbol; symbol = queue.shift()) {
        await loadHistory(provider, symbol);
        if (!cancelled) setVersion((current) => current + 1);
      }
    };
    void Promise.all(Array.from({ length: Math.min(HISTORY_CONCURRENCY, queue.length) }, worker));
    return () => {
      cancelled = true;
      queue.length = 0;
    };
  }, [candidates, enabled, provider, today]);

  return useMemo(() => {
    const result = new Map<string, FrontReturnsState>();
    if (!enabled) return result;
    for (const contract of contracts) {
      const quote = quotes.get(contract.symbol)?.quote;
      const symbols = candidates.get(contract.symbol) ?? [];
      const loaded = symbols.map((symbol) => ({ symbol, cached: historyCache.get(symbol) }));
      if (loaded.some((entry) => !entry.cached)) {
        result.set(contract.symbol, { loading: true, values: NO_FUTURES_RETURNS });
        continue;
      }
      const available = loaded.flatMap((entry) => entry.cached?.points ? [{ symbol: entry.symbol, history: entry.cached.points }] : []);
      const front = pickFrontContract(available, quote?.price);
      const history = available.find((entry) => entry.symbol === front)?.history;
      result.set(contract.symbol, {
        loading: false,
        values: history ? frontContractReturns(history, quote?.price, quote?.lastUpdated) : NO_FUTURES_RETURNS,
      });
    }
    return result;
    // `version` re-reads the history cache as loads land.
  }, [candidates, contracts, enabled, quotes, version]);
}
