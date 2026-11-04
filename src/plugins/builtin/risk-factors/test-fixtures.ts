import type { CloudRiskReportListPayload, CloudRiskReportPayload } from "../../../api-client";

const company = { ticker: "ACME", cik: "0000000001", name: "Acme Corp", shortName: "Acme" };

export function report(year: number): CloudRiskReportPayload {
  return {
    id: `acme-${year}`,
    ticker: "ACME",
    company,
    reportYear: year,
    filedAt: `${year}-02-03T00:00:00Z`,
    updatedAt: `${year}-02-04T12:30:00Z`,
    riskCount: 1,
    groupCount: 1,
    wordCount: 100,
    addedCount: null,
    removedCount: null,
    rewordedCount: null,
    overview: `Only ${year} risk analysis`,
    docUrl: `https://www.sec.gov/Archives/acme-${year}.htm`,
    groups: ["Business"],
    risks: [{ heading: `Unique ${year} supply-chain exposure`, group: "Business", excerpt: `Source ${year} text`, words: 100 }],
    diff: null,
    notes: { added: [], removed: [], reworded: [], top: [] },
    otherYears: [],
  };
}

/** A 10-K that lists no risk factors, as the server reports it. */
export function noRiskFactorsReport(year: number): CloudRiskReportPayload {
  return {
    ...report(year),
    riskCount: 0,
    groupCount: 0,
    wordCount: 0,
    overview: "This 10-K lists no risk factors (the company is not required to).",
    listsNoRiskFactors: true,
    groups: [],
    risks: [],
  };
}

export function list(years: number[]): CloudRiskReportListPayload {
  return { company, reports: years.map(report) };
}
