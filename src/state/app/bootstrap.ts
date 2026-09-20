import type { Dispatch } from "react";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import { findPaneInstance, isTickerPaneId, type AppConfig } from "../../types/config";
import type { CachedFinancialsTarget, DataProvider } from "../../types/data-provider";
import type { TickerFinancials } from "../../types/financials";
import type { BrokerAccount } from "../../types/trading";
import type { TickerMetadata, TickerRecord } from "../../types/ticker";
import type { AppAction, AppState, PaneRuntimeState } from "./context";
import type { AppSessionSnapshot } from "../../core/state/session-persistence";
import { instrumentFromTicker, type InstrumentRef } from "../../market-data/request-types";
import { buildInstrumentKey } from "../../market-data/selectors";
import { resolveCollectionForPane } from "../../core/state/app/layout";
import { hasAmbiguousTickerContracts, resolveInstrumentForPane } from "../../core/state/app/instrument";
import { getDockedPaneIds } from "../../plugins/pane-manager";
import { debugLog } from "../../utils/debug-log";
import { measurePerf, measurePerfAsync } from "../../utils/perf-marks";

const DEFAULT_WATCHLIST_TICKERS: Array<Pick<TickerMetadata, "ticker" | "exchange" | "currency" | "name">> = [
  { ticker: "AAPL", exchange: "NASDAQ", currency: "USD", name: "Apple Inc." },
  { ticker: "MSFT", exchange: "NASDAQ", currency: "USD", name: "Microsoft Corporation" },
  { ticker: "GOOGL", exchange: "NASDAQ", currency: "USD", name: "Alphabet Inc." },
  { ticker: "AMZN", exchange: "NASDAQ", currency: "USD", name: "Amazon.com Inc." },
  { ticker: "NVDA", exchange: "NASDAQ", currency: "USD", name: "NVIDIA Corporation" },
  { ticker: "TSLA", exchange: "NASDAQ", currency: "USD", name: "Tesla Inc." },
  { ticker: "META", exchange: "NASDAQ", currency: "USD", name: "Meta Platforms Inc." },
  { ticker: "BRK.B", exchange: "NYSE", currency: "USD", name: "Berkshire Hathaway Inc." },
  { ticker: "JPM", exchange: "NYSE", currency: "USD", name: "JPMorgan Chase & Co." },
  { ticker: "V", exchange: "NYSE", currency: "USD", name: "Visa Inc." },
  { ticker: "BTC-USD", exchange: "CCC", currency: "USD", name: "Bitcoin USD" },
  { ticker: "ETH-USD", exchange: "CCC", currency: "USD", name: "Ethereum USD" },
];

interface StartupPaneStateSeed {
  cursorSymbol?: string | null;
}

interface RefreshPlanEntry {
  ticker: TickerRecord;
  instrument: InstrumentRef;
  priority: number;
  mode: "quote" | "financials";
}

const MAX_BACKGROUND_WARMUP_TICKERS = 12;
const PORTFOLIO_FULL_SNAPSHOT_COLUMN_IDS = new Set([
  "pe",
  "forward_pe",
  "dividend_yield",
  "sparkline",
]);
const startupLog = debugLog.createLogger("startup");

export interface InitializeAppStateArgs {
  config: AppConfig;
  tickerRepository: AppTickerRepositoryPort;
  dataProvider: DataProvider;
  sessionSnapshot?: AppSessionSnapshot | null;
  paneState?: Record<string, PaneRuntimeState>;
  /** Live pane state, read when the seed is dispatched rather than when it was built. */
  getPaneState?: () => Record<string, PaneRuntimeState>;
  dispatch: Dispatch<AppAction>;
  primeCachedFinancials?: (entries: Array<{ ticker: TickerRecord; instrument: InstrumentRef; financials: TickerFinancials }>) => void;
  refreshTicker: (symbol: string, exchange?: string, tickerOverride?: TickerRecord | null, priority?: number, instrument?: InstrumentRef) => void;
  refreshQuote: (symbol: string, exchange?: string, tickerOverride?: TickerRecord | null, priority?: number, instrument?: InstrumentRef) => void;
  refreshTickersBatch?: (entries: Array<{ ticker: TickerRecord; priority: number; instrument?: InstrumentRef }>) => void;
  refreshQuotesBatch?: (entries: Array<{ ticker: TickerRecord; priority: number; instrument?: InstrumentRef }>) => void;
  autoImportBrokerPositions: (tickerMap: Map<string, TickerRecord>) => Promise<void>;
  persistedBrokerAccounts?: Record<string, BrokerAccount[]>;
}

