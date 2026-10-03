export type CreditValue = string | number | boolean | null | CreditValue[] | { [key: string]: CreditValue };
export interface CreditFact {
  id: string;
  instrumentId: string;
  documentId: string;
  instrumentKey: string;
  instrumentName: string;
  field: string;
  factKey: string;
  value: CreditValue;
  unit: string | null;
  currency: string | null;
  asOf: string;
  confidence: number;
  quote: string;
  source: string;
  filingUrl: string;
  form: string;
  filedAt: string;
  periodEnd: string | null;
  language: string;
  quoteOffset: number;
  quoteSourceLength: number;
  quoteMatchMode: string;
  status: "active" | "superseded";
  supersedesId: string | null;
}
export interface CreditInstrument {
  lifecycle?: string | null;
  id: string;
  key: string;
  name: string;
  currency: string | null;
  facilityType: string | null;
  principal: number | null;
  commitment: number | null;
  drawn: number | null;
  maturity: string | null;
  facts: CreditFact[];
  history?: CreditFact[];
}
export interface CreditHeadroom {
  id: string;
  instrumentId: string;
  instrumentName: string;
  metric: string;
  comparator: "maximum" | "minimum";
  inclusive?: boolean;
  threshold: number;
  current: number | null;
  headroomPercent: number | null;
  asOf: string;
  testDate: string | null;
  status: "compliant" | "breach" | "uncomputable" | "stale" | "conditional";
  reason: string | null;
  evidenceIds: string[];
}
export interface CreditMaturityBucket {
  year: number;
  currency: string;
  principal: number;
  instruments: Array<{ id: string; name: string; principal: number; evidenceIds: string[] }>;
}
interface CreditControlExposure {
  instrumentId: string;
  instrumentName: string;
  currency: string | null;
  principal: number | null;
  trigger: string;
  putPercent: number | null;
  evidenceIds: string[];
}
export interface CreditDocumentsPayload {
  version: 1;
  symbol: string;
  issuer: { id: string; name: string; jurisdiction: string } | null;
  status: "available" | "partial" | "unavailable";
  asOf: string | null;
  access: "full" | "preview";
  lockedRows: number;
  instruments: CreditInstrument[];
  covenants: CreditHeadroom[];
  maturities: CreditMaturityBucket[];
  changeOfControl: CreditControlExposure[];
  warnings: string[];
}
export interface CreditScreenRow {
  symbol: string;
  issuerName: string;
  instrumentId: string;
  instrumentName: string;
  kind: "headroom" | "springing_maturity";
  value: number | null;
  date: string | null;
  currency: string | null;
  reason: string;
  evidence: CreditFact[];
}
export interface CreditScreenPayload {
  truncated: boolean;
  rows: CreditScreenRow[];
  access: "full" | "preview";
  lockedRows: number;
  asOf: string | null;
}
export interface CreditScreenQuery { headroomBelow?: number; springingWithinMonths?: number; limit?: number }
