import type { Dispatch } from "react";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import { findPaneInstance, isTickerPaneId, type AppConfig } from "../../types/config";
import type { CachedFinancialsTarget, DataProvider } from "../../types/data-provider";
import type { TickerFinancials } from "../../types/financials";
import type { BrokerAccount } from "../../types/trading";
import type { TickerMetadata, TickerRecord } from "../../types/ticker";
import type { AppAction, PaneRuntimeState } from "./context";
import type { AppSessionSnapshot } from "../../core/state/session-persistence";
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
  dispatch: Dispatch<AppAction>;
  primeCachedFinancials?: (entries: Array<{ ticker: TickerRecord; financials: TickerFinancials }>) => void;
  refreshTicker: (symbol: string, exchange?: string, tickerOverride?: TickerRecord | null, priority?: number) => void;
  refreshQuote: (symbol: string, exchange?: string, tickerOverride?: TickerRecord | null, priority?: number) => void;
  refreshTickersBatch?: (entries: Array<{ ticker: TickerRecord; priority: number }>) => void;
  refreshQuotesBatch?: (entries: Array<{ ticker: TickerRecord; priority: number }>) => void;
  autoImportBrokerPositions: (tickerMap: Map<string, TickerRecord>) => Promise<void>;
  persistedBrokerAccounts?: Record<string, BrokerAccount[]>;
}

