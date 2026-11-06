import { apiClient } from "../../../api-client";
import { isAccessDenied } from "../../../api-client/errors";
import type {
  CloudSocialOutliersParams,
  SocialOutlierCap,
  SocialOutliersPayload,
  SocialOutlierWindow,
} from "../../../api-client/social-mentions";
import { createPluginCache } from "../../../data/plugin-cache";
import type { HeadlessPaneApiClient } from "../../../types/plugin";
import { cachedCloudResource, loadCloudResource, unavailableOnServer, type CloudResource } from "../shared/cloud-resource";
import { CLOUD_SESSION_REQUIRED } from "../shared/research-cloud-session";

/** What the ranking reads: a window and the filters. */
export interface SocialOutliersQuery {
  window: SocialOutlierWindow;
  /** Least posts on the day counted; 0 for any. */
  minPosts: number;
  cap: SocialOutlierCap | null;
}

/** A few posts against a median of one reads as a jump of several times; the ranking starts past them. */
const DEFAULT_SOCIAL_OUTLIER_MIN_POSTS = 25;
export const DEFAULT_SOCIAL_OUTLIERS_QUERY: SocialOutliersQuery = { window: "day", minPosts: DEFAULT_SOCIAL_OUTLIER_MIN_POSTS, cap: null };
/** Tickers the pane ranks: read from the top, as INS's ranking is. */
export const SOCIAL_OUTLIER_PANE_ROWS = 100;
const SOCIAL_OUTLIERS_NOT_AVAILABLE = "Social outliers are not available yet.";

export const socialOutliersCache = createPluginCache<SocialOutliersPayload>({
  kind: "social-outliers",
  source: "gloom-cloud",
  schemaVersion: 1,
  // Closed days are counted after midnight UTC and today's counts through the day.
  policy: { staleMs: 15 * 60_000, expireMs: 2 * 86_400_000 },
});

const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const time = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));

/** A ranking the pane can draw; anything else is an error, never a table with holes. */
function validateSocialOutliers(payload: SocialOutliersPayload): SocialOutliersPayload {
  const valid = !!payload && (payload.window === "day" || payload.window === "today") && time(payload.asOf) && day(payload.freshFrom)
    && !!payload.coverage && finite(payload.coverage.tracked) && finite(payload.coverage.counted)
    && Array.isArray(payload.rows) && payload.rows.every((row) => !!row
      && typeof row.symbol === "string" && /^[A-Z][A-Z0-9]{0,5}$/.test(row.symbol)
      && (row.name === null || typeof row.name === "string") && day(row.day)
      && Number.isInteger(row.mentions) && row.mentions >= 0 && typeof row.closed === "boolean" && time(row.countedAt)
      && finite(row.baseline) && row.baseline >= 0 && finite(row.ratio) && row.ratio >= 0
      && (row.stance === null || finite(row.stance) && row.stance >= -1 && row.stance <= 1) && Number.isInteger(row.stancePosts)
      && (row.marketCap === null || finite(row.marketCap))
      && (row.price === null || !!row.price && finite(row.price.changePct) && typeof row.price.asOf === "string"));
  if (!valid) throw new Error("Social outliers could not be read.");
  return payload;
}

function outliersParams(query: SocialOutliersQuery, limit: number): CloudSocialOutliersParams {
  return {
    window: query.window,
    ...(query.minPosts > 0 ? { minPosts: query.minPosts } : {}),
    ...(query.cap ? { cap: query.cap } : {}),
    limit,
  };
}

const cacheKey = (query: SocialOutliersQuery, limit: number) => [query.window, query.minPosts, query.cap ?? "-", limit].join(":");

export function cachedSocialOutliers(query: SocialOutliersQuery, limit = SOCIAL_OUTLIER_PANE_ROWS): CloudResource<SocialOutliersPayload> | null {
  return cachedCloudResource(socialOutliersCache, cacheKey(query, limit), validateSocialOutliers);
}

export async function loadSocialOutliers(
  query: SocialOutliersQuery,
  {
    limit = SOCIAL_OUTLIER_PANE_ROWS,
    force = false,
    client = apiClient,
    signal,
  }: {
    limit?: number;
    force?: boolean;
    client?: Pick<HeadlessPaneApiClient, "getCloudSocialOutliers">;
    signal?: AbortSignal;
  } = {},
): Promise<CloudResource<SocialOutliersPayload>> {
  return loadCloudResource(
    socialOutliersCache,
    cacheKey(query, limit),
    () => client.getCloudSocialOutliers(outliersParams(query, limit), { signal }).catch((error: unknown) => {
      // A refused session is the pane's sign-in wall, keyed on the shared gate.
      if (isAccessDenied(error)) throw new Error(CLOUD_SESSION_REQUIRED, { cause: error });
      throw unavailableOnServer(error, SOCIAL_OUTLIERS_NOT_AVAILABLE);
    }),
    { force, validate: validateSocialOutliers, signal },
  );
}
