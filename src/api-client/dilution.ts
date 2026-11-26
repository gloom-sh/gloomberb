export type DilutionRiskTier = "low" | "moderate" | "elevated" | "high";
type ShelfStatus = "active" | "expired" | "superseded";
export type OfferingType =
  | "atm"
  | "follow_on"
  | "registered_direct"
  | "convertible"
  | "secondary"
  | "warrant"
  | "hk_placement"
  | "other";

export interface DilutionShelfRow {
  accession: string;
  symbol: string;
  cik: string;
  companyName: string;
  form: string;
  filingDate: string;
  effectiveDate: string | null;
  expiryDate: string | null;
  daysToExpiry: number | null;
  fileNumber: string | null;
  isWksi: boolean;
  registeredAmountUsd: number | null;
  securityTypes: string[];
  primaryDocument: string | null;
  sourceUrl: string;
  status: ShelfStatus;
}

export interface DilutionOfferingRow {
  accession: string;
  symbol: string;
  cik: string;
  companyName: string;
  form: string;
  filingDate: string;
  fileNumber: string | null;
  offeringType: OfferingType;
  amountUsd: number | null;
  shares: number | null;
  offerPriceUsd: number | null;
  discountPct: number | null;
  salesAgent: string | null;
  headline: string | null;
  sourceUrl: string;
}

export interface DilutionForm144Row {
  accession: string;
  symbol: string;
  cik: string;
  companyName: string;
  filingDate: string;
  sellerName: string;
  relationship: string | null;
  securityTitle: string | null;
  brokerName: string | null;
  shares: number;
  marketValueUsd: number | null;
  sharesOutstanding: number | null;
  pctOutstanding: number | null;
  approxSaleDate: string | null;
  plan10b51Date: string | null;
  past3mShares: number | null;
  remarks: string | null;
  sourceUrl: string;
}

interface DilutionLockupRow {
  dealId: string;
  symbol: string;
  companyName: string;
  pricingDate: string | null;
  lockupDays: number;
  expiryDate: string;
  daysUntilExpiry: number;
  basis: "prospectus" | "typical";
  excerpt: string | null;
  sourceUrl: string | null;
}

interface DilutionHkDepositRow {
  atDate: string;
  code: string;
  stockName: string;
  partId: string;
  participantName: string;
  deltaShares: number;
  deltaPctIssued: number;
  netDepositShares: number;
  netDepositPct: number;
}

export interface DilutionMetrics {
  marketCapUsd: number | null;
  activeShelfCount: number;
  hasWksiShelf: boolean;
  registeredShelfUsd: number | null;
  drawnLast12mUsd: number;
  remainingShelfHeadroomUsd: number | null;
  babyShelfRestricted: boolean;
  babyShelfCapUsd: number | null;
  babyShelfRemainingUsd: number | null;
  activeAtmCount: number;
  atmCapacityUsd: number;
  offerings12mCount: number;
  offerings12mUsd: number;
  form144Count90d: number;
  form144Shares90d: number;
  form144Value90dUsd: number;
  nextLockupExpiryDate: string | null;
  nextLockupDays: number | null;
  hkDepositCount90d: number;
  hkDepositMaxPct: number | null;
  overhangPctOfMarketCap: number | null;
  riskTier: DilutionRiskTier;
  signals: string[];
}

export interface DilutionCompanyPayload {
  symbol: string;
  cik: string | null;
  companyName: string;
  market: "US" | "HK";
  asOfDate: string;
  metrics: DilutionMetrics;
  shelves: DilutionShelfRow[];
  offerings: DilutionOfferingRow[];
  form144: DilutionForm144Row[];
  lockups: DilutionLockupRow[];
  hkDeposits: DilutionHkDepositRow[];
}

export interface DilutionForm144FeedPayload {
  asOfDate: string | null;
  total: number;
  rows: DilutionForm144Row[];
}

export interface DilutionShelvesFeedPayload {
  asOfDate: string | null;
  total: number;
  rows: Array<
    DilutionShelfRow & {
      marketCapUsd: number | null;
      babyShelfRestricted: boolean;
      recentOfferingsUsd: number;
      recentAtmCount: number;
    }
  >;
}

export function cloudDilutionCompanyPath(symbol: string): string {
  return `/cloud/dilution/companies/${encodeURIComponent(symbol.trim().toUpperCase())}`;
}

export function cloudDilutionForm144Path(options: {
  symbol?: string;
  plan10b51Only?: boolean;
  limit?: number;
} = {}): string {
  const qs = new URLSearchParams();
  if (options.symbol) qs.set("symbol", options.symbol.trim().toUpperCase());
  if (options.plan10b51Only) qs.set("plan10b51Only", "true");
  if (options.limit) qs.set("limit", String(options.limit));
  const suffix = qs.toString();
  return suffix ? `/cloud/dilution/form144?${suffix}` : "/cloud/dilution/form144";
}

export function cloudDilutionShelvesPath(options: {
  atmOnly?: boolean;
  babyShelfOnly?: boolean;
  limit?: number;
} = {}): string {
  const qs = new URLSearchParams();
  if (options.atmOnly) qs.set("atmOnly", "true");
  if (options.babyShelfOnly) qs.set("babyShelfOnly", "true");
  if (options.limit) qs.set("limit", String(options.limit));
  const suffix = qs.toString();
  return suffix ? `/cloud/dilution/shelves?${suffix}` : "/cloud/dilution/shelves";
}
