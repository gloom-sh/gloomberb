import type { BrokerInstanceConfig } from "gloomberb/types/config";
import type { CachePolicy } from "gloomberb/types/persistence";
import { normalizeIbkrConfig } from "./config";
import { fnv1aHashString } from "gloomberb/utils";

const FLEX_ACCOUNT_CACHE_POLICY = {
  staleMs: 6 * 60 * 60 * 1000,
  expireMs: 30 * 24 * 60 * 60 * 1000,
} as const satisfies CachePolicy;

const GATEWAY_ACCOUNT_CACHE_POLICY = {
  staleMs: 30 * 1000,
  expireMs: 7 * 24 * 60 * 60 * 1000,
} as const satisfies CachePolicy;

export function getIbkrAccountCacheSourceKey(instance: BrokerInstanceConfig): string {
  return fnv1aHashString(JSON.stringify(normalizeIbkrConfig(instance.config)));
}

export function getIbkrAccountCachePolicy(instance: BrokerInstanceConfig): CachePolicy {
  return normalizeIbkrConfig(instance.config).connectionMode === "gateway"
    ? GATEWAY_ACCOUNT_CACHE_POLICY
    : FLEX_ACCOUNT_CACHE_POLICY;
}
