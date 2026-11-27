import { apiClient } from "../../../api-client";
import type { SwapCurvePayload, SwapTenor } from "../../../api-client/swap-curve";
import { createPluginCache, savedCopyForTransientFailure, type PluginCacheResult } from "../../../data/plugin-cache";
import { stampRetrievedAt, withSavedCopyMarkOf } from "../../../data/saved-copies";
import { createCloudEndpoint } from "../shared/cloud-resource";
import { validateSwapCurve } from "./swaps-model";
import { loadCurveData, type CurveData, type CurveId } from "./curves";
import { loadWorldBoard, type WorldBoard } from "./world";

const swapCurveEndpoint = createCloudEndpoint<SwapTenor, SwapCurvePayload, Pick<typeof apiClient, "getCloudSwapCurve">>({
  kind: "sofr-swap-curve", schemaVersion: 1, policy: { staleMs: 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
  key: (tenor) => tenor, defaultClient: apiClient,
  fetch: (tenor, client) => client.getCloudSwapCurve(tenor, 365),
  validate: (payload, tenor) => {
    const valid = validateSwapCurve(payload);
    if (valid.history.tenor !== tenor) throw new Error("The server returned history for a different swap tenor");
    return valid;
  },
  unavailableMessage: "SOFR swap rates are not available yet.",
});
export const swapCurveCache = swapCurveEndpoint.cache;
export const fetchSwapCurve = (tenor: SwapTenor, client: Pick<typeof apiClient, "getCloudSwapCurve"> = apiClient) =>
  swapCurveEndpoint.fetch(tenor, { client });
export const getCachedSwapCurve = (tenor: SwapTenor) => swapCurveEndpoint.cached(tenor);
export const loadSwapCurve = (tenor: SwapTenor, force = false) => swapCurveEndpoint.load(tenor, { force });

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
export const worldCurvesCache = createPluginCache<WorldBoard>({
  kind: "world-curves", source: "gloom-cloud", schemaVersion: 2,
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
 * refusal (access denied, an unknown curve) or a reply that fails validation
 * is said rather than covered by the copy, as `loadCloudResource` does.
 */
function answer<T>(result: PluginCacheResult<T>): SavedCopyAnswer<T> {
  const saved = savedCopyForTransientFailure(result).source === "stale-fallback";
  const value = { data: result.data, savedAt: saved ? result.fetchedAt : null };
  return saved ? withSavedCopyMarkOf(value, result) : stampRetrievedAt(value, result.fetchedAt);
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

/**
 * Each market's latest curve, or its last on or before `requestedDate`; the
 * copy an earlier read of the same day saved when they cannot be read.
 */
export async function loadSavedWorldBoard(requestedDate = "", client?: Parameters<typeof loadWorldBoard>[0]): Promise<SavedCopyAnswer<WorldBoard>> {
  return answer(await worldCurvesCache.load(requestedDate || "latest", () => loadWorldBoard(client, requestedDate), { force: true }));
}

/** The saved world board for the day, for the tab's first paint while it is read again. */
export function cachedWorldBoard(requestedDate = ""): SavedCopyAnswer<WorldBoard> | null {
  const cached = worldCurvesCache.get(requestedDate || "latest", { allowExpired: true });
  return cached ? { data: cached.data, savedAt: null } : null;
}
