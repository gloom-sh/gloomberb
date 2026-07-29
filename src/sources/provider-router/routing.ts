import type { DataProvider, MarketDataRequestContext } from "../../types/data-provider";
import { shouldLogProviderError } from "../provider-errors";
import type { ProviderRouterCoreDeps, SourceResult } from "./route-types";
import { buildVariantKey } from "./cache";

export interface RouterRequestIdentity {
  kind: string;
  entityKey: string;
  variantKey: string;
  revalidationKey: string;
}

export function makeRouterRequestIdentity(
  deps: Pick<ProviderRouterCoreDeps, "getEntityKey">,
  input: {
    kind: string;
    ticker: string;
    context?: MarketDataRequestContext;
    variantParts?: Array<[string, string | number | undefined | null]>;
  },
): RouterRequestIdentity {
  const entityKey = deps.getEntityKey(input.ticker, input.context?.instrument);
  const variantKey = buildVariantKey(input.variantParts ?? []);
  return {
    kind: input.kind,
    entityKey,
    variantKey,
    revalidationKey: [input.kind, entityKey, variantKey].join("|"),
  };
}

export function scheduleRouterRevalidation(
  inFlight: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<void>,
): void {
  if (inFlight.has(key)) return;
  const promise = task()
    .catch(() => {})
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
}

export async function firstProviderResult<T>(
  deps: Pick<ProviderRouterCoreDeps, "providersInPriorityOrder" | "providerSourceKey" | "logProviderError">,
  fn: (provider: DataProvider) => Promise<T | null | undefined>,
): Promise<SourceResult<T> | null> {
  for (const provider of deps.providersInPriorityOrder()) {
    try {
      const result = await fn(provider);
      if (result != null) return { sourceKey: deps.providerSourceKey(provider), value: result };
    } catch (err) {
      if (shouldLogProviderError(err)) {
        deps.logProviderError(`${provider.id} failed: ${err}`);
      }
    }
  }
  return null;
}

export function resolveProviderBySourceKey(
  deps: Pick<ProviderRouterCoreDeps, "providersInPriorityOrder" | "providerSourceKey">,
  sourceKey: string,
): DataProvider | null {
  for (const provider of deps.providersInPriorityOrder()) {
    if (deps.providerSourceKey(provider) === sourceKey) return provider;
  }
  return null;
}
