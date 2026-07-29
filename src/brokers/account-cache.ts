import type { AppResourceStorePort } from "../core/app-service-ports";
import type { BrokerAdapter } from "../types/broker";
import type { BrokerInstanceConfig } from "../types/config";
import type { CachePolicy } from "../types/persistence";
import type { BrokerAccount } from "../types/trading";
import { fnv1aHashString } from "../utils/hash";

const BROKER_ACCOUNT_SNAPSHOT_KIND = "account-snapshot";
const BROKER_ACCOUNT_SNAPSHOT_SCHEMA_VERSION = 1;
const DEFAULT_BROKER_ACCOUNT_CACHE_POLICY = {
  staleMs: 6 * 60 * 60 * 1000,
  expireMs: 30 * 24 * 60 * 60 * 1000,
} as const satisfies CachePolicy;

interface PersistedBrokerAccountSnapshot {
  accounts: BrokerAccount[];
  brokerType?: string;
}

function brokerAccountNamespace(instance: BrokerInstanceConfig): string {
  return `plugin:${instance.brokerType}`;
}

export function getBrokerAccountCacheSourceKey(
  instance: BrokerInstanceConfig,
  broker?: BrokerAdapter | null,
): string {
  if (broker?.getAccountCacheSourceKey) {
    return broker.getAccountCacheSourceKey(instance);
  }
  return fnv1aHashString(JSON.stringify({
    brokerType: instance.brokerType,
    config: broker?.toConfigValues?.(instance) ?? instance.config,
  }));
}

function getBrokerAccountCachePolicy(
  instance: BrokerInstanceConfig,
  broker?: BrokerAdapter | null,
): CachePolicy {
  return broker?.getAccountCachePolicy?.(instance) ?? DEFAULT_BROKER_ACCOUNT_CACHE_POLICY;
}

function pruneMismatchedSnapshots(
  resources: AppResourceStorePort,
  instance: BrokerInstanceConfig,
  sourceKey: string,
): void {
  const records = resources.list<PersistedBrokerAccountSnapshot>({
    namespace: brokerAccountNamespace(instance),
    kind: BROKER_ACCOUNT_SNAPSHOT_KIND,
    entityKey: instance.id,
  }, {
    schemaVersion: BROKER_ACCOUNT_SNAPSHOT_SCHEMA_VERSION,
    allowExpired: true,
  });

  for (const record of records) {
    if (record.sourceKey === sourceKey) continue;
    resources.delete({
      namespace: brokerAccountNamespace(instance),
      kind: BROKER_ACCOUNT_SNAPSHOT_KIND,
      entityKey: instance.id,
      sourceKey: record.sourceKey,
    });
  }
}

export function loadPersistedBrokerAccounts(
  resources: AppResourceStorePort,
  instance: BrokerInstanceConfig,
  broker?: BrokerAdapter | null,
): BrokerAccount[] | null {
  const sourceKey = getBrokerAccountCacheSourceKey(instance, broker);
  pruneMismatchedSnapshots(resources, instance, sourceKey);

  return resources.get<PersistedBrokerAccountSnapshot>({
    namespace: brokerAccountNamespace(instance),
    kind: BROKER_ACCOUNT_SNAPSHOT_KIND,
    entityKey: instance.id,
    sourceKey,
  }, {
    schemaVersion: BROKER_ACCOUNT_SNAPSHOT_SCHEMA_VERSION,
  })?.value.accounts ?? null;
}

export function persistBrokerAccounts(
  resources: AppResourceStorePort,
  instance: BrokerInstanceConfig,
  broker: BrokerAdapter,
  accounts: BrokerAccount[],
): void {
  const sourceKey = getBrokerAccountCacheSourceKey(instance, broker);
  pruneMismatchedSnapshots(resources, instance, sourceKey);

  resources.set<PersistedBrokerAccountSnapshot>({
    namespace: brokerAccountNamespace(instance),
    kind: BROKER_ACCOUNT_SNAPSHOT_KIND,
    entityKey: instance.id,
    sourceKey,
  }, {
    brokerType: instance.brokerType,
    accounts,
  }, {
    schemaVersion: BROKER_ACCOUNT_SNAPSHOT_SCHEMA_VERSION,
    cachePolicy: getBrokerAccountCachePolicy(instance, broker),
  });
}

export function loadPersistedBrokerAccountMap(
  resources: AppResourceStorePort,
  brokerInstances: BrokerInstanceConfig[],
  brokers: ReadonlyMap<string, BrokerAdapter>,
): Record<string, BrokerAccount[]> {
  const accountMap: Record<string, BrokerAccount[]> = {};

  for (const instance of brokerInstances) {
    const broker = brokers.get(instance.brokerType);
    if (!broker?.listAccounts && !broker?.importPortfolioSnapshot) continue;
    const accounts = loadPersistedBrokerAccounts(resources, instance, broker);
    if (!accounts || accounts.length === 0) continue;
    accountMap[instance.id] = accounts;
  }

  return accountMap;
}

export function clearPersistedBrokerAccounts(
  resources: AppResourceStorePort,
  instance: BrokerInstanceConfig,
): void {
  const records = resources.list<PersistedBrokerAccountSnapshot>({
    namespace: brokerAccountNamespace(instance),
    kind: BROKER_ACCOUNT_SNAPSHOT_KIND,
    entityKey: instance.id,
  }, {
    schemaVersion: BROKER_ACCOUNT_SNAPSHOT_SCHEMA_VERSION,
    allowExpired: true,
  });

  for (const record of records) {
    resources.delete({
      namespace: brokerAccountNamespace(instance),
      kind: BROKER_ACCOUNT_SNAPSHOT_KIND,
      entityKey: instance.id,
      sourceKey: record.sourceKey,
    });
  }
}