function buildPaneStateSeed(
  config: AppConfig,
  tickers: TickerRecord[],
  tickerMap: Map<string, TickerRecord>,
  paneState: Record<string, PaneRuntimeState>,
): Record<string, StartupPaneStateSeed> {
  const seed: Record<string, StartupPaneStateSeed> = {};
  if (tickers.length === 0) return seed;

  for (const instance of config.layout.instances) {
    if (instance.paneId !== "portfolio-list") continue;
    const existingCursor = paneState[instance.instanceId]?.cursorSymbol;
    if (typeof existingCursor === "string" && tickerMap.has(existingCursor)) {
      seed[instance.instanceId] = { cursorSymbol: existingCursor };
      continue;
    }

    const collectionId = resolveCollectionForPane({ config, paneState } as AppState, instance.instanceId);
    const initialTicker = tickers.find((ticker) =>
      (collectionId && ticker.metadata.portfolios.includes(collectionId))
      || (collectionId && ticker.metadata.watchlists.includes(collectionId))
    ) ?? tickers[0];

    if (initialTicker) {
      seed[instance.instanceId] = { cursorSymbol: initialTicker.metadata.ticker };
    }
  }

  return seed;
}

function buildRefreshPlan(
  config: AppConfig,
  tickerMap: Map<string, TickerRecord>,
  paneStateSeed: Record<string, StartupPaneStateSeed>,
  initialPaneState: Record<string, PaneRuntimeState>,
  sessionSnapshot: AppSessionSnapshot | null | undefined,
): RefreshPlanEntry[] {
  const planByInstrument = new Map<string, RefreshPlanEntry>();
  const paneState = { ...initialPaneState };
  for (const [id, patch] of Object.entries(paneStateSeed)) paneState[id] = { ...paneState[id], ...patch };
  const state = { config, paneState, tickers: tickerMap };

  const enqueueInstrument = (instrument: InstrumentRef | null, priority: number, mode: RefreshPlanEntry["mode"]) => {
    if (!instrument) return;
    const ticker = tickerMap.get(instrument.symbol.trim().toUpperCase());
    if (!ticker) return;

    const key = buildInstrumentKey(instrument);
    const existing = planByInstrument.get(key);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      if (mode === "financials") {
        existing.mode = "financials";
      }
      return;
    }

    planByInstrument.set(key, { ticker, instrument, priority, mode });
  };

  const resolveWarmupMode = (instance: AppConfig["layout"]["instances"][number] | undefined): RefreshPlanEntry["mode"] => {
    if (!instance) return "quote";
    if (isTickerPaneId(instance.paneId)) return "financials";
    if (instance.paneId !== "portfolio-list") return "quote";

    const columnIds = Array.isArray(instance.settings?.columnIds)
      ? instance.settings.columnIds.filter((value): value is string => typeof value === "string")
      : [];
    return columnIds.some((columnId) => PORTFOLIO_FULL_SNAPSHOT_COLUMN_IDS.has(columnId))
      ? "financials"
      : "quote";
  };

  for (const instanceId of getDockedPaneIds(config.layout)) {
    const instance = findPaneInstance(config.layout, instanceId);
    enqueueInstrument(
      resolveInstrumentForPane(state, instanceId),
      0,
      resolveWarmupMode(instance),
    );
  }

  for (const entry of config.layout.floating) {
    const instance = findPaneInstance(config.layout, entry.instanceId);
    enqueueInstrument(
      resolveInstrumentForPane(state, entry.instanceId),
      1,
      resolveWarmupMode(instance),
    );
  }

  let backgroundWarmups = 0;
  for (const target of sessionSnapshot?.hydrationTargets ?? []) {
    if (backgroundWarmups >= MAX_BACKGROUND_WARMUP_TICKERS) break;
    const before = planByInstrument.size;
    enqueueInstrument(target, 2, "financials");
    if (planByInstrument.size > before) {
      backgroundWarmups += 1;
    }
  }

  for (const symbol of config.recentTickers) {
    if (backgroundWarmups >= MAX_BACKGROUND_WARMUP_TICKERS) break;
    const ticker = tickerMap.get(symbol);
    if (hasAmbiguousTickerContracts(ticker)) continue;
    const before = planByInstrument.size;
    enqueueInstrument(instrumentFromTicker(ticker, symbol), 2, "quote");
    if (planByInstrument.size > before) {
      backgroundWarmups += 1;
    }
  }

  return [...planByInstrument.values()].sort((left, right) => left.priority - right.priority);
}

