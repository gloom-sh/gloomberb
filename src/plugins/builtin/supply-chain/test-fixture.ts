import type { SupplyChainPayload, SupplyEntity, SupplyRow } from "../../../api-client/supply-chain";
export const entity = (id: string, name = id): SupplyEntity => ({ id, name, ticker: id, exchange: null, country: null, kind: "listed", identifiers: {}, anonymous: false });
export const supplyRow = (id = "customer", overrides: Partial<SupplyRow> = {}): SupplyRow => ({ id, counterparty: entity(id), reportingEntity: entity("FOCUS"), role: "customer", direction: "out", pctOfRevenue: 22, pctBasis: "revenue", pctScope: null, usd: null, usdBasis: null,
  period: "2026-01-31", fiscalYear: "2026", sourceKind: "filing_text", form: "10-K", filedDate: "2026-02-25", asOf: "2026-01-31", confidence: 0.95,
  quote: "Customer contributed 22% of our revenue.", quoteLanguage: "en", quoteMatchMode: "exact", filingUrl: "https://www.sec.gov/Archives/example.htm", accession: null, ...overrides });
export function supplyPayload(overrides: Partial<SupplyChainPayload> = {}): SupplyChainPayload {
  return { symbol: "FOCUS", entity: entity("FOCUS"), asOf: "2026-01-31", status: "available", says: [supplyRow()], names: [],
    counts: { says: { customer: 1, supplier: 0, partner: 0, competitor: 0, investee: 0 }, names: { customer: 0, supplier: 0, partner: 0, competitor: 0, investee: 0 } },
    access: "full", lockedRows: 0, totalRows: 1, truncated: false, previewRowsPerRole: null,
    disclaimer: "Disclosed in filings only. Absence is not proof of no relationship.", ...overrides };
}
