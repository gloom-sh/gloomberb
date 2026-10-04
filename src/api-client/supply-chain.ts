export type SupplyRole = "customer" | "supplier" | "partner" | "competitor" | "investee";
export type SupplyTier = 1 | 2 | 3 | 4 | 5 | 6;
export type SupplyTierFilter = "sec" | "company" | "call" | "reported" | "unconfirmed";
type SupplyClaim = "disclosed" | "company_confirmed" | "reported" | "rumored";
export interface SupplyOptions { tiers?: SupplyTierFilter[]; includeLeads?: boolean; }
export interface SupplyEvidenceItem {
  id: string;
  tier: SupplyTier;
  claimType: SupplyClaim;
  url: string;
  title: string;
  publisher: string;
  publishedAt: string;
  fetchedAt: string;
  quote: string | null;
  quoteRights: "full" | "short" | "link_only";
  textOrigin: "publisher_text" | "asr" | "ocr" | "snippet";
  quoteLanguage: string | null;
  englishGloss: string | null;
  originKey: string;
  confidence: number;
  status: "active" | "superseded" | "rejected" | "stale";
  verificationStatus?: "verified" | "lead";
  valueKind: string | null;
  value: number | null;
  valueUnit: string | null;
  currency: string | null;
}
export interface SupplyEntity {
  id: string;
  name: string;
  ticker: string | null;
  exchange: string | null;
  country: string | null;
  kind: "listed" | "private" | "government" | "unknown";
  identifiers: Record<string, unknown>;
  anonymous: boolean;
  aggregate: boolean;
}
export interface SupplyRow {
  id: string;
  counterparty: SupplyEntity;
  reportingEntity: SupplyEntity;
  role: SupplyRole;
  direction: "in" | "out" | "mutual";
  pctOfRevenue: number | null;
  pctScope: string | null;
  pctBasis: "revenue" | "receivables" | "cost" | "purchases" | null;
  usd: number | null;
  usdBasis: "disclosed" | "derived" | null;
  period: string;
  fiscalYear: string | null;
  sourceKind: "xbrl" | "filing_text" | "call" | "news" | "web" | "import" | "press_release";
  form: string | null;
  filedDate: string | null;
  asOf: string;
  confidence: number;
  quote: string;
  quoteLanguage: string | null;
  quoteMatchMode: "exact" | "whitespace" | "nfkc_whitespace" | null;
  filingUrl: string;
  accession: string | null;
  tier?: SupplyTier;
  claimType?: SupplyClaim;
  corroboration?: number;
  leadStatus?: "none" | "lead" | "verified" | "rejected" | "stale";
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  lastConfirmedAt?: string | null;
  whyUnconfirmed?: string | null;
  evidence?: SupplyEvidenceItem[];
}
export interface SupplyChainPayload {
  symbol: string;
  entity: SupplyEntity | null;
  asOf: string | null;
  status: "available" | "unavailable";
  says: SupplyRow[];
  names: SupplyRow[];
  counts: { says: Record<SupplyRole, number>; names: Record<SupplyRole, number> };
  access: "full" | "preview";
  lockedRows: number;
  totalRows: number;
  truncated: boolean;
  previewRowsPerRole: 3 | null;
  disclaimer: string;
  tierCounts?: Record<SupplyTierFilter, number>;
}
