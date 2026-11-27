import { apiClient } from "../../../api-client";
import type { RatePathPayload } from "../../../api-client/rates";
import { unansweredRefreshError, withSavedCopyMarkOf } from "../../../data/saved-copies";
import { isCalendarDay, isFraction, isNullableFinite } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";

export function validateRatePath(payload: RatePathPayload): RatePathPayload {
  if (!payload || !Array.isArray(payload.meetings) || !Array.isArray(payload.fedFunds)
    || !Array.isArray(payload.sofr) || !Array.isArray(payload.ghosts) || !Array.isArray(payload.gaps)
    || !payload.current?.effr || !payload.current.targetLower || !payload.current.targetUpper
    || !payload.dotPlot || !Array.isArray(payload.dotPlot.points) || !payload.schedule
    || !Number.isFinite(Date.parse(payload.fetchedAt))) {
    throw new Error("The server returned an invalid rate path");
  }
  for (const row of [...payload.meetings, ...payload.fedFunds, ...payload.sofr]) {
    if (!isNullableFinite(row.impliedRate) || !isNullableFinite(row.percentile) || !Number.isInteger(row.samples)) {
      throw new Error("The server returned an invalid rate observation");
    }
  }
  for (const meeting of payload.meetings) {
    if (!isCalendarDay(meeting.date) || !Array.isArray(meeting.probabilities)
      || meeting.probabilities.some((point) => !Number.isFinite(point.targetMidpoint) || !isFraction(point.probability))
      || meeting.probabilities.length > 0 && Math.abs(meeting.probabilities.reduce((sum, point) => sum + point.probability, 0) - 1) > 1e-6) {
      throw new Error("The server returned invalid meeting probabilities");
    }
  }
  return payload;
}

const ratePathEndpoint = createCloudEndpoint<void, RatePathPayload, Pick<typeof apiClient, "getCloudRatePath">>({
  kind: "rate-path", schemaVersion: 1, policy: { staleMs: 60_000, expireMs: 24 * 60 * 60_000 },
  key: "usd", defaultClient: apiClient,
  fetch: (_args, client) => client.getCloudRatePath(), validate: validateRatePath,
  unavailableMessage: "Rate path is not available yet.",
});

export const ratePathCache = ratePathEndpoint.cache;
export const fetchRatePath = (client: Pick<typeof apiClient, "getCloudRatePath"> = apiClient) => ratePathEndpoint.fetch(undefined, { client });
export function getCachedRatePath(): RatePathPayload | null {
  // The pane revalidates this copy on mount; only the source or a failed refresh makes it stale.
  return ratePathCache.get("usd", { allowExpired: true })?.data ?? null;
}
export async function loadRatePath(force = false, client: Pick<typeof apiClient, "getCloudRatePath"> = apiClient): Promise<RatePathPayload> {
  const result = await ratePathEndpoint.load(undefined, { force, client });
  const { payload, stale } = result;
  const error = unansweredRefreshError(result);
  return withSavedCopyMarkOf({ ...payload, stale: stale || payload.stale, gaps: [...payload.gaps, ...error ? [error] : []] }, result);
}
