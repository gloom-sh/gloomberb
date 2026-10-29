import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import {
  ORGANIZATION_TICKERS_BATCH_LIMIT,
  validateOrganizationTickers,
  type OrganizationTicker,
} from "../../../api-client/organization-tickers";
import { createTtlCache, type TtlCache } from "../../../data/ttl-cache";
import { findSponsorListings, type ListingFinder } from "./sponsor-listing";

/**
 * A lead sponsor's ticker, as Gloom Cloud resolved it, or, for a company it
 * has no reviewed name for, as the listing search finds it (`listingSearch`).
 * `none` is an answer (no listed company, or a name that fits several);
 * `failed` means it was not looked up at all and says nothing about the
 * sponsor.
 */
export type SponsorTicker =
  | { kind: "pending" }
  | { kind: "listed"; ticker: string; exchange: string | null; entityName: string | null }
  | { kind: "none"; entityName: string | null; ambiguous: boolean; listingSearch?: "done" }
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
  private readonly searching = new Set<string>();
  private readonly searchFailures = new Set<string>();
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

  /**
   * `load`, then `searchListings` for the companies among the names, but the
   * caller waits no longer than `ms`: the lookups go on and tickers fill in
   * when they answer.
   */
  async loadWithin(
    names: readonly string[],
    ms: number,
    signal?: AbortSignal,
    listings?: { companies: readonly string[]; find?: ListingFinder },
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const patience = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
    const lookups = this.load(names, signal).then(() => listings ? this.searchListings(listings.companies, listings.find, signal) : undefined);
    try {
      await Promise.race([lookups, patience]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Looks the companies Gloom Cloud had no name for up in Gloom Cloud's
   * search, the one that finds `Bayer` when it is typed, and keeps a primary
   * listing as the sponsor's ticker (`findSponsorListings` says which names
   * qualify). Only names Cloud answered with no company, no listing and no
   * ambiguity are asked: a company it knows, and a name that fits several,
   * stay as it said. Each name is searched once, all in one request; a search
   * that failed waits for `retryFailed`, and tells nothing about the sponsor.
   */
  async searchListings(names: readonly string[], find: ListingFinder = findSponsorListings, signal?: AbortSignal): Promise<void> {
    const asked = new Map<string, string>();
    for (const name of names) {
      const trimmed = name.trim();
      const key = sponsorKey(trimmed);
      const answer = this.answers.peek(key);
      if (!trimmed || asked.has(key) || this.searching.has(key) || this.searchFailures.has(key)) continue;
      if (answer?.kind !== "none" || answer.ambiguous || answer.entityName || answer.listingSearch) continue;
      asked.set(key, trimmed);
    }
    if (asked.size === 0) return;
    const keys = [...asked.keys()];
    keys.forEach((key) => this.searching.add(key));
    try {
      const found = await find([...asked.values()], signal);
      if (signal?.aborted) return;
      let changed = false;
      for (const [key, name] of asked) {
        const listing = found.get(name) ?? null;
        this.answers.set(key, listing
          ? { kind: "listed", ticker: listing.ticker, exchange: listing.exchange, entityName: listing.entityName }
          : { kind: "none", entityName: null, ambiguous: false, listingSearch: "done" });
        changed ||= listing !== null;
      }
      if (changed) this.listeners.forEach((listener) => listener());
    } catch {
      // A failed search says nothing about the sponsor; it is asked again on retry.
      if (!signal?.aborted) keys.forEach((key) => this.searchFailures.add(key));
    } finally {
      keys.forEach((key) => this.searching.delete(key));
    }
  }

  /** Forgets failed lookups, so the next `load` asks again. */
  retryFailed(): void {
    if (this.failures.size === 0 && this.searchFailures.size === 0) return;
    this.failures.clear();
    this.searchFailures.clear();
    this.listeners.forEach((listener) => listener());
  }
}

export const sponsorTickerStore = new SponsorTickerStore(async (names, signal) => (
  validateOrganizationTickers(await apiClient.getCloudOrganizationTickers(names, signal), names)
));

export interface SponsorTickersOptions {
  /** The company sponsors among `names`: the ones Cloud's search may look up when its ticker lookup has no name for them. */
  companies?: readonly string[];
  store?: SponsorTickerStore;
}

/**
 * The tickers for the sponsors on screen. Rows draw at once and tickers fill
 * in when the lookup answers; `retry` asks again for the ones that failed.
 * `sessionKey` changing (a sign-in) retries them too.
 */
export function useSponsorTickers(names: readonly string[], sessionKey: string, { companies, store = sponsorTickerStore }: SponsorTickersOptions = {}) {
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
  const companiesKey = (companies ?? []).join("\n");
  useEffect(() => {
    if (!signal || signal.aborted || !namesKey) return;
    void store.load(namesKey.split("\n"), signal).then(() => {
      if (companiesKey) return store.searchListings(companiesKey.split("\n"), findSponsorListings, signal);
    });
  }, [companiesKey, epoch, namesKey, sessionKey, signal, store, version]);
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
