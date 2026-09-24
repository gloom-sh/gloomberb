import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { RatePathPayload } from "../../../api-client/rates";
import { createPluginCache } from "../../../data/plugin-cache";

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
    throw new Error("Gloom Cloud returned an invalid rate path");
  }
  for (const row of [...payload.meetings, ...payload.fedFunds, ...payload.sofr]) {
    if (!numberOrNull(row.impliedRate) || !numberOrNull(row.percentile) || !Number.isInteger(row.samples)) {
      throw new Error("Gloom Cloud returned an invalid rate observation");
    }
  }
  for (const meeting of payload.meetings) {
    const date = Date.parse(meeting.date);
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== meeting.date
      || !Array.isArray(meeting.probabilities)
      || meeting.probabilities.some((point) => !Number.isFinite(point.targetMidpoint)
        || !Number.isFinite(point.probability) || point.probability < 0 || point.probability > 1)
      || meeting.probabilities.length > 0 && Math.abs(meeting.probabilities.reduce((sum, point) => sum + point.probability, 0) - 1) > 1e-6) {
      throw new Error("Gloom Cloud returned invalid meeting probabilities");
    }
  }
  return payload;
}

export async function fetchRatePath(client: Pick<typeof apiClient, "getCloudRatePath"> = apiClient): Promise<RatePathPayload> {
  try { return validateRatePath(await client.getCloudRatePath()); }
  catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) {
      throw new Error("Rate path is not available on this Gloom Cloud server yet");
    }
    throw error;
  }
}

export function getCachedRatePath(): RatePathPayload | null {
  const cached = ratePathCache.get("usd", { allowExpired: true });
  // The pane revalidates this copy on mount; only the source or a failed refresh makes it stale.
  return cached?.data ?? null;
}

export async function loadRatePath(force = false): Promise<RatePathPayload> {
  const result = await ratePathCache.load("usd", () => fetchRatePath(), { force });
  if (result.error instanceof ApiRequestError && [401, 403].includes(result.error.status ?? 0)) throw result.error;
  return {
    ...result.data, stale: result.stale || result.data.stale,
    gaps: [...result.data.gaps, ...(result.refreshError ? [result.refreshError] : [])],
  };
}
