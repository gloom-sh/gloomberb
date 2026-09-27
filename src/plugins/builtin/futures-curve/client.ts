import { apiClient } from "../../../api-client";
import type { FuturesCurvePayload } from "../../../api-client/futures-curve";
import { createPluginCache } from "../../../data/plugin-cache";
import { loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import { normalizeCurveRoot } from "./model";

export const futuresCurveCache = createPluginCache<FuturesCurvePayload>({
  kind: "futures-curve", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60_000, expireMs: 24 * 60 * 60_000 },
});
const finiteOrNull = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const date = (value: unknown) => timestamp(value) && new Date(value as string).toISOString().slice(0, 10) === value;
const rank = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

export function validateFuturesCurve(data: FuturesCurvePayload, root: string): FuturesCurvePayload {
  if (!data || data.root !== root || !Array.isArray(data.contracts) || !Array.isArray(data.ghosts)
    || !Array.isArray(data.gaps) || !data.gaps.every((gap) => typeof gap === "string")
    || !data.catalogue || !data.slope || !timestamp(data.fetchedAt)
    || data.asOf !== null && !timestamp(data.asOf)
    || !["yahoo", "cboe"].includes(data.source) || !["available", "partial", "unavailable"].includes(data.status)) {
    throw new Error("The server returned an invalid futures curve");
  }
  const symbols = new Set<string>();
  for (const row of data.contracts) {
    if (!row || typeof row.symbol !== "string" || !row.symbol || symbols.has(row.symbol)
      || typeof row.quoteUnit !== "string" || !row.quoteUnit
      || !date(row.expiration) || !finiteOrNull(row.price) || row.change !== undefined && !finiteOrNull(row.change)
      || typeof row.currency !== "string"
      || !rank(row.percentile) || !Number.isInteger(row.samples) || row.samples < 0
      || row.asOf !== null && !timestamp(row.asOf)
      || ![row.volume, row.openInterest, row.delayMinutes].every((value) => finiteOrNull(value) && (value === null || value >= 0))) {
      throw new Error("The server returned an invalid futures contract");
    }
    symbols.add(row.symbol);
  }
  for (const ghost of data.ghosts) {
    if (!["1W", "1M", "1Y"].includes(ghost.label) || !date(ghost.requestedDate)
      || ghost.asOf !== null && !date(ghost.asOf) || !Array.isArray(ghost.points)
      || ghost.points.some((point) => !point || !symbols.has(point.symbol) || !date(point.expiration)
        || !finiteOrNull(point.price) || point.asOf !== null && !date(point.asOf))) {
      throw new Error("The server returned invalid futures history");
    }
  }
  const slope = data.slope;
  if (![slope.value, slope.annualizedRollYield].every(finiteOrNull)
    || ![slope.percentile, slope.rollPercentile].every(rank) || !Number.isInteger(slope.samples) || slope.samples < 0
    || slope.asOf !== null && !timestamp(slope.asOf)) throw new Error("The server returned an invalid futures spread");
  return data;
}

export async function fetchFuturesCurve(root: string, client: Pick<typeof apiClient, "getCloudFuturesCurve"> = apiClient): Promise<FuturesCurvePayload> {
  const normalized = normalizeCurveRoot(root);
  if (!normalized) throw new Error(`Unsupported futures root: ${root}`);
  try { return validateFuturesCurve(await client.getCloudFuturesCurve(normalized), normalized); }
  catch (error) { throw unavailableOnServer(error, "Futures curves are not available yet."); }
}

export function getCachedFuturesCurve(root: string): FuturesCurvePayload | null {
  const cached = futuresCurveCache.get(root, { allowExpired: true });
  // The pane revalidates this copy on mount; only the source or a failed refresh makes it stale.
  return cached?.data ?? null;
}

export async function loadFuturesCurve(root: string, force = false): Promise<FuturesCurvePayload> {
  const { payload, stale, refreshError } = await loadCloudResource(futuresCurveCache, root, () => fetchFuturesCurve(root), { force });
  return { ...payload, stale: stale || payload.stale, gaps: [...payload.gaps, ...(refreshError ? [refreshError] : [])] };
}
