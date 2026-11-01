import { logFailure } from "../utils/log-failure";
import { fxRateCurrencies } from "../utils/currency-units";
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
    void coordinator.loadChart(request, options).catch(logFailure("market-data.hooks", "Loading chart data failed"));
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
      void coordinator.loadSnapshot(instrument).catch(logFailure("market-data.hooks", "Loading a financial snapshot failed"));
    }, TICKER_FINANCIALS_LOAD_DELAY_MS);
    return () => clearTimeout(timeoutId);
  }, [instrumentKey]);

  return financials;
}

/** Where a ticker's snapshot load stands, for a pane with nothing of it to show yet. */
export interface TickerSnapshotState {
  /** Asked for, or about to be, with no answer yet. */
  loading: boolean;
  /** Why the last load came back with nothing, or null. */
  error: string | null;
  /** Asks again now, past a recent failure. */
  retry: () => Promise<void>;
}

/** The snapshot load behind `useTickerFinancials`, as its entry stands. */
export function useTickerSnapshotState(symbol: string | null | undefined, ticker: TickerRecord | null | undefined): TickerSnapshotState {
  const instrument = useTickerInstrument(symbol, ticker);
  const instrumentKey = instrument ? instrumentIdentityKey(instrument) : null;
  const keys = useMemo(() => (instrument ? [buildSnapshotKey(instrument)] : []), [instrumentKey]);
  useCoordinatorKeysVersion(keys);
  const coordinator = getSharedMarketDataCoordinator();
  const entry = coordinator && instrument ? coordinator.getSnapshotEntry(instrument) : null;
  const retry = useCallback(async () => {
    const coordinator = getSharedMarketDataCoordinator();
    if (coordinator && instrument) await coordinator.loadSnapshot(instrument, { forceRefresh: true });
  }, [instrumentKey]);
  const failed = !!entry && (entry.phase === "error" || entry.phase === "ready") && entry.error != null;
  return {
    // Idle is a load the hook is about to start.
    loading: !!entry && (entry.phase === "idle" || entry.phase === "loading" || entry.phase === "refreshing"),
    error: failed ? entry.error!.message : null,
    retry,
  };
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
  /** The subscribed keys' summed version when the slots were last read. */
  aggregateVersion: number;
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
    state = { signature, coordinator, slots, versions, backing, view, aggregateVersion };
    stateRef.current = state;
    return view;
  }

  // Key versions only grow, so an unchanged sum means no slot moved: a render
  // for any other reason skips reading every slot's versions. Both are kept
  // only once read, so a read that throws is tried again on the next render.
  if (aggregateVersion === state.aggregateVersion) return state.view;
  let changed = false;
  for (let index = 0; index < state.slots.length; index += 1) {
    const slot = state.slots[index]!;
    const version = slotVersion(slot, versionOf, aggregateVersion);
    if (version === state.versions[index]) continue;
    const value = slot.read();
    state.versions[index] = version;
    if (value == null) {
      if (state.backing.delete(slot.key)) changed = true;
    } else if (state.backing.get(slot.key) !== value) {
      state.backing.set(slot.key, value);
      changed = true;
    }
  }
  state.aggregateVersion = aggregateVersion;
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
  // Per list, not per render: a quote tick re-renders the pane but leaves its
  // rows (immutable records, replaced when they change) and portfolio alone.
  const tickerKey = useMemo(() => buildTickerFinancialsMapKey(tickers, options), [optionsKey, tickers]);
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
    void coordinator.loadQuote(instrument).catch(logFailure("market-data.hooks", "Loading a quote failed"));
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
 * Whether a pane shows a symbol's own data (`listingFateGate`): a symbol
 * whose company moved, with nothing new listed under it, has none. It reads
 * the symbol's quote and change lookup as `quote` does. A symbol is served
 * at once, whatever is still loading, unless what is known says nothing
 * trades under it (a line that ended, a company that left); only then does
 * the pane wait for the rest, never longer than LATE_CHANGE_WAIT_MS. The
 * quote is watched only while the answer can turn on it, so a symbol with no
 * change on record costs no re-render per tick.
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
  // A wait never holds a pane longer than the commands wait for a fate.
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
    void coordinator.loadOptions(request).catch(logFailure("market-data.hooks", "Loading options failed"));
  }, [requestKey]);

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !request || !visible || refreshIntervalMs <= 0) return;
    const refresh = () => {
      lastRefreshRef.current = { key: requestKey, at: Date.now() };
      void coordinator.loadOptions(request, { forceRefresh: true }).catch(logFailure("market-data.hooks", "Loading options failed"));
    };
    if (Date.now() - lastRefreshRef.current.at >= refreshIntervalMs) refresh();
    const interval = setInterval(refresh, refreshIntervalMs);
    return () => clearInterval(interval);
  }, [refreshIntervalMs, requestKey, visible]);

  return entry;
}

export function useSecFilingsQuery(request: SecFilingsRequest | null | undefined): QueryEntry<SecFilingItem[]> | null {
  const requestKey = request ? buildSecFilingsKey(request) : null;
  const version = useCoordinatorKeysVersion(requestKey ? [requestKey] : []);
  const coordinator = getSharedMarketDataCoordinator();
  // Read at the version React holds, as useSecFilingContent does. A pane
  // opened from another (INS from its ranking) can render between the store
  // write and its announcement; read early, the list is thrown away with that
  // render, and the filing queue after it stays on "loading".
  // The key stands for the request: a new object for the same filings reads the same entry.
  const entry = useMemo(
    () => coordinator && request ? coordinator.getSecFilingsEntry(request) : null,
    [coordinator, requestKey, version],
  );

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !request) return;
    void coordinator.loadSecFilings(request).catch(logFailure("market-data.hooks", "Loading filings failed"));
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
    void coordinator.loadSecFilingContent(filing).catch(logFailure("market-data.hooks", "Loading filing content failed"));
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
    void coordinator.loadSecFilingDocuments(filing).catch(logFailure("market-data.hooks", "Loading filing documents failed"));
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
    void coordinator.loadArticleSummary(url).catch(logFailure("market-data.hooks", "Loading an article summary failed"));
  }, [url]);

  return entry;
}

/** A currency's US dollar rate as the app holds it, and when its source observed it (epoch ms; null when undated, and for USD). */
export interface FxRateObservation {
  rate: number;
  asOf: number | null;
}

export function useFxRatesMap(currencies: Array<string | null | undefined>): Map<string, number> {
  const observations = useFxRateObservations(currencies);
  return useMemo(() => new Map([...observations].map(([currency, observation]) => [currency, observation.rate])), [observations]);
}

/** useFxRatesMap with each rate's observation time, for a figure that states the rate it was converted at. */
export function useFxRateObservations(currencies: Array<string | null | undefined>): Map<string, FxRateObservation> {
  const coordinator = getSharedMarketDataCoordinator();
  // A minor unit's major currency is loaded too: GBX and ILA have no rate of their own.
  const normalizedCurrencyKey = fxRateCurrencies(currencies).join("|");
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
    const rates = new Map<string, FxRateObservation>();
    rates.set("USD", { rate: 1, asOf: null });
    for (const [currency, entry] of entries) {
      const rate = resolveEntryValue(entry);
      if (rate != null) {
        rates.set(currency, { rate, asOf: entry?.asOf ?? null });
      }
    }
    return rates;
  }, [entries]);
}

export function useResolvedEntryValue<T>(entry: QueryEntry<T> | null | undefined): T | null {
  return useMemo(() => (entry ? resolveEntryValue(entry) : null), [entry]);
}
