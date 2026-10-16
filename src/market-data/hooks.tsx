import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SecFilingDocument, SecFilingItem } from "../types/data-provider";
import type { OptionsChain, PricePoint, Quote, TickerFinancials } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import type { ChartRequest, InstrumentRef, OptionsRequest, SecFilingsRequest, TickerInstrumentOptions } from "./request-types";
import { instrumentFromTicker } from "./request-types";
import { useAppVisible, usePaneVisible } from "../state/app/activity";
import {
  getSharedMarketDataCoordinator,
  resolveEntryValue,
} from "./coordinator";
import { resolveEntryData } from "./selectors";
import type { QueryEntry } from "./result-types";
import {
  buildArticleSummaryKey,
  buildChartKey,
  buildFxKey,
  buildOptionsKey,
  buildQuoteKey,
  buildSecContentKey,
  buildSecDocumentsKey,
  buildSecFilingsKey,
  buildSnapshotKey,
} from "./selectors";
import { instrumentIdentityKey } from "../utils/instrument-identity";
import { createBaselineChartRequest } from "./coordinator/chart";
import { fateListing, LATE_CHANGE_WAIT_MS, listingFateGate, type ListingFateGate } from "../tickers/listing-fate";
import type { TickerChangeLookup } from "../tickers/ticker-changes";
import type { TickerChanges } from "../types/ticker-changes";

const TICKER_FINANCIALS_LOAD_DELAY_MS = 250;
export const DEFAULT_LIVE_CHART_REFRESH_INTERVAL_MS = 60_000;

interface ChartQueryOptions {
  debounceMs?: number;
  refreshIntervalMs?: number;
}

interface OptionsQueryOptions {
  refreshIntervalMs?: number;
}

type SharedCoordinator = NonNullable<ReturnType<typeof getSharedMarketDataCoordinator>>;

function loadChartRequests(
  coordinator: SharedCoordinator,
  requests: readonly ChartRequest[],
  options: { forceRefresh?: boolean } = {},
): void {
  for (const request of requests) {
    void coordinator.loadChart(request, options).catch(() => {});
  }
}

function useCoordinatorKeysVersion(keys: readonly string[]): number {
  const coordinator = getSharedMarketDataCoordinator();
  const keyString = keys.join("\u001f");
  const stableKeys = useMemo(
    () => (keyString ? keyString.split("\u001f") : []),
    [keyString],
  );
  const subscribe = useCallback((listener: () => void) => {
    if (!coordinator) return () => {};
    if (typeof coordinator.subscribeKeys === "function") {
      return coordinator.subscribeKeys(stableKeys, listener);
    }
    return coordinator.subscribe(listener);
  }, [coordinator, stableKeys]);
  const getSnapshot = useCallback(() => {
    if (!coordinator) return 0;
    if (typeof coordinator.getKeysVersion === "function") {
      return coordinator.getKeysVersion(stableKeys);
    }
    return coordinator.getVersion();
  }, [coordinator, stableKeys]);
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

function stableCurrencyList(currencies: Array<string | null | undefined>): string[] {
  return [...new Set(
    currencies
      .map((currency) => currency?.trim().toUpperCase() ?? "")
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
}

function buildTickerFinancialsMapKey(tickers: TickerRecord[], options: TickerInstrumentOptions = {}): string {
  return tickers.map((ticker) => {
    const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker, options);
    return instrument ? buildSnapshotKey(instrument) : `unresolved:${ticker.metadata.ticker}`;
  }).join("::");
}

function useTickerInstrument(symbol: string | null | undefined, ticker: TickerRecord | null | undefined): InstrumentRef | null {
  return useMemo(() => instrumentFromTicker(ticker, symbol ?? null), [symbol, ticker]);
}

export function useTickerFinancials(symbol: string | null | undefined, ticker: TickerRecord | null | undefined): TickerFinancials | null {
  const instrument = useTickerInstrument(symbol, ticker);
  const instrumentKey = instrument ? instrumentIdentityKey(instrument) : null;
  const keys = useMemo(() => (
    instrument
      ? [
        buildSnapshotKey(instrument),
        buildQuoteKey(instrument),
        buildChartKey(createBaselineChartRequest(instrument)),
      ]
      : []
  ), [instrumentKey]);
  useCoordinatorKeysVersion(keys);
  const coordinator = getSharedMarketDataCoordinator();
  const financials = coordinator && instrument
    ? coordinator.getTickerFinancialsSync(instrument)
    : null;

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !instrument) return;
    const timeoutId = setTimeout(() => {
      void coordinator.loadSnapshot(instrument).catch(() => {});
    }, TICKER_FINANCIALS_LOAD_DELAY_MS);
    return () => clearTimeout(timeoutId);
  }, [instrumentKey]);

  return financials;
}

