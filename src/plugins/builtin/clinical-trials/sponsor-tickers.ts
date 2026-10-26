import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import {
  ORGANIZATION_TICKERS_BATCH_LIMIT,
  validateOrganizationTickers,
  type OrganizationTicker,
} from "../../../api-client/organization-tickers";
import { createTtlCache, type TtlCache } from "../../../data/ttl-cache";

/**
 * A lead sponsor's ticker, only ever as Gloom Cloud resolved it. `none` is an
 * answer (no listed company, or a name that fits several); `failed` means it
 * was not looked up at all and says nothing about the sponsor.
 */
export type SponsorTicker =
  | { kind: "pending" }
  | { kind: "listed"; ticker: string; exchange: string | null; entityName: string | null }
  | { kind: "none"; entityName: string | null; ambiguous: boolean }
  | { kind: "failed"; reason: string };

/** A ticker only when one company and its listing were found; an ambiguous name never gets one. */
export function sponsorTickerFrom(result: OrganizationTicker): SponsorTicker {
  if (result.ambiguous) return { kind: "none", entityName: null, ambiguous: true };
  if (result.ticker) return { kind: "listed", ticker: result.ticker, exchange: result.exchange, entityName: result.entityName };
  return { kind: "none", entityName: result.entityName, ambiguous: false };
}

type Lookup = (names: string[], signal?: AbortSignal) => Promise<OrganizationTicker[]>;

const CACHE_TTL_MS = 6 * 60 * 60_000;

function failureReason(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401 || error.status === 403) return "sign in to look up tickers";
    if (error.status === 429) return "too many lookups, try again shortly";
    if (error.status === 404) return "ticker lookup is not available yet";
  }
  return "could not reach Gloom Cloud";
}

const sponsorKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Answers per sponsor name, shared by every trial pane. Only answers are kept;
 * a failed lookup is remembered just until `retryFailed`, so a sponsor is
 * never stored as having no ticker because the lookup did not happen.
 */
export class SponsorTickerStore {
  private readonly answers: TtlCache<SponsorTicker>;
  private readonly failures = new Map<string, string>();
  private readonly inFlight = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly lookup: Lookup, now: () => number = Date.now) {
    this.answers = createTtlCache<SponsorTicker>({ ttlMs: CACHE_TTL_MS, now });
  }

  get(name: string): SponsorTicker {
    const key = sponsorKey(name);
    const answer = this.answers.peek(key);
    if (answer) return answer;
    const reason = this.failures.get(key);
    return reason ? { kind: "failed", reason } : { kind: "pending" };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Asks for the names with no answer yet, a page at a time. */
  async load(names: readonly string[], signal?: AbortSignal): Promise<void> {
    const missing = new Map<string, string>();
    for (const name of names) {
      const trimmed = name.trim();
      const key = sponsorKey(trimmed);
      if (!trimmed || missing.has(key) || this.inFlight.has(key) || this.failures.has(key)) continue;
      if (this.get(trimmed).kind !== "pending") continue;
      missing.set(key, trimmed);
    }
    const asked = [...missing.values()];
    const batches: string[][] = [];
    for (let start = 0; start < asked.length; start += ORGANIZATION_TICKERS_BATCH_LIMIT) {
      batches.push(asked.slice(start, start + ORGANIZATION_TICKERS_BATCH_LIMIT));
    }
    await Promise.all(batches.map(async (batch) => {
      const keys = batch.map(sponsorKey);
      keys.forEach((key) => this.inFlight.add(key));
      try {
        const results = await this.lookup(batch, signal);
        results.forEach((result, index) => this.answers.set(keys[index]!, sponsorTickerFrom(result)));
      } catch (error) {
        // An abandoned lookup (its pane closed) is neither an answer nor a failure.
        if (!signal?.aborted) {
          const reason = failureReason(error);
          keys.forEach((key) => this.failures.set(key, reason));
        }
      } finally {
        keys.forEach((key) => this.inFlight.delete(key));
      }
      // Also after an abandoned lookup, so another pane waiting on these names asks again.
      this.listeners.forEach((listener) => listener());
    }));
  }

  /** Forgets failed lookups, so the next `load` asks again. */
  retryFailed(): void {
    if (this.failures.size === 0) return;
    this.failures.clear();
    this.listeners.forEach((listener) => listener());
  }
}

const sponsorTickerStore = new SponsorTickerStore(async (names, signal) => (
  validateOrganizationTickers(await apiClient.getCloudOrganizationTickers(names, signal), names)
));

/**
 * The tickers for the sponsors on screen. Rows draw at once and tickers fill
 * in when the lookup answers; `retry` asks again for the ones that failed.
 * `sessionKey` changing (a sign-in) retries them too.
 */
export function useSponsorTickers(names: readonly string[], sessionKey: string, store: SponsorTickerStore = sponsorTickerStore) {
  const [version, setVersion] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [signal, setSignal] = useState<AbortSignal | null>(null);
  useEffect(() => store.subscribe(() => setVersion((current) => current + 1)), [store]);
  // One lookup lifetime per pane: a new page must not abandon the last page's lookup.
  useEffect(() => {
    const controller = new AbortController();
    setSignal(controller.signal);
    return () => controller.abort();
  }, [store]);
  useEffect(() => {
    store.retryFailed();
  }, [sessionKey, store]);
  const namesKey = names.join("\n");
  useEffect(() => {
    if (!signal || signal.aborted || !namesKey) return;
    void store.load(namesKey.split("\n"), signal);
  }, [epoch, namesKey, sessionKey, signal, store, version]);
  const retry = useCallback(() => {
    store.retryFailed();
    setEpoch((current) => current + 1);
  }, [store]);
  const tickers = useMemo(
    () => new Map(names.map((name) => [name, store.get(name)] as const)),
    // `version` and `epoch` change whenever the store learns or forgets something.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [namesKey, store, version, epoch],
  );
  const failure = useMemo(() => {
    for (const value of tickers.values()) if (value.kind === "failed") return value.reason;
    return null;
  }, [tickers]);
  return { tickers, failure, retry };
}
