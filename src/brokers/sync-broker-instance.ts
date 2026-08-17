import type { AppResourceStorePort, AppTickerRepositoryPort } from "../core/app-service-ports";
import { persistBrokerAccounts } from "./account-cache";
import type { BrokerAdapter, BrokerPosition } from "../types/broker";
import type { AppConfig, BrokerInstanceConfig } from "../types/config";
import type { BrokerAccount } from "../types/trading";
import type { TickerRecord } from "../types/ticker";
import { getBrokerInstance } from "../utils/broker-instances";
import {
  clearBrokerInstanceTickerData,
  ensureBrokerPortfolio,
  findReusableBrokerPortfolioId,
  removeStaleBrokerPortfolios,
} from "./broker-portfolio-sync";
import {
  loadTickerMap,
  upsertBrokerPositionTicker,
} from "./broker-ticker-sync";

export { restoreBrokerPortfoliosFromTickerPositions } from "./broker-portfolio-sync";

export interface SyncBrokerInstanceArgs {
  config: AppConfig;
  instanceId: string;
  brokers: ReadonlyMap<string, BrokerAdapter>;
  tickerRepository: AppTickerRepositoryPort;
  existingTickers?: Map<string, TickerRecord>;
  resources?: AppResourceStorePort;
  persistResolvedBrokerConfig?: boolean;
  signal?: AbortSignal;
  deferPersistence?: boolean;
}

export interface SyncBrokerInstanceResult {
  config: AppConfig;
  tickers: Map<string, TickerRecord>;
  brokerAccounts: BrokerAccount[];
  positions: BrokerPosition[];
  portfolioIds: string[];
  addedTickers: TickerRecord[];
  updatedTickers: TickerRecord[];
  commit(): Promise<void>;
}

export interface SyncBrokerInstancesArgs {
  config: AppConfig;
  brokers: ReadonlyMap<string, BrokerAdapter>;
  tickerRepository: AppTickerRepositoryPort;
  existingTickers: Map<string, TickerRecord>;
  resources?: AppResourceStorePort;
  persistResolvedBrokerConfig?: boolean;
  onResult?: (result: SyncBrokerInstanceResult, instance: BrokerInstanceConfig, previousConfig: AppConfig) => void | Promise<void>;
}

export interface SyncBrokerInstancesResult {
  config: AppConfig;
  tickers: Map<string, TickerRecord>;
  results: SyncBrokerInstanceResult[];
  errors: Array<{ instanceId: string; error: unknown }>;
}

function markBrokerInstanceSynced(
  config: AppConfig,
  instanceId: string,
  syncedAt: number,
): AppConfig {
  return {
    ...config,
    brokerInstances: config.brokerInstances.map((entry) =>
      entry.id === instanceId ? { ...entry, lastSyncedAt: syncedAt } : entry
    ),
  };
}

function throwIfBrokerImportCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Broker import was cancelled.");
  }
}

async function maybePersistResolvedBrokerConfig(
  config: AppConfig,
  instance: BrokerInstanceConfig,
  broker: BrokerAdapter,
  persistResolvedBrokerConfig: boolean,
): Promise<AppConfig> {
  if (!persistResolvedBrokerConfig || !broker.getPersistedConfigUpdate) {
    return config;
  }

  const nextConfig = await broker.getPersistedConfigUpdate(instance);
  if (!nextConfig) {
    return config;
  }

  return {
    ...config,
    brokerInstances: config.brokerInstances.map((entry) =>
      entry.id === instance.id
        ? {
          ...entry,
          connectionMode: typeof nextConfig.connectionMode === "string" ? nextConfig.connectionMode : entry.connectionMode,
          config: {
            ...entry.config,
            ...nextConfig,
          },
        }
        : entry,
    ),
  };
}

