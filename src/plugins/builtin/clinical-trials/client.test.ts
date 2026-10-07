import { describe, expect, test } from "bun:test";
import {
  buildStudiesUrl,
  parseClinicalTrial,
  parseClinicalTrialsPage,
} from "./client";

function studyFixture(overrides: Record<string, unknown> = {}) {
  return {
    protocolSection: {
      identificationModule: {
        nctId: "NCT05123456",
        briefTitle: "Pembrolizumab in NSCLC",
        officialTitle: "A Phase 3 Study of Pembrolizumab in NSCLC",
      },
      statusModule: {
        overallStatus: "RECRUITING",
        startDateStruct: { date: "2024-01-15", type: "ACTUAL" },
        primaryCompletionDateStruct: { date: "2026-03", type: "ESTIMATED" },
        completionDateStruct: { date: "2026-06-30", type: "ESTIMATED" },
        studyFirstSubmitDate: "2023-10-01",
      },
      sponsorCollaboratorsModule: {
        leadSponsor: { name: "Merck Sharp & Dohme LLC", class: "INDUSTRY" },
      },
      designModule: {
        studyType: "INTERVENTIONAL",
        phases: ["PHASE3"],
        enrollmentInfo: { count: 450, type: "ESTIMATED" },
      },
      conditionsModule: { conditions: ["Non-Small Cell Lung Cancer"] },
      descriptionModule: { briefSummary: "Testing pembrolizumab efficacy." },
      ...overrides,
    },
  };
}

describe("clinical trials parsing", () => {
  test("parses a v2 study, keeping each date's precision and whether it is actual or estimated", () => {
    const trial = parseClinicalTrial(studyFixture());
    expect(trial).toMatchObject({
      nctId: "NCT05123456",
      title: "Pembrolizumab in NSCLC",
      status: "RECRUITING",
      phases: ["PHASE3"],
      sponsor: "Merck Sharp & Dohme LLC",
      sponsorClass: "INDUSTRY",
      enrollment: 450,
      startDatePrecision: "day",
      startDateType: "ACTUAL",
      primaryCompletionDatePrecision: "month",
      primaryCompletionDateType: "ESTIMATED",
      completionDateType: "ESTIMATED",
      url: "https://clinicaltrials.gov/study/NCT05123456",
    });
    expect(trial?.primaryCompletionDate?.toISOString().slice(0, 7)).toBe("2026-03");

    const bare = parseClinicalTrial({ protocolSection: { identificationModule: { nctId: "NCT00000001" } } });
    expect(bare).toMatchObject({ title: "NCT00000001", status: "UNKNOWN", startDate: null, completionDate: null });
    expect(bare?.completionDateType).toBeUndefined();
  });

  test("keeps the next page token and drops studies without an NCT id", () => {
    const page = parseClinicalTrialsPage({
      totalCount: 806,
      nextPageToken: "ZVNj7o2Elu8o3lpw",
      studies: [studyFixture(), {}, { protocolSection: { identificationModule: {} } }],
    });
    expect(page.trials).toHaveLength(1);
    expect(page.nextPageToken).toBe("ZVNj7o2Elu8o3lpw");
    expect(parseClinicalTrialsPage({ studies: [] }).nextPageToken).toBeNull();
  });

  test("asks for the next page by its token, in the order the pane lists studies", () => {
    const first = new URL(buildStudiesUrl({ term: "diabetes", sponsor: "Pfizer" }));
    expect(first.searchParams.get("query.term")).toBe("diabetes");
    expect(first.searchParams.get("query.spons")).toBe("Pfizer");
    expect(first.searchParams.get("sort")).toBe("StudyFirstPostDate:desc");
    expect(first.searchParams.has("pageToken")).toBe(false);

    const next = new URL(buildStudiesUrl({ term: "diabetes", pageToken: "abc" }));
    expect(next.searchParams.get("pageToken")).toBe("abc");
    expect(next.searchParams.get("sort")).toBe("StudyFirstPostDate:desc");
  });
});