function buildTickerFinancialsKeys(tickers: TickerRecord[], options: TickerInstrumentOptions = {}): string[] {
  const keys: string[] = [];
  for (const ticker of tickers) {
    const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker, options);
    if (!instrument) continue;
    keys.push(
      buildSnapshotKey(instrument),
      buildQuoteKey(instrument),
      buildChartKey(createBaselineChartRequest(instrument)),
    );
  }
  return keys;
}

/**
 * A new object so memo dependencies move, over the map that already holds
 * every unchanged entry. Copying that map would visit every instrument.
 */
class RetainedMapView<K, V> extends Map<K, V> {
  constructor(private readonly backing: Map<K, V>) {
    super();
  }

  override get size(): number {
    return this.backing.size;
  }

  override get(key: K): V | undefined {
    return this.backing.get(key);
  }

  override has(key: K): boolean {
    return this.backing.has(key);
  }

  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    this.backing.forEach((value, key) => {
      callback.call(thisArg, value, key, this);
    });
  }

  override keys(): MapIterator<K> {
    return this.backing.keys();
  }

  override values(): MapIterator<V> {
    return this.backing.values();
  }

  override entries(): MapIterator<[K, V]> {
    return this.backing.entries();
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.backing[Symbol.iterator]();
  }
}

interface PatchedMapSlot<K, V> {
  key: K;
  versionKeys: readonly string[];
  read: () => V | null | undefined;
}

interface PatchedMapState<K, V> {
  signature: string;
  coordinator: SharedCoordinator | null;
  slots: Array<PatchedMapSlot<K, V>>;
  versions: number[];
  backing: Map<K, V>;
  view: Map<K, V>;
}

function slotVersion(
  slot: PatchedMapSlot<unknown, unknown>,
  versionOf: ((key: string) => number) | null,
  aggregate: number,
): number {
  if (!versionOf) return aggregate;
  let version = 0;
  for (const key of slot.versionKeys) version += versionOf(key);
  return version;
}

function usePatchedMap<K, V>(
  signature: string,
  coordinator: SharedCoordinator | null,
  aggregateVersion: number,
  versionOf: ((key: string) => number) | null,
  createSlots: () => Array<PatchedMapSlot<K, V>>,
): Map<K, V> {
  const stateRef = useRef<PatchedMapState<K, V> | null>(null);
  let state = stateRef.current;
  if (!state || state.signature !== signature || state.coordinator !== coordinator) {
    const slots = createSlots();
    const backing = new Map<K, V>();
    const versions: number[] = [];
    for (const slot of slots) {
      const value = slot.read();
      if (value != null) backing.set(slot.key, value);
      versions.push(slotVersion(slot, versionOf, aggregateVersion));
    }
    const view = new RetainedMapView(backing);
    state = { signature, coordinator, slots, versions, backing, view };
    stateRef.current = state;
    return view;
  }

  let changed = false;
  for (let index = 0; index < state.slots.length; index += 1) {
    const slot = state.slots[index]!;
    const version = slotVersion(slot, versionOf, aggregateVersion);
    if (version === state.versions[index]) continue;
    state.versions[index] = version;
    const value = slot.read();
    if (value == null) {
      if (state.backing.delete(slot.key)) changed = true;
    } else if (state.backing.get(slot.key) !== value) {
      state.backing.set(slot.key, value);
      changed = true;
    }
  }
  if (!changed) return state.view;
  const view = new RetainedMapView(state.backing);
  state.view = view;
  return view;
}

function versionOfCoordinator(coordinator: SharedCoordinator | null): ((key: string) => number) | null {
  if (!coordinator || typeof coordinator.getKeyVersion !== "function") return null;
  return (key) => coordinator.getKeyVersion(key);
}

