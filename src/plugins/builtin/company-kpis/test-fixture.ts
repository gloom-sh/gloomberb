import type { GuidancePayload, KpiEvidence, KpiGuidance, KpiObservation, KpisPayload } from "../../../api-client/company-kpis";

// Deliberately fictional values for validation and interaction tests, never used for screenshots.
const evidence: KpiEvidence = { id: "evidence:test", documentId: "document:test", sourceId: "test", sourceKind: "press_release",
  url: "https://example.com/investors/results", title: "Example company quarterly results", publishedAt: "2026-08-05T12:00:00Z", country: "GB", language: "en",
  quote: "Annual recurring revenue was GBP 125 million.", quoteOffset: 0, quoteSourceLength: 45, quoteMatchMode: "exact", confidence: 0.99 };
export function observation(overrides: Partial<KpiObservation> = {}): KpiObservation {
  return { id: "actual:q2", symbol: "EXAMPLE:LSE", metricId: "arr", metric: { id: "arr", name: "Annual recurring revenue", sector: "software", unit: "currency",
    definition: "Annualized recurring contracted revenue.", aliases: { en: ["ARR"] }, favorable: "higher" },
    seriesKey: "arr:reported:GBP", value: 125_000_000, unit: "currency", currency: "GBP", basis: "reported", dimensions: {},
    period: { start: "2026-04-01", end: "2026-06-30", kind: "quarter", fiscalYear: 2026, fiscalQuarter: 2, label: "Q2 FY2026" },
    asOf: "2026-08-05T12:00:00Z", supersedesId: null, revision: 1, current: true, conflict: false, confidence: 0.99, evidence: [{ ...evidence }], ...overrides };
}
export function guide(overrides: Partial<KpiGuidance> = {}): KpiGuidance {
  const { value: _value, conflict: _conflict, ...base } = observation();
  return { ...base, id: "guide:q2", issuedDate: "2026-02-01", low: 110_000_000, high: 120_000_000, point: null, hedge: "exact",
    rangeText: "We expect annual recurring revenue of GBP 110 million to GBP 120 million.", status: "active", direction: "raised", previousId: null,
    midpointChangePct: 5, actual: { observationId: "actual:q2", value: 125_000_000, outcome: "above", favorable: "beat", difference: 5_000_000, differencePct: 4.1666666667 }, ...overrides };
}
export function kpisPayload(overrides: Partial<KpisPayload> = {}): KpisPayload {
  const latest = observation();
  return { symbol: latest.symbol, status: "available", asOf: "2026-08-05T12:00:00Z", access: "full", lockedRows: 0, totalRows: 1, truncated: false, previewRows: null,
    coverage: { country: "GB", languages: ["en"], documents: 1, observations: 1, guidance: 1, firstPeriod: "2026-06-30", lastPeriod: "2026-06-30", lastPublishedAt: evidence.publishedAt, sourceKinds: ["press_release"], conflicts: 0 },
    series: [{ key: latest.seriesKey, metric: latest.metric, unit: latest.unit, currency: latest.currency, basis: latest.basis, dimensions: {}, latest, observations: [latest] }],
    revisions: [], dictionary: [latest.metric], methodology: "Company disclosed metrics with source evidence.", ...overrides };
}
export function guidancePayload(overrides: Partial<GuidancePayload> = {}): GuidancePayload {
  const { series: _series, revisions: _revisions, ...base } = kpisPayload();
  return { ...base, guidance: [guide()], history: [], ...overrides };
}
