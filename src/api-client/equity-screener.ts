/** Cited company disclosures; Pro, omitted by older servers. */
export const KPI_FIELDS = ["kpiArr", "kpiNrrPercent", "kpiRpo", "kpiCrpo", "kpiSubscribers", "kpiDau", "kpiMau", "kpiGmv", "kpiTakeRatePercent", "kpiSameStoreSalesPercent", "kpiStores", "kpiBacklog", "kpiBookToBill", "kpiNimPercent", "kpiCet1Percent", "kpiCombinedRatioPercent", "kpiOccupancyPercent", "kpiLoadFactorPercent", "guideRevenueChangePercent", "guideEpsChangePercent"] as const;
/** Payout ratio and dividend growth; listed only when asked (`include=dividends`), and omitted by a server from before them. */
export const DIVIDEND_FIELDS = ["payoutRatioPercent", "dividendGrowth1YPercent", "dividendGrowth3YPercent"] as const;
/**
 * Technical readings of the stored daily bars at the last completed session; listed only when asked
 * (`include=technical`), and omitted by a server from before them.
 */
export const TECHNICAL_FIELDS = [
  "rsi14",
  "priceVsSma20Percent", "priceVsSma50Percent", "priceVsSma200Percent",
  "macdBullishCrossDays", "macdBearishCrossDays", "goldenCrossDays", "deathCrossDays",
  "newHigh20dDays", "newLow20dDays", "newHigh52wDays", "newLow52wDays",
  "bollingerWidthPercentile",
] as const;
/**
 * IV30, its 52-week percentile and its moves in volatility points, and 20-session realized volatility with its
 * 52-week rank; listed only when asked (`include=option-volatility`), and omitted by a server from before them.
 */
export const OPTION_VOLATILITY_FIELDS = ["iv30Percent", "ivPercentile", "iv30Change1d", "iv30Change5d", "hv20Percent", "hvRank"] as const;
/**
 * Shares outstanding, float, short % of float and 13F institutional ownership, each with the day it describes;
 * listed only when asked (`include=ownership`), and omitted by a server from before them.
 */
export const OWNERSHIP_FIELDS = ["sharesOutstanding", "floatShares", "shortPercentOfFloat", "institutionalOwnershipPercent"] as const;
/**
 * ROIC, FCF yield, leverage, revenue and EPS CAGRs and consensus growth, on the bases `FA` and `EE` use; listed only
 * when asked (`include=quality`), and omitted by a server from before them.
 */
export const QUALITY_FIELDS = [
  "roicPercent", "fcfYieldPercent", "netDebtToEbitda", "debtToEquity",
  "revenueCagr3YPercent", "revenueCagr5YPercent", "epsCagr3YPercent", "epsCagr5YPercent",
  "forwardRevenueGrowthPercent", "forwardEpsGrowthPercent",
] as const;
/**
 * Classic scores: Piotroski F, Altman Z, the Graham number and Lynch fair value with their upside, Greenblatt's
 * earnings yield, return on capital and Magic Formula rank, the 1Y total return and its RS rating, years of profit,
 * revenue growth and dividend growth, and S&P 500 and Dow membership; listed only when asked (`include=scores`), and
 * omitted by a server from before them.
 */
export const SCORE_FIELDS = [
  "piotroskiFScore", "altmanZScore", "grahamNumber", "grahamUpsidePercent", "lynchFairValue", "lynchUpsidePercent",
  "earningsYieldPercent", "returnOnCapitalPercent", "magicFormulaRank", "totalReturn1YPercent", "rsRating",
  "profitableYears", "revenueGrowthYears", "dividendGrowthYears", "sp500Member", "dowMember",
] as const;
/** Index membership, 1 for a member and 0 for a US listing that is not one. */
export const MEMBERSHIP_FIELDS = ["sp500Member", "dowMember"] as const;
export const NUMERIC_FIELDS = [
  ...KPI_FIELDS,
  "price",
  "changePercent",
  "volume",
  "averageVolume20d",
  "relativeVolume",
  "marketCap",
  "trailingPE",
  "forwardPE",
  "enterpriseToRevenue",
  "dividendYieldPercent",
  ...DIVIDEND_FIELDS,
  "revenueGrowthPercent",
  "earningsGrowthPercent",
  "grossMarginPercent",
  "operatingMarginPercent",
  "netMarginPercent",
  "shortInterestShares",
  "shortInterestChangePercent",
  "daysToCover",
  "insiderPurchases90d",
  "insiderSales90d",
  "institutionalHolders",
  "institutionalNewHolders",
  "institutionalExits",
  "xPostsPerDay",
  "xPostsVsMedian",
  "wikiViewsPerDay",
  "wikiViewsVsMedian",
  "attentionResearchUnits",
  "attentionZScore",
  "return1WPercent",
  "return1MPercent",
  "return3MPercent",
  "returnYtdPercent",
  "return1YPercent",
  "fromHigh52WPercent",
  "beta",
  "atrPercent",
  ...TECHNICAL_FIELDS,
  "priceToBook",
  "evToEbitda",
  "roePercent",
  "epsRevision30dPercent",
  "analystUpsidePercent",
  "ivRank",
  "ivToHv",
  ...OPTION_VOLATILITY_FIELDS,
  ...OWNERSHIP_FIELDS,
  ...QUALITY_FIELDS,
  ...SCORE_FIELDS,
  "hiringOpenRoles", "hiringNetAddsWeek", "hiringRemotePercent", "hiringZScore",
  "appAttentionScore", "appRankVelocity7d", "appRatingDrift7d", "appRatingCountGrowth7d",
] as const;
/** Hiring and app attention are optional when connecting to an older server. */
export const HIRING_APP_FIELDS = ["hiringOpenRoles", "hiringNetAddsWeek", "hiringRemotePercent", "hiringZScore", "appAttentionScore", "appRankVelocity7d", "appRatingDrift7d", "appRatingCountGrowth7d"] as const;
/** Social attention; a server from before them omits these metrics. */
export const SOCIAL_FIELDS = ["xPostsPerDay", "xPostsVsMedian", "wikiViewsPerDay", "wikiViewsVsMedian"] as const;
export const ATTENTION_FIELDS = ["attentionResearchUnits", "attentionZScore"] as const;
/** Returns, valuation, estimates and options; a server from before them omits these metrics. */
export const RESEARCH_FIELDS = [
  "return1WPercent", "return1MPercent", "return3MPercent", "returnYtdPercent", "return1YPercent", "fromHigh52WPercent",
  "beta", "priceToBook", "evToEbitda", "roePercent", "epsRevision30dPercent", "analystUpsidePercent", "ivRank", "ivToHv",
] as const;
/** Average true range as a percent of price; listed only when asked (`include=volatility`), and omitted by a server from before it. */
export const VOLATILITY_FIELDS = ["atrPercent"] as const;
export const CATEGORY_FIELDS = [
  "symbol",
  "exchange",
  "currency",
  "sector",
  "industry",
] as const;
export type NumericField = (typeof NUMERIC_FIELDS)[number];
type CategoryField = (typeof CATEGORY_FIELDS)[number];
export type ScreenField = NumericField | CategoryField;
export type ScreenOperator =
  "gte" | "lte" | "gt" | "lt" | "eq" | "between" | "in" | "present" | "missing";