export async function syncBrokerInstance({
  config,
  instanceId,
  brokers,
  tickerRepository,
  existingTickers,
  resources,
  persistResolvedBrokerConfig = false,
  signal,
  deferPersistence = false,
}: SyncBrokerInstanceArgs): Promise<SyncBrokerInstanceResult> {
  const instance = getBrokerInstance(config.brokerInstances, instanceId);
  if (!instance) {
    throw new Error(`Broker instance "${instanceId}" was not found.`);
  }
  if (instance.enabled === false) {
    throw new Error(`Broker instance "${instance.label}" is disabled.`);
  }

  const broker = brokers.get(instance.brokerType);
  if (!broker) {
    throw new Error(`Broker "${instance.brokerType}" is not available.`);
  }

  const valid = await broker.validate(instance).catch(() => false);
  throwIfBrokerImportCancelled(signal);
  if (!valid) {
    throw new Error(`${broker.name} setup is incomplete.`);
  }

  const tickers = await loadTickerMap(tickerRepository, existingTickers);
  throwIfBrokerImportCancelled(signal);

  let brokerAccounts: BrokerAccount[] = [];
  let positions: BrokerPosition[];
  if (broker.importPortfolioSnapshot) {
    const snapshot = await broker.importPortfolioSnapshot(instance);
    throwIfBrokerImportCancelled(signal);
    brokerAccounts = snapshot.accounts;
    positions = snapshot.positions;
  } else {
    if (broker.listAccounts) {
      try {
        brokerAccounts = await broker.listAccounts(instance);
        throwIfBrokerImportCancelled(signal);
      } catch (error) {
        throw error;
      }
    }
    positions = await broker.importPositions(instance);
    throwIfBrokerImportCancelled(signal);
  }

  const accountMetadata = new Map(
    brokerAccounts.map((account) => [
      account.accountId,
      {
        name: account.name || account.accountId,
        currency: account.currency || "USD",
      },
    ]),
  );

  const syncedAt = Date.now();

  let nextConfig = config;
  const accountIds = new Set<string>();
  for (const account of brokerAccounts) {
    if (account.accountId) {
      accountIds.add(account.accountId);
    }
  }
  for (const position of positions) {
    if (position.accountId) {
      accountIds.add(position.accountId);
    }
  }

  const portfolioIds: string[] = [];
  if (accountIds.size > 0) {
    for (const accountId of accountIds) {
      const portfolioId = findReusableBrokerPortfolioId(nextConfig, instance, accountId);
      const account = accountMetadata.get(accountId);
      nextConfig = ensureBrokerPortfolio(
        nextConfig,
        instance,
        portfolioId,
        account?.name || accountId,
        account?.currency || "USD",
        accountId,
        syncedAt,
      );
      portfolioIds.push(portfolioId);
    }
  } else {
    const defaultAccount = brokerAccounts[0];
    const portfolioId = findReusableBrokerPortfolioId(nextConfig, instance, defaultAccount?.accountId);
    const fallbackName = defaultAccount?.name || defaultAccount?.accountId || instance.label || broker.name;
    nextConfig = ensureBrokerPortfolio(
      nextConfig,
      instance,
      portfolioId,
      fallbackName,
      defaultAccount?.currency || "USD",
      defaultAccount?.accountId,
      syncedAt,
    );
    portfolioIds.push(portfolioId);
  }

  const currentPortfolioIds = new Set(portfolioIds);
  const brokerPortfolioIds = new Set([
    ...config.portfolios
      .filter((portfolio) => portfolio.brokerInstanceId === instance.id)
      .map((portfolio) => portfolio.id),
    ...portfolioIds,
  ]);

  nextConfig = removeStaleBrokerPortfolios(nextConfig, instance.id, currentPortfolioIds);
  const cleanedTickers = new Map<string, TickerRecord>();
  for (const ticker of tickers.values()) {
    const cleanedTicker = clearBrokerInstanceTickerData(ticker, instance.id, brokerPortfolioIds);
    if (!cleanedTicker) continue;
    tickers.set(cleanedTicker.metadata.ticker, cleanedTicker);
    cleanedTickers.set(cleanedTicker.metadata.ticker, cleanedTicker);
  }

  nextConfig = await maybePersistResolvedBrokerConfig(nextConfig, instance, broker, persistResolvedBrokerConfig);
  throwIfBrokerImportCancelled(signal);
  nextConfig = markBrokerInstanceSynced(nextConfig, instance.id, syncedAt);

  const addedTickers = new Map<string, TickerRecord>();
  const updatedTickers = new Map<string, TickerRecord>();

  for (const position of positions) {
    throwIfBrokerImportCancelled(signal);
    const portfolioId = findReusableBrokerPortfolioId(nextConfig, instance, position.accountId);
    const { ticker, created } = upsertBrokerPositionTicker({
      tickers,
      instance,
      portfolioId,
      position,
    });
    if (created) {
      addedTickers.set(position.ticker, ticker);
    } else {
      cleanedTickers.delete(ticker.metadata.ticker);
      if (!addedTickers.has(position.ticker)) {
        updatedTickers.set(position.ticker, ticker);
      }
    }

    tickers.set(position.ticker, ticker);
    if (addedTickers.has(position.ticker)) {
      addedTickers.set(position.ticker, ticker);
    } else {
      updatedTickers.set(position.ticker, ticker);
    }
  }

  for (const ticker of cleanedTickers.values()) {
    if (!addedTickers.has(ticker.metadata.ticker) && !updatedTickers.has(ticker.metadata.ticker)) {
      updatedTickers.set(ticker.metadata.ticker, ticker);
    }
  }

  let committed = false;
  const commit = async () => {
    if (committed) return;
    throwIfBrokerImportCancelled(signal);
    if (resources) {
      try {
        persistBrokerAccounts(resources, instance, broker, brokerAccounts);
      } catch {}
    }
    await Promise.all([...addedTickers.values(), ...updatedTickers.values()].map((ticker) => (
      tickerRepository.saveTicker(ticker)
    )));
    committed = true;
  };

  if (!deferPersistence) {
    await commit();
  }

  return {
    config: nextConfig,
    tickers,
    brokerAccounts,
    positions,
    portfolioIds,
    addedTickers: [...addedTickers.values()],
    updatedTickers: [...updatedTickers.values()],
    commit,
  };
}

export async function syncBrokerInstances({
  config,
  brokers,
  tickerRepository,
  existingTickers,
  resources,
  persistResolvedBrokerConfig = false,
  onResult,
}: SyncBrokerInstancesArgs): Promise<SyncBrokerInstancesResult> {
  let nextConfig = config;
  let nextTickers = new Map(existingTickers);
  const results: SyncBrokerInstanceResult[] = [];
  const errors: SyncBrokerInstancesResult["errors"] = [];

  for (const instance of config.brokerInstances) {
    if (instance.enabled === false) continue;

    const previousConfig = nextConfig;
    try {
      const result = await syncBrokerInstance({
        config: previousConfig,
        instanceId: instance.id,
        brokers,
        tickerRepository,
        existingTickers: nextTickers,
        resources,
        persistResolvedBrokerConfig,
      });

      nextConfig = result.config;
      nextTickers = result.tickers;
      results.push(result);
      await onResult?.(result, instance, previousConfig);
    } catch (error) {
      errors.push({ instanceId: instance.id, error });
    }
  }

  return {
    config: nextConfig,
    tickers: nextTickers,
    results,
    errors,
  };
}
