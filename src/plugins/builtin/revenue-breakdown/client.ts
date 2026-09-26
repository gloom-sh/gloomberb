import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type {
  RevenueBreakdownPayload,
  RevenueBreakdownView,
} from "../../../api-client/revenue-breakdown";
import { createPluginCache } from "../../../data/plugin-cache";

/**
 * Revenue by product, segment or region comes from Gloom Cloud, which reads
 * it out of each 10-Q and 10-K. A quarter changes only when a filing lands,
 * so a result stays fresh for an hour; the plan is part of the key because a
 * preview and the full split are different answers.
 */
export const revenueBreakdownCache = createPluginCache<RevenueBreakdownPayload>({
  kind: "revenue-breakdown",
  source: "gloom-cloud",
  schemaVersion: 1,
  policy: { staleMs: 60 * 60_000, expireMs: 30 * 86_400_000 },
});

export const REVENUE_VIEWS: RevenueBreakdownView[] = ["product", "segment", "region"];

/** Thrown when the company files no breakdown; the pane shows it as empty, not failed. */
export const NO_BREAKDOWN = "No revenue breakdown in this company's filings.";

const finiteOrNull = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const day = (value: unknown) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

export function validateRevenueBreakdown(data: RevenueBreakdownPayload): RevenueBreakdownPayload {
  const width = data?.periods?.length;
  const valid =
    !!data
    && REVENUE_VIEWS.includes(data.view)
    && Array.isArray(data.views)
    && data.views.every((view) => REVENUE_VIEWS.includes(view))
    && (data.access === "full" || data.access === "preview")
    && Number.isInteger(data.lockedRows) && data.lockedRows >= 0
    && Array.isArray(data.periods) && width > 0
    && data.periods.every((period) =>
      day(period?.end)
      && Number.isInteger(period.fiscalYear)
      && Number.isInteger(period.fiscalQuarter)
      && period.fiscalQuarter >= 1 && period.fiscalQuarter <= 4)
    && Array.isArray(data.total) && data.total.length === width && data.total.every(finiteOrNull)
    && Array.isArray(data.rows)
    && data.rows.every((row) =>
      typeof row?.key === "string"
      && typeof row.label === "string"
      && Array.isArray(row.values) && row.values.length === width && row.values.every(finiteOrNull)
      && finiteOrNull(row.ttm) && finiteOrNull(row.yoy) && finiteOrNull(row.share));
  if (!valid) throw new Error("Gloom Cloud returned an unreadable revenue breakdown");
  return data;
}

export async function fetchRevenueBreakdown(
  symbol: string,
  view: RevenueBreakdownView,
  client: Pick<typeof apiClient, "getCloudRevenueBreakdown"> = apiClient,
): Promise<RevenueBreakdownPayload> {
  try {
    return validateRevenueBreakdown(await client.getCloudRevenueBreakdown(symbol, view));
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) throw new Error(NO_BREAKDOWN);
    throw error;
  }
}

export interface RevenueResource {
  payload: RevenueBreakdownPayload;
  stale: boolean;
  refreshError: string | null;
}

const cacheKey = (symbol: string, view: RevenueBreakdownView, pro: boolean) =>
  `${symbol.toUpperCase()}:${view}:${pro ? "full" : "preview"}`;

// Seeds the first paint while the mount load runs; cache age is not staleness,
// and a failed refresh reports its own.
export function cachedRevenueBreakdown(
  symbol: string,
  view: RevenueBreakdownView,
  pro: boolean,
): RevenueResource | null {
  const cached = revenueBreakdownCache.get(cacheKey(symbol, view, pro), { allowExpired: true });
  if (!cached) return null;
  try {
    return { payload: validateRevenueBreakdown(cached.data), stale: false, refreshError: null };
  } catch {
    return null;
  }
}

export async function loadRevenueBreakdown(
  symbol: string,
  view: RevenueBreakdownView,
  pro: boolean,
  force = false,
): Promise<RevenueResource> {
  const result = await revenueBreakdownCache.load(
    cacheKey(symbol, view, pro),
    () => fetchRevenueBreakdown(symbol, view),
    { force },
  );
  // A company that stopped reporting a breakdown must not keep showing an old one.
  if (result.error instanceof Error && result.error.message === NO_BREAKDOWN) throw result.error;
  return {
    payload: validateRevenueBreakdown(result.data),
    stale: result.stale,
    refreshError: result.refreshError ?? null,
  };
}
