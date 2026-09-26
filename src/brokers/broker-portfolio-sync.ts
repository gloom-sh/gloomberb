import type { BrokerAdapter } from "../types/broker";
import type { AppConfig, BrokerInstanceConfig } from "../types/config";
import type { Portfolio, TickerPosition, TickerRecord } from "../types/ticker";
import { buildBrokerPortfolioId, getBrokerInstance, isBrokerPortfolioId } from "../utils/broker-instances";
import { isSignedInBrokerProfile } from "./signed-in/profile";

/**
 * The broker a profile's portfolios belong to. A signed-in IBKR profile answers
 * "ibkr", so it finds the portfolio an IBKR Flex or Gateway profile made.
 */
export function resolvePortfolioBrokerId(instance: BrokerInstanceConfig, adapter?: BrokerAdapter | null): string {
  return adapter?.portfolioBrokerId?.(instance) ?? instance.brokerType;
}

function getInstanceMode(instance: BrokerInstanceConfig): string {
  return typeof instance.connectionMode === "string"
    ? instance.connectionMode
    : typeof instance.config.connectionMode === "string"
      ? instance.config.connectionMode
      : "";
}

function findBrokerInstanceMode(config: AppConfig, instanceId: string | undefined): string {
  const instance = config.brokerInstances.find((entry) => entry.id === instanceId);
  return instance ? getInstanceMode(instance) : "";
}

/**
 * Whether `next` takes the portfolio over: a live Gateway beats anything else,
 * signing in replaces a Flex statement, and a portfolio whose profile is gone
 * goes to whoever syncs it. Otherwise the portfolio stays where it is, so
 * removing the old profile later does not take the portfolio with it.
 */
function shouldPreferBrokerInstance(config: AppConfig, current: Portfolio, next: BrokerInstanceConfig): boolean {
  if (current.brokerInstanceId === next.id) return false;
  if (!getBrokerInstance(config.brokerInstances, current.brokerInstanceId)) return true;
  const currentMode = findBrokerInstanceMode(config, current.brokerInstanceId);
  const nextMode = getInstanceMode(next);
  if (nextMode === "gateway" && currentMode !== "gateway") return true;
  return isSignedInBrokerProfile(next) && currentMode === "flex";
}

function updateBrokerPortfolioSource(
  config: AppConfig,
  portfolio: Portfolio,
  instance: BrokerInstanceConfig,
  brokerId: string,
  brokerAccountId?: string,
  syncedAt?: number,
): Portfolio {
  const lastSyncedAt = syncedAt ?? portfolio.lastSyncedAt;
  if (
    !shouldPreferBrokerInstance(config, portfolio, instance)
    && portfolio.brokerId
    && portfolio.brokerAccountId
    && portfolio.brokerInstanceId
    && portfolio.lastSyncedAt === lastSyncedAt
  ) {
    return portfolio;
  }

  return {
    ...portfolio,
    brokerId: portfolio.brokerId ?? brokerId,
    brokerInstanceId: shouldPreferBrokerInstance(config, portfolio, instance)
      ? instance.id
      : portfolio.brokerInstanceId ?? instance.id,
    brokerAccountId: portfolio.brokerAccountId ?? brokerAccountId,
    lastSyncedAt,
  };
}

export function ensureBrokerPortfolio(
  config: AppConfig,
  instance: BrokerInstanceConfig,
  portfolioId: string,
  name: string,
  currency: string,
  brokerAccountId?: string,
  syncedAt?: number,
  brokerId = instance.brokerType,
): AppConfig {
  const existing = config.portfolios.find((portfolio) => portfolio.id === portfolioId);
  if (existing) {
    const updated = updateBrokerPortfolioSource(config, existing, instance, brokerId, brokerAccountId, syncedAt);
    return updated === existing
      ? config
      : {
        ...config,
        portfolios: config.portfolios.map((portfolio) => portfolio.id === portfolioId ? updated : portfolio),
      };
  }

  return {
    ...config,
    portfolios: [
      ...config.portfolios,
      {
        id: portfolioId,
        name,
        currency,
        brokerId,
        brokerInstanceId: instance.id,
        brokerAccountId,
        lastSyncedAt: syncedAt,
      },
    ],
  };
}

