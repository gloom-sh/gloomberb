import { apiClient } from "../../../api-client";
import type { SwapCurvePayload, SwapTenor } from "../../../api-client/swap-curve";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import { validateSwapCurve } from "./swaps-model";

export const swapCurveCache = createPluginCache<SwapCurvePayload>({
  kind: "sofr-swap-curve", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
});

export async function fetchSwapCurve(tenor: SwapTenor,
  client: Pick<typeof apiClient, "getCloudSwapCurve"> = apiClient): Promise<SwapCurvePayload> {
  try {
    const payload = validateSwapCurve(await client.getCloudSwapCurve(tenor, 365));
    if (payload.history.tenor !== tenor) throw new Error("The server returned history for a different swap tenor");
    return payload;
  } catch (error) {
    throw unavailableOnServer(error, "SOFR swap rates are not available yet.");
  }
}

export const getCachedSwapCurve = (tenor: SwapTenor) => cachedCloudResource(swapCurveCache, tenor, validateSwapCurve);
export const loadSwapCurve = (tenor: SwapTenor, force = false) =>
  loadCloudResource(swapCurveCache, tenor, () => fetchSwapCurve(tenor), { force, validate: validateSwapCurve });
