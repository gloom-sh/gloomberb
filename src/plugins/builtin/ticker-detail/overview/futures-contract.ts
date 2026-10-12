import { useCallback, useMemo } from "react";
import type { FuturesContractTermsPayload } from "../../../../api-client/futures-curve";
import { createPluginCache } from "../../../../data/plugin-cache";
import { loadFuturesContractTerms, validateFuturesContractTerms } from "../../../../market-data/futures-contract";
import { useAsyncResource, useAutoRefresh } from "../../../../public/react";
import { cachedCloudResource, loadCloudResource } from "../../shared/cloud-resource";

/** A day's settlement lands the morning after its session; the terms change only with a roll. */
const REFRESH_MS = 30 * 60_000;

export const futuresContractCache = createPluginCache<FuturesContractTermsPayload>({
  kind: "futures-contract", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: REFRESH_MS, expireMs: 7 * 24 * 60 * 60_000 },
});

/**
 * A futures symbol's contract terms and latest confirmed settlement, beside
 * the quote rather than in its way: the quote renders without them, a symbol
 * the server has no terms for (or a failed request) leaves them out, and a
 * cached copy shows at once while it is checked again.
 */
export function useFuturesContractTerms(symbol: string | null): FuturesContractTermsPayload | null {
  const loader = useCallback(async (force: boolean) => (await loadCloudResource(futuresContractCache, symbol!,
    () => loadFuturesContractTerms(symbol!), { force, validate: validateFuturesContractTerms })).payload, [symbol]);
  // Read once per symbol, not on every quote tick.
  const cached = useMemo(() => symbol ? cachedCloudResource(futuresContractCache, symbol, validateFuturesContractTerms)?.payload ?? null : null, [symbol]);
  const resource = useAsyncResource(symbol ? loader : null, { initialData: () => cached });
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: REFRESH_MS });
  // A pane that moves to another symbol shows its cached copy while the request runs, so the block does not blink.
  return symbol ? resource.data ?? (resource.loading ? cached : null) : null;
}
