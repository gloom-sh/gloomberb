import type { CatalystEvent, CatalystResponse } from "../../../api-client/catalysts";
export const catalystFixture = {
  id: "event-1", revisionId: "100", revision: 2, type: "clinical", agency: "FDA", jurisdiction: "US", country: "US", sector: "Healthcare",
  title: "Primary completion date updated", summary: "", status: "RECRUITING", announcedDate: "2026-01-01", effectiveDate: null, deadlineDate: "2027-04-01",
  datePrecision: { announced: "day", deadline: "month" }, source: "clinicaltrials", externalId: "NCT1", sourceUrl: "https://clinicaltrials.gov/study/NCT1",
  observedAt: "2026-10-04T12:00:00.000Z", firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-10-04T12:00:00.000Z", confidence: 1,
  language: "en", quote: null, quoteOffset: null, quoteSourceLength: null, quoteMatchMode: null, opinion: null, supersedesRevisionId: "99",
  changes: [{ field: "deadlineDate", before: "2027-03-01", after: "2027-04-01" }],
  parties: [{ name: "Pfizer Inc", entityId: "pfe", ticker: "PFE", exchange: "NYSE", resolution: "identifier", confidence: 1 }],
} satisfies CatalystEvent;
export function catalystPayload(): CatalystResponse {
  return { events: [catalystFixture], total: 1, limit: 100, offset: 0, asOf: catalystFixture.observedAt, filters: {},
    facets: { types: ["clinical"], agencies: ["FDA"], countries: ["US"], sectors: ["Healthcare"], statuses: ["RECRUITING"] },
    coverage: { sources: [], totalEvents: 1, linkedEvents: 1, unresolvedParties: 0, jurisdictions: ["US"], firstObservedAt: catalystFixture.firstSeenAt, lastObservedAt: catalystFixture.observedAt },
    access: { pro: true, lockedRows: 0, previewLimit: 3 } };
}
