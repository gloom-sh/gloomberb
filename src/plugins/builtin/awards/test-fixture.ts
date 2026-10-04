import type { AwardDetailPayload, AwardHistoryPoint, AwardRow, AwardsPayload } from "../../../api-client/awards";

export function awardRow(overrides: Partial<AwardRow> = {}): AwardRow {
  return { id: "award-1", revisionId: "revision-1", source: "usaspending", sourceAwardId: "TEST-AWARD", jurisdiction: "US", awardType: "prime",
    title: "Aircraft maintenance support", awardDate: "2025-09-12", currency: "USD", awardAmount: "100000000.05", obligatedAmount: "85000000.05", ceilingAmount: "150000000",
    recipient: { name: "Contractor Corporation", identifiers: [{ scheme: "uei", value: "123TEST" }] }, agency: { id: "defense", name: "Department of Defense" },
    periodStart: "2025-10-01", periodEnd: "2028-09-30", naics: "336411", sector: "Aircraft Manufacturing",
    sourceUrl: "https://www.usaspending.gov/award/TEST-AWARD", observedAt: "2026-10-04T12:00:00Z", confidence: 1,
    entity: { ticker: "TEST", exchange: "NYSE", legalName: "Contractor Corporation", parentName: null, cik: "123", method: "identifier", evidenceUrl: "https://www.sec.gov/Archives/test", confidence: 1 },
    revenueComparison: { awardAmount: "100000000.05", annualRevenue: "2000000000", currency: "USD", periodStart: "2024-01-01", periodEnd: "2024-12-31", filedAt: "2025-02-15", sourceUrl: "https://www.sec.gov/Archives/revenue", percent: 5, basis: "award-value" },
    ...overrides };
}
export function awardHistory(overrides: Partial<AwardHistoryPoint> = {}): AwardHistoryPoint {
  return { source: "usaspending", month: "2025-01-01", currency: "USD", awardType: "prime", count: 2, awardAmount: "11000000", obligatedAmount: "5000000", ceilingAmount: "15000000", cumulativeObligatedAmount: "5000000", ...overrides };
}
export function awardsPayload(overrides: Partial<AwardsPayload> = {}): AwardsPayload {
  return { generatedAt: "2026-10-04T12:00:00Z", asOf: "2026-10-04T12:00:00Z", status: "available", access: "full", rows: [awardRow()],
    nextCursor: null, agencies: [{ source: "usaspending", key: "defense", label: "Department of Defense", currency: "USD", awardType: "prime", count: 3, obligatedAmount: "85000000.05", awardAmount: "100000000.05", ceilingAmount: "150000000", sharePercent: 100 }],
    sectors: [{ source: "usaspending", key: "Aircraft Manufacturing", label: "Aircraft Manufacturing", currency: "USD", awardType: "prime", count: 3, obligatedAmount: "85000000.05", awardAmount: "100000000.05", ceilingAmount: "150000000", sharePercent: 100 }],
    leaders: [{ source: "usaspending", key: "TEST", label: "Contractor Corporation", sector: "Aircraft Manufacturing", ticker: "TEST", exchange: "NYSE", currency: "USD", awardType: "prime", count: 3, obligatedAmount: "85000000.05", awardAmount: "100000000.05", ceilingAmount: "150000000", sharePercent: 100 }],
    history: [awardHistory(), awardHistory({ month: "2025-02-01", cumulativeObligatedAmount: "10000000" }), awardHistory({ month: "2025-03-01", cumulativeObligatedAmount: "15000000" })],
    alerts: [awardRow()], sources: [], coverage: [], gaps: [], locked: false, ...overrides };
}
export function awardDetail(overrides: Partial<AwardDetailPayload> = {}): AwardDetailPayload {
  const row = awardRow();
  return { row, revisions: [{ id: row.revisionId, observedAt: row.observedAt, sourceUpdatedAt: null, supersedes: "revision-original", award: row }],
    subawards: [], modifications: [], edges: [{ kind: "government-customer", from: row.recipient, to: { name: row.agency.name }, awardId: row.id, sourceUrl: row.sourceUrl, amount: row.awardAmount ?? null, currency: "USD" }], access: "full", locked: false, ...overrides };
}
