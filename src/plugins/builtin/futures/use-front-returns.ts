import { useEffect, useMemo, useState } from "react";
import { createTtlCache } from "../../../data/ttl-cache";
import type { DataProvider } from "../../../types/data-provider";
import { isNoSourceAnswer } from "../../../sources/provider-errors";
import type { PricePoint } from "../../../types/financials";
import { logFailure } from "../../../utils/log-failure";
import { coalescedBump } from "./coalesced-bump";
import { boardRead } from "./board-reads";
import type { BoardQuoteMap } from "../shared/use-quote-board";
import type { FuturesContract } from "../../../market-data/futures-board";
import {
  frontContractCandidates,
  frontContractReturns,
  NO_FUTURES_RETURNS,
  pickFrontContract,
  type FuturesReturnValues,
} from "./returns";

interface FrontReturnsState {
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
/**
 * A read that failed is asked again after this: one blip leaves a row without
 * returns for a minute, not for the TTL, and a service that is down is asked
 * once a minute, not once a tick.
 */
const HISTORY_RETRY_MS = 60_000;

/**
 * Null when the source has no history for the contract (delisted, unknown),
 * which is an answer and is kept like any other. A read that fails is not kept
 * as one: it rejects, and the cache holds the rejection for `HISTORY_RETRY_MS`.
 */
const historyCache = createTtlCache<readonly PricePoint[] | null>({ ttlMs: HISTORY_TTL_MS, rejectionMs: HISTORY_RETRY_MS });

function readHistory(provider: DataProvider, symbol: string): Promise<readonly PricePoint[] | null> {
  return provider.getPriceHistory(symbol, "", "1Y").then((points) => points.length > 0 ? points : null, (error: unknown) => {
    if (isNoSourceAnswer(error)) return null;
    throw error;
  });
}

/** Whether the contract has an answer; false when the read failed. */
function loadHistory(provider: DataProvider, symbol: string): Promise<boolean> {
  return historyCache.load(symbol, () => readHistory(provider, symbol))
    .then(() => true, logFailure("futures", "Read a futures contract's history failed", false));
}

/**
 * 1W, 1M and YTD returns for each board row, measured on the contract its
 * quote prices rather than on the continuous alias. Histories load only for
 * `contracts`, the rows the board lists, and only while `enabled` (a returns
 * column is on screen and the pane can be seen).
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
  // Bumped once the retry delay has passed after a failed read, to ask again.
  const [retry, setRetry] = useState(0);
  // A board left open overnight reloads once the day turns.
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    if (!enabled || !provider) return;
    const queue = [...new Set([...candidates.values()].flat())].filter((symbol) => historyCache.peek(symbol) === undefined);
    if (queue.length === 0) return;
    let cancelled = false;
    let failed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const landed = coalescedBump(() => {
      if (!cancelled) setVersion((current) => current + 1);
    });
    // Twelve reads at a time, shared with the rows' terms (`boardRead`); a board that moved on skips its turn.
    void Promise.all(queue.map((symbol) => boardRead(async () => {
      if (cancelled) return;
      if (!await loadHistory(provider, symbol)) failed = true;
      landed.bump();
    }))).then(() => {
      landed.flush();
      if (failed && !cancelled) retryTimer = setTimeout(() => setRetry((current) => current + 1), HISTORY_RETRY_MS);
    });
    return () => {
      cancelled = true;
      landed.cancel();
      clearTimeout(retryTimer);
    };
  }, [candidates, enabled, provider, today, retry]);

  return useMemo(() => {
    const result = new Map<string, FrontReturnsState>();
    if (!enabled) return result;
    for (const contract of contracts) {
      const quote = quotes.get(contract.symbol)?.quote;
      const symbols = candidates.get(contract.symbol) ?? [];
      // A contract keeps the history it had past its TTL until the next load lands,
      // and one whose read failed counts as having none rather than waiting on a retry.
      const loaded = symbols.map((symbol) => ({ symbol, history: historyCache.peek(symbol, { stale: true }), failed: historyCache.failed(symbol) }));
      if (loaded.some((entry) => entry.history === undefined && !entry.failed)) {
        result.set(contract.symbol, { loading: true, values: NO_FUTURES_RETURNS });
        continue;
      }
      const available = loaded.flatMap((entry) => entry.history ? [{ symbol: entry.symbol, history: entry.history }] : []);
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

/** Forgets every cached contract's history (tests). */
export function resetFrontContractReturns(): void {
  historyCache.clear();
}