async function resolveCachedFinancialPrimeEntries(
  refreshPlan: RefreshPlanEntry[],
  sessionSnapshot: AppSessionSnapshot | null | undefined,
  tickerMap: Map<string, TickerRecord>,
  dataProvider: DataProvider,
): Promise<Array<{ ticker: TickerRecord; instrument: InstrumentRef; financials: TickerFinancials }>> {
  if (!dataProvider.getCachedFinancialsForTargets) return [];

  const targetEntriesByInstrument = new Map<string, { ticker: TickerRecord; target: CachedFinancialsTarget }>();
  for (const target of sessionSnapshot?.hydrationTargets ?? []) {
    const symbol = target.symbol.trim().toUpperCase();
    const ticker = tickerMap.get(symbol);
    if (ticker) {
      targetEntriesByInstrument.set(buildInstrumentKey(target), { ticker, target: { ...target, symbol } });
    }
  }

  for (const entry of refreshPlan.filter((entry) => entry.mode === "financials")) {
    const key = buildInstrumentKey(entry.instrument);
    if (!targetEntriesByInstrument.has(key)) targetEntriesByInstrument.set(key, { ticker: entry.ticker, target: entry.instrument });
  }

  // The provider's cache API returns a symbol-keyed map. Read each instrument
  // separately so two contracts for one symbol cannot overwrite one another.
  const primedEntries = await Promise.all([...targetEntriesByInstrument.values()].map(async ({ ticker, target }) => {
    try {
      const cached = await dataProvider.getCachedFinancialsForTargets!([target], { includeStaleQuotes: true });
      const financials = cached.get(target.symbol.trim().toUpperCase());
      return financials ? { ticker, instrument: target, financials } : null;
    } catch (error) {
      startupLog.warn("cached financials read failed", {
        instrumentKey: buildInstrumentKey(target),
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }));

  return primedEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

export async function initializeAppState({
  config,
  tickerRepository,
  dataProvider,
  sessionSnapshot,
  paneState,
  getPaneState,
  dispatch,
  primeCachedFinancials,
  refreshTicker,
  refreshQuote,
  refreshTickersBatch,
  refreshQuotesBatch,
  autoImportBrokerPositions,
  persistedBrokerAccounts = {},
}: InitializeAppStateArgs): Promise<void> {
  startupLog.info("initialize start", {
    layoutPaneCount: config.layout.instances.length,
    dockedPaneCount: getDockedPaneIds(config.layout).length,
    floatingPaneCount: config.layout.floating.length,
    brokerInstanceCount: config.brokerInstances.length,
    sessionHydrationTargetCount: sessionSnapshot?.hydrationTargets.length ?? 0,
    recentTickerCount: config.recentTickers.length,
  });

  let tickers = await measurePerfAsync("startup.load-tickers", () => tickerRepository.loadAllTickers());
  startupLog.info("tickers loaded", { count: tickers.length });

  // Seed default watchlist tickers on first run
  if (tickers.length === 0) {
    const defaultWatchlistId = config.watchlists[0]?.id ?? "watchlist";
    await measurePerfAsync("startup.seed-default-tickers", async () => {
      for (const entry of DEFAULT_WATCHLIST_TICKERS) {
        await tickerRepository.createTicker({
          ...entry,
          portfolios: [],
          watchlists: [defaultWatchlistId],
          positions: [],
          broker_contracts: [],
          custom: {},
          tags: [],
        });
      }
    }, { count: DEFAULT_WATCHLIST_TICKERS.length });
    tickers = await measurePerfAsync("startup.reload-default-tickers", () => tickerRepository.loadAllTickers());
    startupLog.info("default tickers seeded", {
      defaultWatchlistId,
      count: tickers.length,
    });
  }

  const tickerMap = measurePerf("startup.build-ticker-map", () => {
    const nextTickerMap = new Map<string, TickerRecord>();
    for (const ticker of tickers) {
      nextTickerMap.set(ticker.metadata.ticker, ticker);
    }
    return nextTickerMap;
  }, { tickerCount: tickers.length });

  const effectivePaneState = paneState ?? {
    ...sessionSnapshot?.paneState,
    ...config.layouts[config.activeLayoutIndex]?.paneState,
  };
  const paneStateSeed = measurePerf(
    "startup.build-pane-state-seed",
    () => buildPaneStateSeed(config, tickers, tickerMap, effectivePaneState),
    { paneCount: config.layout.instances.length },
  );
  const refreshPlan = measurePerf(
    "startup.build-refresh-plan",
    () => buildRefreshPlan(config, tickerMap, paneStateSeed, effectivePaneState, sessionSnapshot),
    {
      tickerCount: tickerMap.size,
      sessionHydrationTargetCount: sessionSnapshot?.hydrationTargets.length ?? 0,
      recentTickerCount: config.recentTickers.length,
    },
  );
  startupLog.info("refresh plan built", {
    count: refreshPlan.length,
    financials: refreshPlan.filter((entry) => entry.mode === "financials").length,
    quotes: refreshPlan.filter((entry) => entry.mode === "quote").length,
    priority0: refreshPlan.filter((entry) => entry.priority === 0).length,
    priority1: refreshPlan.filter((entry) => entry.priority === 1).length,
    priority2: refreshPlan.filter((entry) => entry.priority === 2).length,
    symbols: refreshPlan.map((entry) => `${entry.mode}:${entry.ticker.metadata.ticker}`),
  });

  // Everything the first frame needs is resolved before the store hears about
  // any of it. An await between the ticker dispatch and SET_INITIALIZED let
  // React commit the full layout once with empty panes and again with data,
  // and the first of those commits cost more than the cache reads it hid.
  const cachedPrimeEntries = primeCachedFinancials
    ? await measurePerfAsync(
      "startup.resolve-cached-financial-prime",
      () => resolveCachedFinancialPrimeEntries(refreshPlan, sessionSnapshot, tickerMap, dataProvider),
      {
        financialRefreshCount: refreshPlan.filter((entry) => entry.mode === "financials").length,
        sessionHydrationTargetCount: sessionSnapshot?.hydrationTargets.length ?? 0,
      },
    )
    : [];

  measurePerf("startup.dispatch-set-tickers", () => {
    dispatch({ type: "SET_TICKERS", tickers: tickerMap });
  }, { tickerCount: tickerMap.size });

  measurePerf("startup.dispatch-broker-accounts", () => {
    for (const [instanceId, accounts] of Object.entries(persistedBrokerAccounts)) {
      dispatch({ type: "SET_BROKER_ACCOUNTS", instanceId, accounts });
    }
  }, {
    instanceCount: Object.keys(persistedBrokerAccounts).length,
    accountCount: Object.values(persistedBrokerAccounts).reduce((sum, accounts) => sum + accounts.length, 0),
  });

  measurePerf("startup.dispatch-pane-state-seed", () => {
    // Loading tickers and priming caches takes long enough for the user to
    // have picked a row already. A seed only fills a cursor that is still
    // empty; it never moves one the user has put somewhere.
    const livePaneState = getPaneState?.();
    for (const [paneId, patch] of Object.entries(paneStateSeed) as Array<[string, PaneRuntimeState]>) {
      if (livePaneState && typeof livePaneState[paneId]?.cursorSymbol === "string") continue;
      dispatch({ type: "UPDATE_PANE_STATE", paneId, patch });
    }
  }, { paneStateSeedCount: Object.keys(paneStateSeed).length });

  if (primeCachedFinancials && cachedPrimeEntries.length > 0) {
    measurePerf("startup.prime-cached-financials", () => {
      primeCachedFinancials(cachedPrimeEntries);
    }, { count: cachedPrimeEntries.length });
    startupLog.info("cached financials primed", {
      count: cachedPrimeEntries.length,
      symbols: cachedPrimeEntries.map((entry) => entry.ticker.metadata.ticker),
    });
  }

  measurePerf("startup.dispatch-initialized", () => {
    dispatch({ type: "SET_INITIALIZED" });
  });

  measurePerf("startup.enqueue-refresh-plan", () => {
    const financialEntries = refreshPlan.filter((entry) => entry.mode === "financials");
    const quoteEntries = refreshPlan.filter((entry) => entry.mode === "quote");
    if (refreshTickersBatch) {
      refreshTickersBatch(financialEntries.map((entry) => ({ ticker: entry.ticker, priority: entry.priority, instrument: entry.instrument })));
    } else {
      for (const entry of financialEntries) {
        refreshTicker(entry.ticker.metadata.ticker, entry.ticker.metadata.exchange, entry.ticker, entry.priority, entry.instrument);
      }
    }
    if (refreshQuotesBatch) {
      refreshQuotesBatch(quoteEntries.map((entry) => ({ ticker: entry.ticker, priority: entry.priority, instrument: entry.instrument })));
    } else {
      for (const entry of quoteEntries) {
        refreshQuote(entry.ticker.metadata.ticker, entry.ticker.metadata.exchange, entry.ticker, entry.priority, entry.instrument);
      }
    }
  }, { count: refreshPlan.length });

  void measurePerfAsync("startup.auto-import-broker-positions", () => autoImportBrokerPositions(tickerMap), {
    brokerInstanceCount: config.brokerInstances.length,
  }).catch((error) => {
    startupLog.warn("auto import broker positions failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  startupLog.info("initialize complete");
}
