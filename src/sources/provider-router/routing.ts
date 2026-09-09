import type { MarketDataRequestContext } from "../../types/data-provider";
import type { ProviderRouterCoreDeps } from "./route-types";
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
