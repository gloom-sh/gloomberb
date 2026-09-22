import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { FuturesCurvePayload } from "../../../api-client/futures-curve";
import { createPluginCache } from "../../../data/plugin-cache";
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
    throw new Error("Gloom Cloud returned an invalid futures curve");
  }
  const symbols = new Set<string>();
  for (const row of data.contracts) {
    if (!row || typeof row.symbol !== "string" || !row.symbol || symbols.has(row.symbol)
      || typeof row.quoteUnit !== "string" || !row.quoteUnit
      || !date(row.expiration) || !finiteOrNull(row.price) || typeof row.currency !== "string"
      || !rank(row.percentile) || !Number.isInteger(row.samples) || row.samples < 0
      || row.asOf !== null && !timestamp(row.asOf)
      || ![row.volume, row.openInterest, row.delayMinutes].every((value) => finiteOrNull(value) && (value === null || value >= 0))) {
      throw new Error("Gloom Cloud returned an invalid futures contract");
    }
    symbols.add(row.symbol);
  }
  for (const ghost of data.ghosts) {
    if (!["1W", "1M", "1Y"].includes(ghost.label) || !date(ghost.requestedDate)
      || ghost.asOf !== null && !date(ghost.asOf) || !Array.isArray(ghost.points)
      || ghost.points.some((point) => !point || !symbols.has(point.symbol) || !date(point.expiration)
        || !finiteOrNull(point.price) || point.asOf !== null && !date(point.asOf))) {
      throw new Error("Gloom Cloud returned invalid futures history");
    }
  }
  const slope = data.slope;
  if (![slope.value, slope.annualizedRollYield].every(finiteOrNull)
    || ![slope.percentile, slope.rollPercentile].every(rank) || !Number.isInteger(slope.samples) || slope.samples < 0
    || slope.asOf !== null && !timestamp(slope.asOf)) throw new Error("Gloom Cloud returned an invalid futures spread");
  return data;
}

export async function fetchFuturesCurve(root: string, client: Pick<typeof apiClient, "getCloudFuturesCurve"> = apiClient): Promise<FuturesCurvePayload> {
  const normalized = normalizeCurveRoot(root);
  if (!normalized) throw new Error(`Unsupported futures root: ${root}`);
  try { return validateFuturesCurve(await client.getCloudFuturesCurve(normalized), normalized); }
  catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) throw new Error("Futures curves are not available on this Gloom Cloud server yet");
    throw error;
  }
}

export function getCachedFuturesCurve(root: string): FuturesCurvePayload | null {
  const cached = futuresCurveCache.get(root, { allowExpired: true });
  return cached ? { ...cached.data, stale: cached.data.stale || cached.stale } : null;
}

export async function loadFuturesCurve(root: string, force = false): Promise<FuturesCurvePayload> {
  const result = await futuresCurveCache.load(root, () => fetchFuturesCurve(root), { force });
  if (result.error instanceof ApiRequestError && [401, 403].includes(result.error.status ?? 0)) throw result.error;
  return { ...result.data, stale: result.stale || result.data.stale,
    gaps: [...result.data.gaps, ...(result.refreshError ? [result.refreshError] : [])] };
}
