import type { BrokerAdapter } from "../types/broker";
import type { AppConfig, BrokerInstanceConfig } from "../types/config";
import type { Portfolio, TickerPosition, TickerRecord } from "../types/ticker";
import type { BrokerAccount } from "../types/trading";
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

/**
 * Whether a signed-in profile other than `instance` holds the portfolio. Its
 * account data there is current, so another profile of the same account (the
 * Flex statement it replaced) leaves the portfolio alone.
 */
export function isHeldByOtherSignedInProfile(
  config: AppConfig,
  portfolioId: string,
  instance: BrokerInstanceConfig,
): boolean {
  const ownerId = config.portfolios.find((portfolio) => portfolio.id === portfolioId)?.brokerInstanceId;
  const owner = getBrokerInstance(config.brokerInstances, ownerId);
  return !!owner && owner.id !== instance.id && isSignedInBrokerProfile(owner);
}

/**
 * The accounts `instance` reports that another enabled profile already holds
 * under the account's own number, such as IBKR U1234567 synced on this device
 * and linked through SnapTrade as well. That profile keeps the account, so its
 * portfolio and positions appear once.
 */
export function accountsHeldUnderOwnNumber(
  config: AppConfig,
  instance: BrokerInstanceConfig,
  accounts: readonly BrokerAccount[],
): Set<string> {
  const held = new Set(config.portfolios.flatMap((portfolio) => {
    if (!portfolio.brokerAccountId || portfolio.brokerInstanceId === instance.id) return [];
    const owner = getBrokerInstance(config.brokerInstances, portfolio.brokerInstanceId);
    return owner && owner.enabled !== false ? [portfolio.brokerAccountId.trim().toUpperCase()] : [];
  }));
  return new Set(accounts.flatMap((account) => {
    const number = account.brokerageAccountId?.trim().toUpperCase();
    return number && held.has(number) ? [account.accountId] : [];
  }));
}

/**
 * The accounts of `instance` to list: without those another enabled profile
 * holds under their own number (`accountsHeldUnderOwnNumber`), so an account
 * linked twice appears once wherever accounts are chosen or shown.
 */
export function accountsShownFor(
  config: AppConfig,
  instance: BrokerInstanceConfig,
  accounts: BrokerAccount[],
): BrokerAccount[] {
  const held = accountsHeldUnderOwnNumber(config, instance, accounts);
  return held.size ? accounts.filter((account) => !held.has(account.accountId)) : accounts;
}

/**
 * Who keeps a portfolio when the profile holding it is removed: another
 * enabled profile of the same broker that syncs the same account. Only a
 * hand-over to or from a signed-in profile (an account switching how it
 * connects) keeps the portfolio; otherwise it goes with its profile.
 */
export function findPortfolioHeir(
  config: AppConfig,
  removed: BrokerInstanceConfig,
  portfolio: Portfolio,
  brokers: ReadonlyMap<string, BrokerAdapter>,
  syncsAccount: (instance: BrokerInstanceConfig, accountId: string) => boolean,
): BrokerInstanceConfig | null {
  const accountId = portfolio.brokerAccountId;
  if (!accountId) return null;
  const brokerId = portfolio.brokerId ?? resolvePortfolioBrokerId(removed, brokers.get(removed.brokerType));
  return config.brokerInstances.find((candidate) =>
    candidate.id !== removed.id
    && candidate.enabled !== false
    && (isSignedInBrokerProfile(removed) || isSignedInBrokerProfile(candidate))
    && resolvePortfolioBrokerId(candidate, brokers.get(candidate.brokerType)) === brokerId
    && syncsAccount(candidate, accountId)
  ) ?? null;
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
  /**
   * Portfolios this sync writes. A position there without a profile came from
   * another device's sync of the same account, so this one replaces it too;
   * one entered by hand stays.
   */
  syncedPortfolioIds: ReadonlySet<string> = new Set(),
): TickerRecord | null {
  const positions = ticker.metadata.positions.filter((position) =>
    position.brokerInstanceId !== instanceId
    && !(takenOverPortfolioIds.has(position.portfolio) && position.brokerInstanceId)
    && !(syncedPortfolioIds.has(position.portfolio) && !position.brokerInstanceId && position.broker !== "manual")
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

/** The profile a broker portfolio id was made for: `broker:<profile>:<account>`. */
function brokerInstanceIdOfPortfolio(portfolioId: string): string | undefined {
  return isBrokerPortfolioId(portfolioId) ? portfolioId.split(":")[1] || undefined : undefined;
}

/** The broker portfolios and profiles that still exist somewhere this device knows of. */
export interface KnownBrokerHoldings {
  portfolioIds: ReadonlySet<string>;
  instanceIds: ReadonlySet<string>;
}

export function knownBrokerHoldings(
  ...sources: Array<{ portfolios?: ReadonlyArray<{ id: string }>; brokerInstances?: ReadonlyArray<{ id: string }> }>
): KnownBrokerHoldings {
  return {
    portfolioIds: new Set(sources.flatMap((source) => source.portfolios?.map((portfolio) => portfolio.id) ?? [])),
    instanceIds: new Set(sources.flatMap((source) => source.brokerInstances?.map((instance) => instance.id) ?? [])),
  };
}

/**
 * A broker portfolio that is gone, along with the profile it was made for. One
 * that still has its profile stays: that profile restores it on its next sync.
 */
function isGoneBrokerPortfolio(portfolioId: string, known: KnownBrokerHoldings): boolean {
  if (!isBrokerPortfolioId(portfolioId) || known.portfolioIds.has(portfolioId)) return false;
  const instanceId = brokerInstanceIdOfPortfolio(portfolioId);
  return !instanceId || !known.instanceIds.has(instanceId);
}

function isLeftoverBrokerPosition(position: TickerPosition, known: KnownBrokerHoldings): boolean {
  return isGoneBrokerPortfolio(position.portfolio, known)
    && !(position.brokerInstanceId && known.instanceIds.has(position.brokerInstanceId));
}

/**
 * The ticker without what removed broker profiles left on it: positions and
 * links in portfolios that are gone with their profile, and contracts of
 * profiles that are gone. A pull from another device brings such positions
 * without the profile that imported them, as a profile never leaves its
 * device, so nothing else ever clears them. Null when there is none.
 */
export function clearLeftoverBrokerHoldings(ticker: TickerRecord, known: KnownBrokerHoldings): TickerRecord | null {
  const { metadata } = ticker;
  const positions = metadata.positions.filter((position) => !isLeftoverBrokerPosition(position, known));
  const held = new Set(positions.map((position) => position.portfolio));
  const portfolios = metadata.portfolios.filter((portfolioId) => held.has(portfolioId) || !isGoneBrokerPortfolio(portfolioId, known));
  const contracts = metadata.broker_contracts ?? [];
  const brokerContracts = contracts.filter((contract) => !contract.brokerInstanceId || known.instanceIds.has(contract.brokerInstanceId));
  if (
    positions.length === metadata.positions.length
    && portfolios.length === metadata.portfolios.length
    && brokerContracts.length === contracts.length
  ) {
    return null;
  }
  return { ...ticker, metadata: { ...metadata, positions, portfolios, broker_contracts: brokerContracts } };
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