export function useTickerFinancialsMap(
  tickers: TickerRecord[],
  options: TickerInstrumentOptions = {},
): Map<string, TickerFinancials> {
  const coordinator = getSharedMarketDataCoordinator();
  const optionsKey = options.portfolioId ?? "";
  const tickerKey = buildTickerFinancialsMapKey(tickers, options);
  const subscriptionKeys = useMemo(() => buildTickerFinancialsKeys(tickers, options), [optionsKey, tickerKey]);
  const keysVersion = useCoordinatorKeysVersion(subscriptionKeys);

  return usePatchedMap(
    `${tickerKey}\0${optionsKey}`,
    coordinator,
    keysVersion,
    versionOfCoordinator(coordinator),
    () => {
      if (!coordinator) return [];
      const slots: Array<PatchedMapSlot<string, TickerFinancials>> = [];
      for (const ticker of tickers) {
        const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker, options);
        if (!instrument) continue;
        slots.push({
          key: ticker.metadata.ticker,
          versionKeys: [
            buildSnapshotKey(instrument),
            buildQuoteKey(instrument),
            buildChartKey(createBaselineChartRequest(instrument)),
          ],
          read: () => coordinator.getTickerFinancialsSync(instrument),
        });
      }
      return slots;
    },
  );
}

export function useQuoteEntry(symbol: string | null | undefined, ticker: TickerRecord | null | undefined): QueryEntry<Quote> | null {
  const instrument = useTickerInstrument(symbol, ticker);
  const instrumentKey = instrument ? instrumentIdentityKey(instrument) : null;
  const keys = useMemo(
    () => (instrument ? [buildQuoteKey(instrument)] : []),
    [instrumentKey],
  );
  useCoordinatorKeysVersion(keys);
  const coordinator = getSharedMarketDataCoordinator();
  const entry = coordinator && instrument ? coordinator.getQuoteEntry(instrument) : null;

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !instrument) return;
    void coordinator.loadQuote(instrument).catch(() => {});
  }, [instrumentKey]);

  return entry;
}

const SERVE_GATE: ListingFateGate = { kind: "serve" };

/** A quote entry as the fate reads it: undefined while it loads, null when the listing has none. */
function fateQuote(entry: QueryEntry<Quote> | null): Quote | null | undefined {
  const quote = resolveEntryData(entry);
  if (quote) return quote;
  return entry && (entry.phase === "error" || entry.phase === "ready") ? null : undefined;
}

/**
 * Whether a pane may ask for a symbol's data (`listingFateGate`): a symbol
 * whose company moved, with nothing new listed under it, has none of its own.
 * It reads the symbol's quote and change lookup as `quote` does: a symbol
 * whose quote shows it trading never waits on the lookup, a stopped line or a
 * quote still coming waits for it, and a gate still waiting after
 * LATE_CHANGE_WAIT_MS serves. The quote is watched only while the answer can
 * turn on it, so a symbol with no change on record costs no re-render per tick.
 */
export function useListingFateGate(symbol: string | null | undefined, ticker: TickerRecord | null | undefined): ListingFateGate {
  const coordinator = getSharedMarketDataCoordinator();
  const instrument = useTickerInstrument(symbol, ticker);
  const instrumentKey = instrument ? instrumentIdentityKey(instrument) : null;
  const listing = useMemo(() => (instrument ? fateListing(instrument) : null), [instrumentKey]);
  const lookup = useMemo(
    () => (coordinator && instrument && listing ? coordinator.lookupTickerChanges(instrument) : null),
    [coordinator, instrumentKey],
  );
  const [answer, setAnswer] = useState<{ lookup: TickerChangeLookup; changes: TickerChanges | null } | null>(null);
  const changes = !lookup ? null : answer?.lookup === lookup ? answer.changes : lookup.peek();
  useEffect(() => {
    if (!lookup || lookup.peek() !== undefined) return;
    let current = true;
    void lookup.settle(LATE_CHANGE_WAIT_MS).then((value) => {
      if (current) setAnswer({ lookup, changes: value });
    });
    return () => { current = false; };
  }, [lookup]);
  const watchQuote = !!listing && (changes === undefined || !!changes?.moved);
  const quoteEntry = useQuoteEntry(watchQuote ? symbol : null, watchQuote ? ticker : null);
  const gate = listing && watchQuote ? listingFateGate(listing, { quote: fateQuote(quoteEntry), changes }) : SERVE_GATE;
  // Nothing holds a pane longer than a stopped line's lookup may take.
  const [expired, setExpired] = useState<string | null>(null);
  const waiting = gate.kind === "wait";
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setExpired(instrumentKey), LATE_CHANGE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [instrumentKey, waiting]);
  return waiting && expired === instrumentKey ? SERVE_GATE : gate;
}

/**
 * Observe quote entries already populated by the shared stream without issuing
 * one HTTP snapshot request per instrument.
 */
