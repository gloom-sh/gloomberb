import { describe, expect, test } from "bun:test";
import { buildEventDetail, matchEarningsSecFiling, type EventDetailSection } from "./event-detail";
import { buildEventRows } from "./event-model";

/** The detail as text, one line per heading, labelled figure or note. */
function detailText(sections: EventDetailSection[]): string {
  return sections.flatMap((section) => [
    ...(section.title ? [section.title] : []),
    ...section.blocks.map((block) => block.kind === "row" ? `${block.label}: ${block.value}` : block.text),
  ]).join("\n");
}

describe("event detail", () => {
  test("the earnings drilldown distinguishes diluted filing measures from the street observations", () => {
    const row = buildEventRows({ symbol: "DELL", splits: [], dividends: [], earnings: [{ date: "2026-11-24", currency: "USD", epsActual: 9.45, gaapEps: 8.82,
      epsBasis: "company-adjusted", streetEps: { actual: 9.16, estimate: 6.55, analysts: 8, actualBasis: "including-stock-compensation" } }] }, null, null, "USD")[0]!;
    const text = detailText(buildEventDetail({ row, secFilingsLoading: false, filing: null, documents: [], documentsLoading: false,
      inlineContent: new Map(), primaryContent: null, primaryContentLoading: false }));
    expect(row.detail).toContain("company-adjusted diluted");
    for (const figure of ["Actual: 9.45 USD", "GAAP diluted EPS: 8.82 USD", "Street actual: 9.16 USD", "Street estimate: 6.55 USD"]) expect(text).toContain(figure);
    expect(text).not.toContain("Surprise:");
  });

  test("estimate drilldown and JSON retain distinct EPS/revenue inputs, currencies and attribution", () => {
    const eps = { date: "2026-09-30", period: "current quarter", currency: "USD", average: 4.4, low: 4, high: 5, yearAgo: 0, growth: 0, analysts: 12 };
    const revenue = { date: eps.date, period: eps.period, currency: "TWD", average: 1.45e12, low: 1.4e12, high: 1.5e12, yearAgo: 1e12, growth: .45, analysts: 20 };
    const rows = buildEventRows(null, { symbol: "TSM", providerId: "gloom", fetchedAt: "2026-09-11T12:00:00Z",
      recommendations: [], ratings: [], earningsEstimates: [eps], revenueEstimates: [revenue] }, null, "USD");
    const row = JSON.parse(JSON.stringify(rows[0]));
    expect(row).toMatchObject({ estimateInputs: { eps, revenue }, estimateGrowthMetric: "eps", providerId: "gloom", fetchedAt: "2026-09-11T12:00:00Z" });
    const detail = detailText(buildEventDetail({ row, secFilingsLoading: false, filing: null, documents: [], documentsLoading: false,
      inlineContent: new Map(), primaryContent: null, primaryContentLoading: false }));
    expect(detail).toContain("EPS consensus\nAverage: 4.4 USD\nLow: 4 USD\nHigh: 5 USD\nPrior year: 0 USD\nGrowth: 0.00%");
    expect(detail).toContain("Revenue consensus\nAverage: 1,450,000,000,000 TWD\nLow: 1,400,000,000,000 TWD\nHigh: 1,500,000,000,000 TWD");
    expect(detail).toContain("Growth: +45.00%");
    expect(detail).toContain("As of: 2026-09-11T12:00:00Z");
    // The pane says what the figures are, never which feed served them.
    expect(detail).not.toContain("gloom");
  });

  test("a press release's actual says it is provisional and where it is from", () => {
    const actual = (epsActualSource?: "press-release") => buildEventDetail({
      row: buildEventRows({ symbol: "TRV", dividends: [], splits: [], earnings: [
        { date: "2026-10-16", dateType: "announcement", currency: "USD", fiscalPeriod: "2026-09", epsEstimate: 7.07, epsActual: 9.18,
          difference: 2.11, epsBasis: "adjusted", dateStatus: "reported", ...(epsActualSource ? { epsActualSource } : {}) },
      ] }, null, null, "USD").find((candidate) => candidate.status === "Earnings")!,
      secFilingsLoading: false, filing: null, documents: [], documentsLoading: false, inlineContent: new Map(), primaryContent: null,
      primaryContentLoading: false,
    }).flatMap((section) => section.blocks).find((block) => block.kind === "row" && block.label === "Actual");
    expect(actual("press-release")).toEqual({ kind: "row", label: "Actual", value: "9.18 USD",
      detail: "adjusted, provisional, from the company's press release" });
    expect(actual(undefined)).toEqual({ kind: "row", label: "Actual", value: "9.18 USD", detail: "basis unknown" });
  });

  test("matches reported earnings to nearby SEC earnings-release filings", () => {
    const row = buildEventRows({
      symbol: "AAPL",
      dividends: [],
      splits: [],
      earnings: [{ date: "2026-01-30", epsActual: 2.4 }],
    }, null, null, "USD").find((candidate) => candidate.status === "Earnings");
    const filings = [
      {
        accessionNumber: "0000320193-26-000010",
        form: "10-Q",
        filingDate: new Date("2026-02-04T00:00:00Z"),
        cik: "0000320193",
        filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/0000320193-26-000010-index.htm",
      },
      {
        accessionNumber: "0000320193-26-000009",
        form: "8-K",
        filingDate: "2026-01-31T00:00:00.000Z" as unknown as Date,
        items: "2.02,9.01",
        primaryDocDescription: "Results of Operations and Financial Condition",
        cik: "0000320193",
        filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/0000320193-26-000009-index.htm",
      },
    ];

    expect(matchEarningsSecFiling(row, filings)?.accessionNumber).toBe("0000320193-26-000009");
    expect(matchEarningsSecFiling({ ...row!, dateType: "fiscal-period-end" }, filings)).toBeNull();
    const periodRow = { ...row!, dateType: "fiscal-period-end" as const,
      dateEvidence: { accessionNumber: "0000320193-26-000010", filed: "2026-02-04", startDate: "2025-10-01" } };
    expect(matchEarningsSecFiling(periodRow, filings)?.form).toBe("10-Q");
    const detail = detailText(buildEventDetail({ row: periodRow, secFilingsLoading: false,
      filing: filings[0]!, documents: [], documentsLoading: false, inlineContent: new Map(),
      primaryContent: "Fiscal statement content", primaryContentLoading: false }));
    expect(detail).toContain("Fiscal statement content");
  });
});
