import type { ResourceStore } from "../../data/resource-store";
import type { BrokerInstanceConfig } from "../../types/config";
import type { CachePolicy } from "../../types/persistence";
import type { BrokerPortfolioPerformance } from "../../types/trading";
import { debugLog } from "../../utils/debug-log";
import { loadFlexStatement, parseFlexPortfolioPerformance } from "./flex";
import { normalizeIbkrConfig } from "./config";
import { fnv1aHashString } from "../../utils/hash";

const PERFORMANCE_LOG = debugLog.createLogger("ibkr-performance");
const PERFORMANCE_CACHE_KIND = "portfolio-performance";
const PERFORMANCE_CACHE_SCHEMA_VERSION = 1;
const PERFORMANCE_CACHE_POLICY = {
  staleMs: 15 * 60 * 1000,
  expireMs: 90 * 24 * 60 * 60 * 1000,
} as const satisfies CachePolicy;

let resourceStore: ResourceStore | null = null;

export function setIbkrPortfolioPerformanceResourceStore(store: ResourceStore | null): void {
  resourceStore = store;
}

function cacheKey(instance: BrokerInstanceConfig, accountId: string): string {
  return `${instance.id}:${accountId}`;
}

function cacheSourceKey(instance: BrokerInstanceConfig): string {
  const config = normalizeIbkrConfig(instance.config);
  return fnv1aHashString(JSON.stringify({
    connectionMode: config.connectionMode,
    flexQueryId: config.flex.queryId,
    flexEndpoint: config.flex.endpoint,
  }));
}

function normalizeCachedPerformance(
  value: BrokerPortfolioPerformance | undefined,
  stale: boolean,
): BrokerPortfolioPerformance | null {
  if (!value || value.source !== "flex") return null;
  return { ...value, stale };
}

function readCachedPerformance(
  instance: BrokerInstanceConfig,
  accountId: string,
  allowExpired = false,
): BrokerPortfolioPerformance | null {
  const record = resourceStore?.get<BrokerPortfolioPerformance>({
    namespace: "plugin:ibkr",
    kind: PERFORMANCE_CACHE_KIND,
    entityKey: cacheKey(instance, accountId),
    sourceKey: cacheSourceKey(instance),
  }, {
    schemaVersion: PERFORMANCE_CACHE_SCHEMA_VERSION,
    allowExpired,
  });
  return normalizeCachedPerformance(record?.value, Boolean(record && (record.stale || record.expired)));
}

function readAnyCachedPerformance(
  instance: BrokerInstanceConfig,
  accountId: string,
  allowExpired = false,
): BrokerPortfolioPerformance | null {
  const records = resourceStore?.list<BrokerPortfolioPerformance>({
    namespace: "plugin:ibkr",
    kind: PERFORMANCE_CACHE_KIND,
    entityKey: cacheKey(instance, accountId),
  }, {
    schemaVersion: PERFORMANCE_CACHE_SCHEMA_VERSION,
    allowExpired,
  });
  return normalizeCachedPerformance(records?.[0]?.value, true);
}

function writeCachedPerformance(
  instance: BrokerInstanceConfig,
  accountId: string,
  performance: BrokerPortfolioPerformance,
): void {
  resourceStore?.set<BrokerPortfolioPerformance>({
    namespace: "plugin:ibkr",
    kind: PERFORMANCE_CACHE_KIND,
    entityKey: cacheKey(instance, accountId),
    sourceKey: cacheSourceKey(instance),
  }, performance, {
    schemaVersion: PERFORMANCE_CACHE_SCHEMA_VERSION,
    cachePolicy: PERFORMANCE_CACHE_POLICY,
  });
}

async function loadFreshFlexPerformance(
  instance: BrokerInstanceConfig,
  accountId: string,
): Promise<BrokerPortfolioPerformance | null> {
  const config = normalizeIbkrConfig(instance.config);
  if (config.connectionMode !== "flex") return null;

  const xml = await loadFlexStatement(config.flex);
  return parseFlexPortfolioPerformance(xml, accountId, Date.now());
}

export async function getIbkrPortfolioPerformance(
  instance: BrokerInstanceConfig,
  accountId: string,
): Promise<BrokerPortfolioPerformance | null> {
  const cached = readCachedPerformance(instance, accountId);
  if (cached && !cached.stale) return cached;

  try {
    const fresh = await loadFreshFlexPerformance(instance, accountId);
    if (fresh) {
      writeCachedPerformance(instance, accountId, fresh);
      return fresh;
    }
  } catch (error) {
    PERFORMANCE_LOG.warn("Unable to refresh IBKR Flex portfolio performance", {
      instanceId: instance.id,
      accountId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return cached
    ?? readCachedPerformance(instance, accountId, true)
    ?? readAnyCachedPerformance(instance, accountId, true);
}
