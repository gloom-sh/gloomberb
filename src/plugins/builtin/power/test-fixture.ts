import type { PowerBoard, PowerHistoryPoint, PowerProject } from "../../../api-client/power";
export function powerProject(overrides: Partial<PowerProject> = {}): PowerProject {
  return { id: "test:queue-1", sourceId: "test", sourceProjectId: "queue-1", kind: "queue", name: "Storage project", country: "US", region: "PJM",
    state: "Virginia", county: "Loudoun", zone: null, developer: "Test developer", utility: null, fuel: "storage", technology: "Battery",
    status: "active", statusRaw: "In study", capacityMw: 125.5, requestedDate: "2024-01-01", proposedDate: "2028-06", completedDate: null,
    withdrawnDate: null, period: null, asOf: "2026-10-01", observedAt: "2026-10-04T12:00:00.000Z", sourceUrl: "https://example.org/queue.csv",
    sourceLocator: "Sheet 1 row 3", confidence: 1, evidence: { "Project Name": "Storage project", "MW": 125.5 }, metrics: {}, historical: false,
    snapshotId: "snapshot-1", revision: 1, entities: [{ name: "Test developer", entityId: "dev", role: "developer", confidence: 1, tickers: [{ ticker: "NEE", exchange: "NYSE" }] }], ...overrides };
}
export function powerBoard(overrides: Partial<PowerBoard> = {}): PowerBoard {
  return { generatedAt: "2026-10-04T12:00:00.000Z", access: "full", projects: [powerProject()], total: 1, hasMore: false, nextOffset: null,
    aggregates: [{ sourceId: "test", country: "US", region: "PJM", fuel: "storage", status: "active", kind: "queue", projects: 1, capacityMw: 125.5, unknownCapacity: 0 }],
    rates: [{ sourceId: "test", country: "US", region: "PJM", cohort: "2024", projects: 4, completed: 1, withdrawn: 1, active: 2, unknown: 0, completionRate: 0.25, withdrawalRate: 0.25 }],
    exposure: [], coverage: [{ id: "test", country: "US", region: "PJM", kind: "queue", role: "direct", status: "current", reason: null,
      sourceUrl: "https://example.org/queue.csv", asOf: "2026-10-01", observedAt: "2026-10-04T12:00:00.000Z", records: 1, nextPollAt: null }],
    filters: { countries: ["US"], regions: ["PJM"], fuels: ["storage"], statuses: ["active"] }, locked: { projects: 0, aggregates: 0, rates: 0, exposure: 0 }, ...overrides };
}
export function powerPoint(overrides: Partial<PowerHistoryPoint> = {}): PowerHistoryPoint {
  return { basis: "observed", sourceUrls: ["https://example.org/queue.csv"], sourceId: "test", country: "US", region: "PJM", kind: "queue", fuel: "storage", status: "active", projects: 1, capacityMw: 100,
    unknownCapacity: 0, observedAt: "2026-10-04T12:00:00.000Z", asOf: null, period: null, historical: false, ...overrides };
}