export function findReusableBrokerPortfolioId(
  config: AppConfig,
  instance: BrokerInstanceConfig,
  accountId: string | undefined,
  brokerId = instance.brokerType,
): string {
  if (!accountId) return buildBrokerPortfolioId(instance.id, accountId);
  const existing = config.portfolios.find((portfolio) =>
    portfolio.brokerId === brokerId
    && portfolio.brokerAccountId === accountId
  );
  return existing?.id ?? buildBrokerPortfolioId(instance.id, accountId);
}

export function removeStaleBrokerPortfolios(
  config: AppConfig,
  instanceId: string,
  currentPortfolioIds: Set<string>,
): AppConfig {
  const portfolios = config.portfolios.filter((portfolio) =>
    portfolio.brokerInstanceId !== instanceId || currentPortfolioIds.has(portfolio.id)
  );
  return portfolios.length === config.portfolios.length
    ? config
    : { ...config, portfolios };
}

export function clearBrokerInstanceTickerData(
  ticker: TickerRecord,
  instanceId: string,
  brokerPortfolioIds: Set<string>,
  /** Portfolios this profile just took over: whatever another profile imported there goes too. */
  takenOverPortfolioIds: ReadonlySet<string> = new Set(),
): TickerRecord | null {
  const positions = ticker.metadata.positions.filter((position) =>
    position.brokerInstanceId !== instanceId
    && !(takenOverPortfolioIds.has(position.portfolio) && position.brokerInstanceId)
  );
  const remainingPositionPortfolios = new Set(positions.map((position) => position.portfolio));
  const portfolios = ticker.metadata.portfolios.filter((portfolioId) =>
    !brokerPortfolioIds.has(portfolioId) || remainingPositionPortfolios.has(portfolioId)
  );
  const brokerContracts = (ticker.metadata.broker_contracts ?? []).filter((contract) => contract.brokerInstanceId !== instanceId);

  if (
    positions.length === ticker.metadata.positions.length
    && portfolios.length === ticker.metadata.portfolios.length
    && brokerContracts.length === (ticker.metadata.broker_contracts ?? []).length
  ) {
    return null;
  }

  return {
    ...ticker,
    metadata: {
      ...ticker.metadata,
      positions,
      portfolios,
      broker_contracts: brokerContracts,
    },
  };
}

function inferBrokerAccountId(position: TickerPosition, portfolioId: string, instanceId: string): string | undefined {
  if (position.brokerAccountId) return position.brokerAccountId;
  const prefix = `broker:${instanceId}:`;
  if (!portfolioId.startsWith(prefix)) return undefined;
  const accountId = portfolioId.slice(prefix.length).trim();
  return accountId && accountId !== "default" ? accountId : undefined;
}

export function restoreBrokerPortfoliosFromTickerPositions(
  config: AppConfig,
  tickers: Iterable<TickerRecord>,
  brokers?: ReadonlyMap<string, BrokerAdapter>,
): AppConfig {
  let nextConfig = config;
  const knownPortfolioIds = new Set(config.portfolios.map((portfolio) => portfolio.id));

  for (const ticker of tickers) {
    for (const position of ticker.metadata.positions) {
      if (!position.brokerInstanceId || !isBrokerPortfolioId(position.portfolio)) continue;
      if (knownPortfolioIds.has(position.portfolio)) continue;

      const instance = getBrokerInstance(config.brokerInstances, position.brokerInstanceId);
      if (!instance) continue;

      const brokerAccountId = inferBrokerAccountId(position, position.portfolio, instance.id);
      nextConfig = ensureBrokerPortfolio(
        nextConfig,
        instance,
        position.portfolio,
        brokerAccountId || instance.label || instance.brokerType,
        position.currency || config.baseCurrency,
        brokerAccountId,
        undefined,
        resolvePortfolioBrokerId(instance, brokers?.get(instance.brokerType)),
      );
      knownPortfolioIds.add(position.portfolio);
    }
  }

  return nextConfig;
}