export type ScreenCriterion =
  | {
      field: NumericField;
      op: "gte" | "lte" | "gt" | "lt" | "eq";
      value: number;
    }
  | { field: NumericField; op: "between"; value: [number, number] }
  | { field: CategoryField; op: "in"; value: string[] }
  | { field: ScreenField; op: "present" | "missing" };

export interface ScreenDefinition {
  version: 1;
  criteria: ScreenCriterion[];
  sort: { field: ScreenField; direction: "asc" | "desc" };
  /** Native quote/market-cap currency. Null allows mixed currencies only for nonmonetary criteria/sorts. */
  currency: string | null;
}
export interface ScreenQuery extends ScreenDefinition {
  limit: number;
  cursor: string | null;
}
export interface ScreenMetric {
  value: number | null;
  unit: string;
  /** Source observation date or timestamp. Never filled from collection time. */
  asOf: string | null;
  /** Latest known public filing date where supplied by the source. */
  availableAt: string | null;
  observedAt: string | null;
  source: string;
  state: "available" | "partial" | "stale" | "unavailable";
  scope: "reported" | "derived" | "observed-subset";
  reason: string | null;
  sourceUrl: string | null;
  /** Set by the client on a Pro field the server left out for a caller without Gloom Pro; never sent. */
  access?: "pro";
  /**
   * Set on a multiple that is not meaningful (a P/E over a loss, an EV/revenue or EV/EBITDA over an EV or EBITDA at
   * or below zero): `value` is null, `reason` says why, and it shows as N/M.
   */
  notMeaningful?: true;
  percentile: {
    value: number | null;
    sampleCount: number;
    scope: "covered-universe";
  };
}
export interface ScreenRow {
  symbol: string;
  exchange: string;
  name: string | null;
  currency: string | null;
  sector: string | null;
  industry: string | null;
  metrics: Record<NumericField, ScreenMetric>;
  warnings: string[];
}
interface ScreenCoverage {
  covered: number;
  skipped: number;
  knownByField: Record<NumericField, number>;
  missingByField: Record<NumericField, number>;
  partialByField: Record<NumericField, number>;
  staleByField: Record<NumericField, number>;
  currencies: string[];
  sectors: string[];
  exchanges: string[];
}
export interface ScreenSnapshot {
  id: string;
  assembledAt: string;
  expiresAt: string;
  sourceOldestAt: string | null;
  sourceNewestAt: string | null;
}
export interface ScreenPayload {
  version: 1;
  status: "available" | "partial" | "unavailable";
  snapshot: ScreenSnapshot | null;
  definition: ScreenDefinition;
  universe: ScreenCoverage & { matched: number };
  rows: ScreenRow[];
  nextCursor: string | null;
  warnings: string[];
}
interface ScreenCriterionCheck {
  criterion: ScreenCriterion;
  /** The screen's currency restriction, which also controls membership. */
  implicit: boolean;
  value: number | string | null;
  passes: boolean | null;
  state: "available" | "partial" | "stale" | "unavailable" | "missing" | "not-covered";
  unit: string;
  asOf: string | null;
  observedAt: string | null;
  reason: string | null;
}
export interface ScreenCheckPayload {
  version: 1;
  status: "available" | "partial" | "not-covered";
  symbol: string;
  definition: ScreenDefinition;
  snapshot: ScreenSnapshot;
  matches: boolean | null;
  row: Pick<ScreenRow, "symbol" | "exchange" | "name" | "currency" | "sector" | "industry"> | null;
  criteria: ScreenCriterionCheck[];
  warnings: string[];
}
export interface SavedScreen {
  id: string;
  name: string;
  definition: ScreenDefinition;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ScreenFieldDefinition {
  access?: "pro";
  id: ScreenField;
  label: string;
  kind: "number" | "category";
  unit: string;
  operators: ScreenOperator[];
  description: string;
}

export interface ScreenFieldsResponse {
  version: 1;
  fields: ScreenFieldDefinition[];
  limits: {
    criteria: number;
    pageSize: number;
    exportRows: number;
    savedScreens: number;
  };
  cadenceSeconds: number;
}
export interface ScreenExportResponse {
  csv: string;
  filename: string;
  snapshotId: string;
  rowCount: number;
}