function buildPaneStateSeed(
  config: AppConfig,
  tickers: TickerRecord[],
  tickerMap: Map<string, TickerRecord>,
  sessionSnapshot: AppSessionSnapshot | null | undefined,
): Record<string, StartupPaneStateSeed> {
  const seed: Record<string, StartupPaneStateSeed> = {};
  if (tickers.length === 0) return seed;

  for (const instance of config.layout.instances) {
    if (instance.paneId !== "portfolio-list") continue;
    const existingCursor = sessionSnapshot?.paneState?.[instance.instanceId]?.cursorSymbol;
    if (typeof existingCursor === "string" && tickerMap.has(existingCursor)) {
      seed[instance.instanceId] = { cursorSymbol: existingCursor };
      continue;
    }

    const collectionId = instance.params?.collectionId ?? config.portfolios[0]?.id ?? config.watchlists[0]?.id;
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

function resolveSymbolForPane(
  config: AppConfig,
  instanceId: string,
  paneStateSeed: Record<string, StartupPaneStateSeed>,
  sessionSnapshot: AppSessionSnapshot | null | undefined,
  tickerMap: Map<string, TickerRecord>,
  seen = new Set<string>(),
): string | null {
  if (seen.has(instanceId)) return null;
  seen.add(instanceId);

  const instance = findPaneInstance(config.layout, instanceId);
  if (!instance) return null;

  // Any pane can publish a cursor symbol; followers resolve through it.
  const cursor = paneStateSeed[instanceId]?.cursorSymbol
    ?? (typeof sessionSnapshot?.paneState?.[instanceId]?.cursorSymbol === "string"
      ? sessionSnapshot.paneState[instanceId]?.cursorSymbol as string
      : null);
  if (cursor) return tickerMap.has(cursor) ? cursor : null;

  if (instance.binding?.kind === "fixed") {
    return tickerMap.has(instance.binding.symbol) ? instance.binding.symbol : null;
  }

  if (instance.binding?.kind === "follow") {
    return resolveSymbolForPane(config, instance.binding.sourceInstanceId, paneStateSeed, sessionSnapshot, tickerMap, seen);
  }

  return null;
}

function buildRefreshPlan(
  config: AppConfig,
  tickerMap: Map<string, TickerRecord>,
  paneStateSeed: Record<string, StartupPaneStateSeed>,
  sessionSnapshot: AppSessionSnapshot | null | undefined,
): RefreshPlanEntry[] {
  const planBySymbol = new Map<string, RefreshPlanEntry>();

  const enqueueSymbol = (symbol: string | null, priority: number, mode: RefreshPlanEntry["mode"]) => {
    if (!symbol) return;
    const ticker = tickerMap.get(symbol);
    if (!ticker) return;

    const existing = planBySymbol.get(symbol);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      if (mode === "financials") {
        existing.mode = "financials";
      }
      return;
    }

    planBySymbol.set(symbol, { ticker, priority, mode });
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
    enqueueSymbol(
      resolveSymbolForPane(config, instanceId, paneStateSeed, sessionSnapshot, tickerMap),
      0,
      resolveWarmupMode(instance),
    );
  }

  for (const entry of config.layout.floating) {
    const instance = findPaneInstance(config.layout, entry.instanceId);
    enqueueSymbol(
      resolveSymbolForPane(config, entry.instanceId, paneStateSeed, sessionSnapshot, tickerMap),
      1,
      resolveWarmupMode(instance),
    );
  }

  let backgroundWarmups = 0;
  for (const target of sessionSnapshot?.hydrationTargets ?? []) {
    if (backgroundWarmups >= MAX_BACKGROUND_WARMUP_TICKERS) break;
    const before = planBySymbol.size;
    enqueueSymbol(target.symbol, 2, "financials");
    if (planBySymbol.size > before) {
      backgroundWarmups += 1;
    }
  }

  for (const symbol of config.recentTickers) {
    if (backgroundWarmups >= MAX_BACKGROUND_WARMUP_TICKERS) break;
    const before = planBySymbol.size;
    enqueueSymbol(symbol, 2, "quote");
    if (planBySymbol.size > before) {
      backgroundWarmups += 1;
    }
  }

  return [...planBySymbol.values()].sort((left, right) => left.priority - right.priority);
}

function buildCachedFinancialTarget(ticker: TickerRecord): CachedFinancialsTarget {
  const instrument = ticker.metadata.broker_contracts?.[0] ?? null;
  return {
    symbol: ticker.metadata.ticker,
    exchange: ticker.metadata.exchange,
    brokerId: instrument?.brokerId,
    brokerInstanceId: instrument?.brokerInstanceId,
    instrument,
  };
}

async function resolveCachedFinancialPrimeEntries(
  refreshPlan: RefreshPlanEntry[],
  sessionSnapshot: AppSessionSnapshot | null | undefined,
  tickerMap: Map<string, TickerRecord>,
  dataProvider: DataProvider,
): Promise<Array<{ ticker: TickerRecord; financials: TickerFinancials }>> {
  if (!dataProvider.getCachedFinancialsForTargets) return [];

  const targetEntriesBySymbol = new Map<string, { ticker: TickerRecord; target: CachedFinancialsTarget }>();
  for (const target of sessionSnapshot?.hydrationTargets ?? []) {
    const symbol = target.symbol.trim().toUpperCase();
    const ticker = tickerMap.get(symbol);
    if (ticker) {
      targetEntriesBySymbol.set(symbol, { ticker, target });
    }
  }

  for (const entry of refreshPlan.filter((entry) => entry.mode === "financials")) {
    const symbol = entry.ticker.metadata.ticker.trim().toUpperCase();
    if (!targetEntriesBySymbol.has(symbol)) {
      targetEntriesBySymbol.set(symbol, {
        ticker: entry.ticker,
        target: buildCachedFinancialTarget(entry.ticker),
      });
    }
  }

  const targetEntries = [...targetEntriesBySymbol.values()];
  if (targetEntries.length === 0) return [];
  const cachedFinancials = await dataProvider.getCachedFinancialsForTargets(
    targetEntries.map((entry) => entry.target),
    { includeStaleQuotes: true },
  );
  const primedEntries: Array<{ ticker: TickerRecord; financials: TickerFinancials }> = [];

  for (const entry of targetEntries) {
    const cached = cachedFinancials.get(entry.ticker.metadata.ticker.trim().toUpperCase());
    if (cached) {
      primedEntries.push({ ticker: entry.ticker, financials: cached });
    }
  }

  return primedEntries;
}

export async function initializeAppState({
  config,
  tickerRepository,
  dataProvider,
  sessionSnapshot,
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

  const paneStateSeed = measurePerf(
    "startup.build-pane-state-seed",
    () => buildPaneStateSeed(config, tickers, tickerMap, sessionSnapshot),
    { paneCount: config.layout.instances.length },
  );
  measurePerf("startup.dispatch-pane-state-seed", () => {
    for (const [paneId, patch] of Object.entries(paneStateSeed) as Array<[string, PaneRuntimeState]>) {
      dispatch({ type: "UPDATE_PANE_STATE", paneId, patch });
    }
  }, { paneStateSeedCount: Object.keys(paneStateSeed).length });

  const refreshPlan = measurePerf(
    "startup.build-refresh-plan",
    () => buildRefreshPlan(config, tickerMap, paneStateSeed, sessionSnapshot),
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

  if (primeCachedFinancials) {
    const cachedPrimeEntries = await measurePerfAsync(
      "startup.resolve-cached-financial-prime",
      () => resolveCachedFinancialPrimeEntries(refreshPlan, sessionSnapshot, tickerMap, dataProvider),
      {
        financialRefreshCount: refreshPlan.filter((entry) => entry.mode === "financials").length,
        sessionHydrationTargetCount: sessionSnapshot?.hydrationTargets.length ?? 0,
      },
    );
    if (cachedPrimeEntries.length > 0) {
      measurePerf("startup.prime-cached-financials", () => {
        primeCachedFinancials(cachedPrimeEntries);
      }, { count: cachedPrimeEntries.length });
      startupLog.info("cached financials primed", {
        count: cachedPrimeEntries.length,
        symbols: cachedPrimeEntries.map((entry) => entry.ticker.metadata.ticker),
      });
    }
  }

  measurePerf("startup.dispatch-initialized", () => {
    dispatch({ type: "SET_INITIALIZED" });
  });

  measurePerf("startup.enqueue-refresh-plan", () => {
    const financialEntries = refreshPlan.filter((entry) => entry.mode === "financials");
    const quoteEntries = refreshPlan.filter((entry) => entry.mode === "quote");
    if (refreshTickersBatch) {
      refreshTickersBatch(financialEntries.map((entry) => ({ ticker: entry.ticker, priority: entry.priority })));
    } else {
      for (const entry of financialEntries) {
        refreshTicker(entry.ticker.metadata.ticker, entry.ticker.metadata.exchange, entry.ticker, entry.priority);
      }
    }
    if (refreshQuotesBatch) {
      refreshQuotesBatch(quoteEntries.map((entry) => ({ ticker: entry.ticker, priority: entry.priority })));
    } else {
      for (const entry of quoteEntries) {
        refreshQuote(entry.ticker.metadata.ticker, entry.ticker.metadata.exchange, entry.ticker, entry.priority);
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