export function useQuoteEntries(
  instruments: readonly InstrumentRef[],
): Map<string, QueryEntry<Quote>> {
  const instrumentKey = instruments
    .map((instrument) => buildQuoteKey(instrument))
    .join("\u001f");
  const keys = useMemo(
    () => instruments.map((instrument) => buildQuoteKey(instrument)),
    [instrumentKey],
  );
  const keysVersion = useCoordinatorKeysVersion(keys);
  const coordinator = getSharedMarketDataCoordinator();

  return usePatchedMap(
    instrumentKey,
    coordinator,
    keysVersion,
    versionOfCoordinator(coordinator),
    () => {
      if (!coordinator) return [];
      return instruments.map((instrument) => {
        const key = buildQuoteKey(instrument);
        return {
          key,
          versionKeys: [key],
          read: () => coordinator.getQuoteEntry(instrument),
        };
      });
    },
  );
}

export function useChartQueries(
  requests: readonly ChartRequest[],
  options: ChartQueryOptions = {},
): Map<string, QueryEntry<PricePoint[]>> {
  const requestKey = requests.map((request) => buildChartKey(request)).join(",");
  const debounceMs = Math.max(0, options.debounceMs ?? 0);
  const refreshIntervalMs = Math.max(0, options.refreshIntervalMs ?? 0);
  const keys = useMemo(() => requests.map((request) => buildChartKey(request)), [requestKey]);
  const keysVersion = useCoordinatorKeysVersion(keys);
  const coordinator = getSharedMarketDataCoordinator();
  const appActive = useAppVisible();
  const paneVisible = usePaneVisible();
  const wasPaneVisibleRef = useRef(paneVisible);
  const entries = useMemo(() => (
    coordinator
      ? requests.map((request) => [buildChartKey(request), coordinator.getChartEntry(request)] as const)
      : [] as Array<readonly [string, QueryEntry<PricePoint[]>]>
  ), [coordinator, keys, keysVersion, requestKey]);

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator) {
      wasPaneVisibleRef.current = paneVisible;
      return;
    }
    if (!appActive) {
      wasPaneVisibleRef.current = false;
      return;
    }
    const forceRefresh = refreshIntervalMs > 0 && paneVisible && !wasPaneVisibleRef.current;
    wasPaneVisibleRef.current = paneVisible;
    const loadRequests = () => {
      loadChartRequests(coordinator, requests, { forceRefresh });
    };
    if (debounceMs <= 0) {
      loadRequests();
      return;
    }
    const timeout = setTimeout(loadRequests, debounceMs);
    return () => clearTimeout(timeout);
  }, [appActive, debounceMs, paneVisible, refreshIntervalMs, requestKey]);

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !paneVisible || refreshIntervalMs <= 0 || requests.length === 0) return;

    const interval = setInterval(() => {
      loadChartRequests(coordinator, requests, { forceRefresh: true });
    }, refreshIntervalMs);
    return () => clearInterval(interval);
  }, [paneVisible, refreshIntervalMs, requestKey]);

  return useMemo(() => new Map(entries), [entries]);
}

export function useOptionsQuery(
  request: OptionsRequest | null | undefined,
  options: OptionsQueryOptions = {},
): QueryEntry<OptionsChain> | null {
  const requestKey = request ? buildOptionsKey(request) : null;
  useCoordinatorKeysVersion(requestKey ? [requestKey] : []);
  const coordinator = getSharedMarketDataCoordinator();
  const entry = coordinator && request ? coordinator.getOptionsEntry(request) : null;
  // The refresh feeds a display: it rests while the pane is covered or the app
  // is hidden, and catches up at once if a refresh came due meanwhile.
  const visible = usePaneVisible();
  const refreshIntervalMs = Math.max(0, options.refreshIntervalMs ?? 0);
  const lastRefreshRef = useRef({ key: requestKey, at: Date.now() });
  if (lastRefreshRef.current.key !== requestKey) lastRefreshRef.current = { key: requestKey, at: Date.now() };

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !request) return;
    void coordinator.loadOptions(request).catch(() => {});
  }, [requestKey]);

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !request || !visible || refreshIntervalMs <= 0) return;
    const refresh = () => {
      lastRefreshRef.current = { key: requestKey, at: Date.now() };
      void coordinator.loadOptions(request, { forceRefresh: true }).catch(() => {});
    };
    if (Date.now() - lastRefreshRef.current.at >= refreshIntervalMs) refresh();
    const interval = setInterval(refresh, refreshIntervalMs);
    return () => clearInterval(interval);
  }, [refreshIntervalMs, requestKey, visible]);

  return entry;
}

