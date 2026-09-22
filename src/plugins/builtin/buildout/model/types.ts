import type { DataTableColumn } from "../../../../components";

export type BuildoutTabId = "companies" | "sites" | "intel";
export type BuildoutAccess = "free" | "pro";
export type SortDirection = "asc" | "desc";

export type RawObject = Record<string, unknown>;

export type BuildoutSource = {
  field?: string | null;
  title?: string | null;
  url?: string | null;
  domain?: string | null;
  snippet?: string | null;
  reasoning?: string | null;
  confidence?: string | null;
  tier?: string | null;
  citations?: Array<{
    title?: string | null;
    url?: string | null;
    excerpts?: string[];
  }>;
};

export type BuildoutRelatedCompany = {
  id?: string | null;
  name?: string | null;
  ticker?: string | null;
  logoUrl?: string | null;
  websiteUrl?: string | null;
};

export type BuildoutList = {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  shortDescription?: string | null;
  companyCount?: number | null;
  totalMarketCap?: string | null;
  avgSectorGrowth?: string | null;
  avgReturn1y?: string | null;
  avgMargin?: string | null;
};

export type BuildoutCompany = {
  id: string;
  name: string;
  ticker?: string | null;
  exchange?: string | null;
  starred?: boolean;
  description?: string | null;
  longDescription?: string | null;
  primarySector?: string | null;
  primarySubsector?: string | null;
  primaryTechnology?: string | null;
  sectors?: string[];
  subSectors?: string[];
  technologies?: string[];
  valueChainStages?: string[];
  aiCriticality?: string | null;
  aiCriticalityJustification?: string | null;
  exportControlExposure?: string | null;
  maturity?: string | null;
  currency?: string | null;
  marketCap?: string | null;
  marketCapOriginal?: string | null;
  enterpriseValue?: string | null;
  stockPrice?: string | null;
  stockPriceOriginal?: string | null;
  revenue?: string | null;
  revenueOriginal?: string | null;
  revenueGrowthYoy?: string | null;
  lastQuarterGrowth?: string | null;
  netIncome?: string | null;
  netIncomeOriginal?: string | null;
  peRatio?: string | null;
  profitMargins?: string | null;
  netProfitMargin?: string | null;
  forwardPE?: string | null;
  trailingPE?: string | null;
  pegRatio?: string | null;
  priceToBook?: string | null;
  dilutedEps?: string | null;
  dilutedEpsOriginal?: string | null;
  beta?: string | null;
  high52w?: string | null;
  high52wOriginal?: string | null;
  low52w?: string | null;
  low52wOriginal?: string | null;
  grossProfitMargin?: string | null;
  operatingMargin?: string | null;
  returnOnEquity?: string | null;
  returnOnAssets?: string | null;
  freeCashFlow?: string | null;
  freeCashFlowOriginal?: string | null;
  operatingCashFlow?: string | null;
  totalCash?: string | null;
  totalCashOriginal?: string | null;
  totalDebt?: string | null;
  totalDebtOriginal?: string | null;
  debtToEquity?: string | null;
  currentRatio?: string | null;
  quickRatio?: string | null;
  dividendYield?: string | null;
  exDividendDate?: string | null;
  dividendDate?: string | null;
  targetHighPrice?: string | null;
  targetHighPriceOriginal?: string | null;
  targetLowPrice?: string | null;
  targetLowPriceOriginal?: string | null;
  targetMeanPrice?: string | null;
  targetMeanPriceOriginal?: string | null;
  analystCount?: string | null;
  recommendation?: string | null;
  strongBuy?: string | null;
  buy?: string | null;
  hold?: string | null;
  sell?: string | null;
  strongSell?: string | null;
  heldByInsiders?: string | null;
  heldByInstitutions?: string | null;
  sharesShort?: string | null;
  shortRatio?: string | null;
  sharesOutstanding?: string | null;
  floatShares?: string | null;
  nextEarningsDate?: string | null;
  return1y?: string | null;
  return3y?: string | null;
  employeeCount?: string | null;
  countryHq?: string | null;
  hqAddress?: string | null;
  city?: string | null;
  state?: string | null;
  websiteUrl?: string | null;
  logoUrl?: string | null;
  researchReport?: string | null;
  listReason?: string | null;
  intelligence?: Array<{
    publishedAt?: string | null;
    headline?: string | null;
    content?: string | null;
    sentimentScore?: string | null;
    sourceUrl?: string | null;
  }>;
  supplyChain?: {
    suppliers: BuildoutRelatedCompany[];
    customers: BuildoutRelatedCompany[];
    competitors: BuildoutRelatedCompany[];
  };
  sites?: Array<{
    name?: string | null;
    type?: string | null;
    relationship?: string | null;
    role?: string | null;
    involvementSummary?: string | null;
    ownerName?: string | null;
    ownerTicker?: string | null;
    powerCapacity?: string | null;
    areaKm2?: string | null;
    constructionActivity?: number | null;
    parkingActivity?: number | null;
    location?: { city?: string | null; country?: string | null };
  }>;
};

