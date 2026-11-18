import type { ResourceStore } from "../../data/resource-store";
import type { BrokerAdapter } from "../../types/broker";
import type { DataProvider, MarketDataRequestContext } from "../../types/data-provider";
import type { BrokerContractRef } from "../../types/instrument";
import type { CachePolicy } from "../../types/persistence";
import type { BrokerCandidate } from "./brokers";
import type { ProviderRouterCachePolicyKey } from "./cache";

export interface SourceResult<T> {
  sourceKey: string;
  value: T;
}

export interface ProviderRouterCoreDeps {
  resources?: ResourceStore;
  getEntityKey(ticker: string, instrument?: BrokerContractRef | null): string;
  getTickerVariantCandidates(exchange?: string): string[];
  getBrokerCandidatesForContext(context?: MarketDataRequestContext, includeFallbackInstances?: boolean): BrokerCandidate[];
  getProviderSourceKeys(): string[];
  providersInPriorityOrder(): DataProvider[];
  brokerSourceKey(candidate: BrokerCandidate): string;
  providerSourceKey(provider: DataProvider): string;
  resolveBrokerPolicy(key: ProviderRouterCachePolicyKey, broker: BrokerAdapter): CachePolicy;
  resolveProviderPolicy(key: ProviderRouterCachePolicyKey, provider: DataProvider): CachePolicy;
  cacheResource<T>(
    kind: string,
    entityKey: string,
    variantKey: string,
    sourceKey: string,
    value: T,
    cachePolicy: CachePolicy,
  ): void;
  logProviderError(message: string): void;
}