export function useSecFilingsQuery(request: SecFilingsRequest | null | undefined): QueryEntry<SecFilingItem[]> | null {
  const requestKey = request ? buildSecFilingsKey(request) : null;
  useCoordinatorKeysVersion(requestKey ? [requestKey] : []);
  const coordinator = getSharedMarketDataCoordinator();
  const entry = coordinator && request ? coordinator.getSecFilingsEntry(request) : null;

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !request) return;
    void coordinator.loadSecFilings(request).catch(() => {});
  }, [requestKey]);

  return entry;
}

export function useSecFilingContent(filing: SecFilingItem | null | undefined): QueryEntry<string | null> | null {
  const key = filing ? buildSecContentKey(filing.accessionNumber) : null;
  const version = useCoordinatorKeysVersion(key ? [key] : []);
  const coordinator = getSharedMarketDataCoordinator();
  // Read at the version React holds. A store write is announced a frame
  // later; a render in between that changes no state is thrown away, and with
  // it the effects of a reader that saw the new entry early, which then never
  // see it change (a filing queue stalled on "loading").
  const accession = filing?.accessionNumber ?? null;
  const entry = useMemo(
    () => coordinator && accession ? coordinator.getSecContentEntry(accession) : null,
    [accession, coordinator, version],
  );

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !filing) return;
    void coordinator.loadSecFilingContent(filing).catch(() => {});
  }, [key]);

  return entry;
}

export function useSecFilingDocuments(filing: SecFilingItem | null | undefined): QueryEntry<SecFilingDocument[]> | null {
  const key = filing ? buildSecDocumentsKey(filing.accessionNumber) : null;
  useCoordinatorKeysVersion(key ? [key] : []);
  const coordinator = getSharedMarketDataCoordinator();
  const entry = coordinator && filing ? coordinator.getSecDocumentsEntry(filing.accessionNumber) : null;

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !filing) return;
    void coordinator.loadSecFilingDocuments(filing).catch(() => {});
  }, [key]);

  return entry;
}

export function useArticleSummary(url: string | null | undefined): QueryEntry<string | null> | null {
  const key = url ? buildArticleSummaryKey(url) : null;
  useCoordinatorKeysVersion(key ? [key] : []);
  const coordinator = getSharedMarketDataCoordinator();
  const entry = coordinator && url ? coordinator.getArticleSummaryEntry(url) : null;

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !url) return;
    void coordinator.loadArticleSummary(url).catch(() => {});
  }, [url]);

  return entry;
}

export function useFxRatesMap(currencies: Array<string | null | undefined>): Map<string, number> {
  const coordinator = getSharedMarketDataCoordinator();
  const normalizedCurrencyKey = stableCurrencyList(currencies).join("|");
  const normalizedCurrencies = useMemo(
    () => (normalizedCurrencyKey ? normalizedCurrencyKey.split("|") : []),
    [normalizedCurrencyKey],
  );
  const keys = useMemo(() => normalizedCurrencies.map(buildFxKey), [normalizedCurrencies]);
  const keysVersion = useCoordinatorKeysVersion(keys);
  const entries = useMemo(() => {
    if (!coordinator) return [] as Array<readonly [string, QueryEntry<number>]>;
    return normalizedCurrencies.map((currency) => [currency, coordinator.getFxEntry(currency)] as const);
  }, [coordinator, keys, keysVersion, normalizedCurrencies]);

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator) return;
    for (const currency of normalizedCurrencies) {
      if (currency === "USD") continue;
      void coordinator.loadFxRate(currency);
    }
  }, [normalizedCurrencyKey]);

  // Converted totals follow the streamed USD pairs while the app is visible;
  // the loaded rates above stay the fallback.
  const appVisible = useAppVisible();
  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !appVisible || typeof coordinator.subscribeFxRates !== "function") return;
    if (!normalizedCurrencies.some((currency) => currency !== "USD")) return;
    const subscription = coordinator.subscribeFxRates(normalizedCurrencies);
    return () => subscription();
  }, [appVisible, normalizedCurrencyKey]);

  return useMemo(() => {
    const rates = new Map<string, number>();
    rates.set("USD", 1);
    for (const [currency, entry] of entries) {
      const rate = resolveEntryValue(entry);
      if (rate != null) {
        rates.set(currency, rate);
      }
    }
    return rates;
  }, [entries]);
}

export function useResolvedEntryValue<T>(entry: QueryEntry<T> | null | undefined): T | null {
  return useMemo(() => (entry ? resolveEntryValue(entry) : null), [entry]);
}
