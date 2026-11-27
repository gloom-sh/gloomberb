import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type {
  RevenueBreakdownPayload,
  RevenueBreakdownPeriod,
  RevenueBreakdownView,
} from "../../../api-client/revenue-breakdown";
import type { IssuerListingParams } from "../../../api-client/paths";
import { isNonNegativeInt, isNullableFinite } from "../../../utils/guards";
import { secListingKey } from "../../../utils/sec";
import { createCloudEndpoint, type CloudResource } from "../shared/cloud-resource";

export const REVENUE_VIEWS: RevenueBreakdownView[] = ["product", "segment", "region"];

/** Thrown when the company files no breakdown; the pane shows it as empty, not failed. */
export const NO_BREAKDOWN = "No revenue breakdown in this company's filings.";

const day = (value: unknown) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const hkexFilingUrl = /^https:\/\/(?:www1?\.)?hkexnews\.hk\/listedco\/listconews\/sehk\/\d{4}\/\d{4}\/\d{13}\.pdf(?:#page=[1-9]\d*)?$/i;

const dartFilingUrl = /^https:\/\/dart\.fss\.or\.kr\/dsaf001\/main\.do\?rcpNo=\d{14}$/;

function validPeriod(period: RevenueBreakdownPeriod) {
  if (!day(period?.end)) return false;
  return "kind" in period
    ? (period.kind === "annual" || period.kind === "interim" || period.kind === "quarter")
      && typeof period.label === "string"
      && typeof period.revenueLabel === "string"
      && (period.singleSegment === undefined || period.singleSegment === true)
      && day(period.filing?.filed)
      && typeof period.filing?.url === "string"
      && (period.kind === "quarter"
        ? dartFilingUrl.test(period.filing.url) && period.filing.page === null
        : hkexFilingUrl.test(period.filing.url) && period.filing.page !== null
          && Number.isInteger(period.filing.page) && period.filing.page > 0)
    : Number.isInteger(period.fiscalYear) && Number.isInteger(period.fiscalQuarter)
      && period.fiscalQuarter >= 1 && period.fiscalQuarter <= 4;
}

function validateRevenueBreakdown(data: RevenueBreakdownPayload): RevenueBreakdownPayload {
  const width = data?.periods?.length;
  const valid =
    !!data
    && REVENUE_VIEWS.includes(data.view)
    && Array.isArray(data.views)
    && data.views.every((view) => REVENUE_VIEWS.includes(view))
    && (data.access === "full" || data.access === "preview")
    && isNonNegativeInt(data.lockedRows)
    && Array.isArray(data.periods) && width > 0
    && data.periods.every((period) => validPeriod(period) && ("kind" in period) === ("kind" in data.periods[0]!))
    && Array.isArray(data.total) && data.total.length === width && data.total.every(isNullableFinite)
    && Array.isArray(data.rows)
    && data.rows.every((row) =>
      typeof row?.key === "string"
      && typeof row.label === "string"
      && Array.isArray(row.values) && row.values.length === width && row.values.every(isNullableFinite)
      && isNullableFinite(row.ttm) && isNullableFinite(row.yoy) && isNullableFinite(row.share));
  if (!valid) throw new Error("The server returned an unreadable revenue breakdown");
  return data;
}

export type RevenueResource = CloudResource<RevenueBreakdownPayload>;

interface RevenueArgs { symbol: string; view: RevenueBreakdownView; pro?: boolean; listing?: IssuerListingParams }
// Revenue by product, segment or region changes only when a filing lands, so a result stays fresh for an hour;
// the plan is part of the key because a preview and the full split are different answers.
// SAN in Paris is not SAN in New York: a listing abroad is cached under its venue.
const revenueEndpoint = createCloudEndpoint<RevenueArgs, RevenueBreakdownPayload, Pick<typeof apiClient, "getCloudRevenueBreakdown">>({
  kind: "revenue-breakdown", schemaVersion: 1, policy: { staleMs: 60 * 60_000, expireMs: 30 * 86_400_000 },
  key: ({ symbol, view, pro, listing }) => `${secListingKey(symbol, listing?.exchange)}:${view}:${pro ? "full" : "preview"}`,
  defaultClient: apiClient,
  fetch: async ({ symbol, view, listing }, client) => {
    try { return await client.getCloudRevenueBreakdown(symbol, view, listing); }
    catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) throw new Error(NO_BREAKDOWN);
      throw error;
    }
  },
  validate: validateRevenueBreakdown,
});

export const revenueBreakdownCache = revenueEndpoint.cache;
export const fetchRevenueBreakdown = (symbol: string, view: RevenueBreakdownView, client: Pick<typeof apiClient, "getCloudRevenueBreakdown"> = apiClient, listing?: IssuerListingParams) =>
  revenueEndpoint.fetch({ symbol, view, listing }, { client });
export const cachedRevenueBreakdown = (symbol: string, view: RevenueBreakdownView, pro: boolean, listing?: IssuerListingParams): RevenueResource | null =>
  revenueEndpoint.cached({ symbol, view, pro, listing });
export const loadRevenueBreakdown = (symbol: string, view: RevenueBreakdownView, pro: boolean, force = false, listing?: IssuerListingParams): Promise<RevenueResource> =>
  revenueEndpoint.load({ symbol, view, pro, listing }, { force });
