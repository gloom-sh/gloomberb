import { apiClient } from "../../../api-client";
import type { SwapCurvePayload, SwapTenor } from "../../../api-client/swap-curve";
import { isPermanentClientError } from "../../../api-client/errors";
import { createPluginCache, type PluginCacheResult } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import { validateSwapCurve } from "./swaps-model";
import { loadCurveData, type CurveData, type CurveId } from "./curves";
import { loadWorldRows, type WorldRow } from "./world";

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

const DAY_MS = 24 * 60 * 60_000;

/**
 * The Curve and World tabs' curves as last read, so a refresh that fails
 * (offline, a service error) shows the copy an earlier read saved instead of
 * an empty tab. Every load still asks the server; the copy is the fallback.
 */
export const curveViewCache = createPluginCache<CurveData>({
  kind: "yield-curve-view", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 15 * 60_000, expireMs: 30 * DAY_MS },
});
export const worldCurvesCache = createPluginCache<WorldRow[]>({
  kind: "world-curves", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 15 * 60_000, expireMs: 30 * DAY_MS },
});

/** What a tab shows, and when the copy shown was saved when it is one, its refresh having failed. */
export interface SavedCopyAnswer<T> {
  data: T;
  savedAt: number | null;
}

const curveKey = (curve: CurveId, requestedDate: string) => `${curve}:${requestedDate || "latest"}`;
/**
 * A copy is the saved one by where it came from, whatever its failure said. A
 * refusal asking again will not change (access denied, an unknown curve) is
 * said rather than covered by the copy, as `loadCloudResource` does.
 */
function answer<T>(result: PluginCacheResult<T>): SavedCopyAnswer<T> {
  const saved = result.source === "stale-fallback";
  if (saved && isPermanentClientError(result.error)) throw result.error;
  return { data: result.data, savedAt: saved ? result.fetchedAt : null };
}

/** The curve on the date (its latest without one), or the copy an earlier read saved when it cannot be read. */
export async function loadSavedCurve(curve: CurveId, requestedDate: string,
  client?: Parameters<typeof loadCurveData>[2]): Promise<SavedCopyAnswer<CurveData>> {
  return answer(await curveViewCache.load(curveKey(curve, requestedDate), () => loadCurveData(curve, requestedDate, client), { force: true }));
}

/** The saved curve, for the tab's first paint while it is read again. */
export function cachedCurve(curve: CurveId, requestedDate: string): SavedCopyAnswer<CurveData> | null {
  const cached = curveViewCache.get(curveKey(curve, requestedDate), { allowExpired: true });
  return cached ? { data: cached.data, savedAt: null } : null;
}

/** Each market's latest curve, or the copy an earlier read saved when they cannot be read. */
export async function loadSavedWorldRows(client?: Parameters<typeof loadWorldRows>[0]): Promise<SavedCopyAnswer<WorldRow[]>> {
  return answer(await worldCurvesCache.load("latest", () => loadWorldRows(client), { force: true }));
}

/** The saved world board, for the tab's first paint while it is read again. */
export function cachedWorldRows(): SavedCopyAnswer<WorldRow[]> | null {
  const cached = worldCurvesCache.get("latest", { allowExpired: true });
  return cached ? { data: cached.data, savedAt: null } : null;
}