export type BuildoutObservation = {
  id?: string;
  captureDate?: string | null;
  imageUrl?: string | null;
  originalImageUrl?: string | null;
  upscaledImageUrl?: string | null;
  swirImageUrl?: string | null;
  nirImageUrl?: string | null;
  observationSource?: string | null;
  note?: string | null;
  captureBounds?: {
    minLng?: number | null;
    maxLng?: number | null;
    minLat?: number | null;
    maxLat?: number | null;
  } | null;
};

export type BuildoutReportSection = {
  title?: string | null;
  body?: string | null;
  content?: string | null;
  markdown?: string | null;
  section?: string | null;
};

export type BuildoutSite = {
  id: string;
  name: string;
  type?: string | null;
  starred?: boolean;
  ownerName?: string | null;
  ownerTicker?: string | null;
  ownerLogoUrl?: string | null;
  ownerWebsiteUrl?: string | null;
  address?: string | null;
  location?: { city?: string | null; country?: string | null };
  boundaryConfirmed?: boolean | null;
  constructionActivity?: number | null;
  parkingActivity?: number | null;
  latestCapture?: string | null;
  activityUpdatedAt?: string | null;
  powerCapacity?: string | null;
  eta?: string | null;
  description?: string | null;
  parkName?: string | null;
  areaKm2?: string | null;
  siteMetadata?: RawObject | null;
  observations?: BuildoutObservation[];
  projectReportSections?: BuildoutReportSection[] | null;
  projectReportSources?: BuildoutSource[];
  researchReport?: string | null;
  lastEnrichedAt?: string | null;
  builders?: Array<{
    companyName?: string | null;
    companyTicker?: string | null;
    companyWebsiteUrl?: string | null;
    role?: string | null;
    summary?: string | null;
  }>;
  discoverySources?: BuildoutSource[];
};

export type BuildoutUpdate = {
  id: string;
  headline: string;
  content?: string | null;
  context?: string | null;
  imageUrl?: string | null;
  type?: string | null;
  publishedAt?: string | null;
  verificationStatus?: string | null;
  companies?: Array<{ name?: string | null; ticker?: string | null; websiteUrl?: string | null; countryHq?: string | null }>;
  contextSources?: BuildoutSource[];
  sourceUrls?: string[];
  isDelayed?: boolean;
};

export type BuildoutRow =
  | { kind: "list"; item: BuildoutList }
  | { kind: "company"; item: BuildoutCompany }
  | { kind: "site"; item: BuildoutSite }
  | { kind: "intel"; item: BuildoutUpdate };

export type BuildoutCompaniesPayload =
  | { companies?: RawObject[]; blurredCount?: number }
  | RawObject[];

export type BuildoutPagedState<T> = {
  items: T[];
  offset: number;
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
};

export type BuildoutLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
    status: "ready";
    access: BuildoutAccess;
    token: string | null;
    lists: BuildoutList[];
    companies: BuildoutPagedState<BuildoutCompany> & { blurredCompanyCount: number };
    sites: BuildoutPagedState<BuildoutSite>;
    intel: BuildoutPagedState<BuildoutUpdate>;
    loadedAt: number;
    /** A refresh in flight keeps the loaded data on screen. */
    refreshing?: boolean;
    /** The failure of the last refresh, while the previous data stays. */
    refreshError?: string | null;
  };

export type BuildoutColumnId =
  | "favorite"
  | "listName"
  | "listDescription"
  | "companyCount"
  | "totalMarketCap"
  | "avgSectorGrowth"
  | "avgReturn1y"
  | "avgMargin"
  | "company"
  | "description"
  | "sectorTech"
  | "criticality"
  | "marketCap"
  | "revenue"
  | "revenueGrowth"
  | "netIncome"
  | "margin"
  | "forwardPE"
  | "dividendYield"
  | "return1y"
  | "employees"
  | "site"
  | "type"
  | "owner"
  | "location"
  | "park"
  | "power"
  | "construction"
  | "parking"
  | "capture"
  | "area"
  | "time"
  | "companies"
  | "headline";

export type BuildoutColumn = DataTableColumn & { id: BuildoutColumnId };

export type SortComparable =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "missing" };
