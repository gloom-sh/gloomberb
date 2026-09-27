import { apiClient } from "../../../api-client";
import type { RatePathPayload } from "../../../api-client/rates";
import { createPluginCache } from "../../../data/plugin-cache";
import { loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

export const ratePathCache = createPluginCache<RatePathPayload>({
  kind: "rate-path", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60_000, expireMs: 24 * 60 * 60_000 },
});

export function validateRatePath(payload: RatePathPayload): RatePathPayload {
  const numberOrNull = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
  if (!payload || !Array.isArray(payload.meetings) || !Array.isArray(payload.fedFunds)
    || !Array.isArray(payload.sofr) || !Array.isArray(payload.ghosts) || !Array.isArray(payload.gaps)
    || !payload.current?.effr || !payload.current.targetLower || !payload.current.targetUpper
    || !payload.dotPlot || !Array.isArray(payload.dotPlot.points) || !payload.schedule
    || !Number.isFinite(Date.parse(payload.fetchedAt))) {
    throw new Error("The server returned an invalid rate path");
  }
  for (const row of [...payload.meetings, ...payload.fedFunds, ...payload.sofr]) {
    if (!numberOrNull(row.impliedRate) || !numberOrNull(row.percentile) || !Number.isInteger(row.samples)) {
      throw new Error("The server returned an invalid rate observation");
    }
  }
  for (const meeting of payload.meetings) {
    const date = Date.parse(meeting.date);
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== meeting.date
      || !Array.isArray(meeting.probabilities)
      || meeting.probabilities.some((point) => !Number.isFinite(point.targetMidpoint)
        || !Number.isFinite(point.probability) || point.probability < 0 || point.probability > 1)
      || meeting.probabilities.length > 0 && Math.abs(meeting.probabilities.reduce((sum, point) => sum + point.probability, 0) - 1) > 1e-6) {
      throw new Error("The server returned invalid meeting probabilities");
    }
  }
  return payload;
}

export async function fetchRatePath(client: Pick<typeof apiClient, "getCloudRatePath"> = apiClient): Promise<RatePathPayload> {
  try { return validateRatePath(await client.getCloudRatePath()); }
  catch (error) { throw unavailableOnServer(error, "Rate path is not available yet."); }
}

export function getCachedRatePath(): RatePathPayload | null {
  const cached = ratePathCache.get("usd", { allowExpired: true });
  // The pane revalidates this copy on mount; only the source or a failed refresh makes it stale.
  return cached?.data ?? null;
}

export async function loadRatePath(force = false): Promise<RatePathPayload> {
  const { payload, stale, refreshError } = await loadCloudResource(ratePathCache, "usd", () => fetchRatePath(), { force });
  return { ...payload, stale: stale || payload.stale, gaps: [...payload.gaps, ...(refreshError ? [refreshError] : [])] };
}
