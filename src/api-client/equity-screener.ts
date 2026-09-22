export const NUMERIC_FIELDS = [
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
] as const;
export const CATEGORY_FIELDS = [
  "symbol",
  "exchange",
  "currency",
  "sector",
  "industry",
] as const;
export type NumericField = (typeof NUMERIC_FIELDS)[number];
export type CategoryField = (typeof CATEGORY_FIELDS)[number];
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
export interface ScreenCoverage {
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
export interface SavedScreen {
  id: string;
  name: string;
  definition: ScreenDefinition;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ScreenFieldDefinition {
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
