export type SupplyRole = "customer" | "supplier" | "partner" | "competitor" | "investee";
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
  sourceKind: "xbrl" | "filing_text" | "call" | "news" | "web" | "import";
  form: string | null;
  filedDate: string | null;
  asOf: string;
  confidence: number;
  quote: string;
  quoteLanguage: string | null;
  quoteMatchMode: "exact" | "whitespace" | "nfkc_whitespace" | null;
  filingUrl: string;
  accession: string | null;
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
}
