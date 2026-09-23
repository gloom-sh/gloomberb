import { describe, expect, test } from "bun:test";
import type { AnalystRatingRecord, AnalystResearchData } from "../../../types/financials";
import {
  buildRatingColumns,
  formatRatingTarget,
  nextRatingSortPreference,
  sortRatingRows,
  type RatingSortPreference,
} from "./analyst-pane";
import { ratingTargetDelta } from "./analyst-model";
import { buildEventDetail, buildEventRows, matchEarningsSecFiling, type EventDetailSection } from "./corporate-actions-pane";
import { eventSourceNotice } from "./event-model";

const ratings: AnalystRatingRecord[] = [
  {
    date: "2026-05-06",
    firm: "Beta Capital",
    action: "Raises",
    current: "Neutral",
    prior: "Neutral",
    currentPriceTarget: 385,
    priorPriceTarget: 270,
  },
  {
    date: "2026-05-07",
    firm: "Alpha Research",
    action: "Downgrade",
    current: "Hold",
    prior: "Buy",
    currentPriceTarget: 340,
    priorPriceTarget: 335,
  },
  {
    date: "2026-05-06",
    firm: "Zenith",
    action: "Upgrade",
    current: "Buy",
    prior: "Neutral",
    currentPriceTarget: 525,
    priorPriceTarget: 265,
  },
  {
    date: "2026-05-05",
    firm: "No Target",
    action: "Reiterates",
    current: "Buy",
    prior: "Buy",
  },
];


/** The detail as text, one line per heading, labelled figure or note. */
function detailText(sections: EventDetailSection[]): string {
  return sections.flatMap((section) => [
    ...(section.title ? [section.title] : []),
    ...section.blocks.map((block) => block.kind === "row" ? `${block.label}: ${block.value}` : block.text),
  ]).join("\n");
}

describe("analyst rating sorting", () => {
  test("sorts date newest first by default", () => {
    const preference: RatingSortPreference = { columnId: "date", direction: "desc" };

    expect(sortRatingRows(ratings, preference).map((row) => row.firm)).toEqual([
      "Alpha Research",
      "Beta Capital",
      "Zenith",
      "No Target",
    ]);
  });

  test("sorts target by current target value with missing targets last", () => {
    const preference: RatingSortPreference = { columnId: "target", direction: "desc" };

    expect(sortRatingRows(ratings, preference).map((row) => row.firm)).toEqual([
      "Zenith",
      "Beta Capital",
      "Alpha Research",
      "No Target",
    ]);
  });

  test("sorts text columns alphabetically with recent dates as a tie-breaker", () => {
    const preference: RatingSortPreference = { columnId: "firm", direction: "asc" };

    expect(sortRatingRows(ratings, preference).map((row) => row.firm)).toEqual([
      "Alpha Research",
      "Beta Capital",
      "No Target",
      "Zenith",
    ]);
  });

  test("uses sensible first-click directions per column", () => {
    expect(nextRatingSortPreference({ columnId: "date", direction: "desc" }, "date")).toEqual({
      columnId: "date",
      direction: "asc",
    });
    expect(nextRatingSortPreference({ columnId: "date", direction: "desc" }, "target")).toEqual({
      columnId: "target",
      direction: "desc",
    });
    expect(nextRatingSortPreference({ columnId: "target", direction: "desc" }, "firm")).toEqual({
      columnId: "firm",
      direction: "asc",
    });
  });
});

describe("analyst rating columns", () => {
  test("widens the target column for formatted price target changes", () => {
    const columns = buildRatingColumns(
      [
        {
          date: "2026-04-16",
          firm: "RBC Capital",
          action: "Raises",
          current: "Outperform",
          prior: "Outperform",
          currentPriceTarget: 1725,
          priorPriceTarget: 1625,
        },
      ],
      "USD",
    );

    expect(columns.find((column) => column.id === "target")?.width).toBe(16);
  });

  test("aligns target arrows across mixed price widths", () => {
    const narrowPrior: AnalystRatingRecord = {
      date: "2026-05-01",
      firm: "Alpha",
      action: "Raises",
      current: "Outperform",
      prior: "Outperform",
      currentPriceTarget: 220,
      priorPriceTarget: 9,
    };
    const widePrior: AnalystRatingRecord = {
      date: "2026-05-02",
      firm: "Beta",
      action: "Raises",
      current: "Outperform",
      prior: "Outperform",
      currentPriceTarget: 230,
      priorPriceTarget: 230,
    };
    const targetColumn = buildRatingColumns([narrowPrior, widePrior], "USD")
      .find((column) => column.id === "target");

    expect(formatRatingTarget(narrowPrior, "USD", targetColumn).indexOf("→")).toBe(
      formatRatingTarget(widePrior, "USD", targetColumn).indexOf("→"),
    );
  });

  test("a cached first target's 0 prior reads as no prior target", () => {
    const first: AnalystRatingRecord = { date: "2026-08-04", firm: "China Renaissance", currentPriceTarget: 280, priorPriceTarget: 0 };
    expect(formatRatingTarget(first, "USD")).toBe(" $280");
    expect(ratingTargetDelta(first)).toBeNull();
  });
});

describe("event rows", () => {
  test("estimate drilldown and JSON retain distinct EPS/revenue inputs, currencies and attribution", () => {
    const eps = { date: "2026-09-30", period: "current quarter", currency: "USD", average: 4.4, low: 4, high: 5, yearAgo: 0, growth: 0, analysts: 12 };
    const revenue = { date: eps.date, period: eps.period, currency: "TWD", average: 1.45e12, low: 1.4e12, high: 1.5e12, yearAgo: 1e12, growth: .45, analysts: 20 };
    const rows = buildEventRows(null, { symbol: "TSM", providerId: "yahoo", fetchedAt: "2026-09-11T12:00:00Z",
      recommendations: [], ratings: [], earningsEstimates: [eps], revenueEstimates: [revenue] }, null, "USD");
    const row = JSON.parse(JSON.stringify(rows[0]));
    expect(row).toMatchObject({ estimateInputs: { eps, revenue }, estimateGrowthMetric: "eps", providerId: "yahoo", fetchedAt: "2026-09-11T12:00:00Z" });
    const detail = detailText(buildEventDetail({ row, secFilingsLoading: false, filing: null, documents: [], documentsLoading: false,
      inlineContent: new Map(), primaryContent: null, primaryContentLoading: false }));
    expect(detail).toContain("EPS consensus\nAverage: 4.4 USD\nLow: 4 USD\nHigh: 5 USD\nPrior year: 0 USD\nGrowth: 0.00%");
    expect(detail).toContain("Revenue consensus\nAverage: 1,450,000,000,000 TWD\nLow: 1,400,000,000,000 TWD\nHigh: 1,500,000,000,000 TWD");
    expect(detail).toContain("Growth: +45.00%");
    expect(detail).toContain("As of: 2026-09-11T12:00:00Z");
    // The pane says what the figures are, never which feed served them.
    expect(detail).not.toContain("yahoo");
  });

  test("combines EPS and revenue estimates into one estimate row", () => {
    const rows = buildEventRows(null, {
      symbol: "AAPL",
      recommendations: [],
      ratings: [],
      earningsEstimates: [
        { date: "2026-06-30", period: "next_quarter", average: 1.5, analysts: 22 },
      ],
      revenueEstimates: [
        { date: "2026-06-30", period: "next_quarter", average: 100_000_000, analysts: 18, growth: 0.12 },
      ],
    } satisfies AnalystResearchData, null, "USD");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-06-30",
      status: "Q Est",
      period: "next qtr",
      detail: "22 EPS / 18 rev analysts",
      qEps: 1.5,
      qRevenue: 100_000_000,
      annualEps: undefined,
      annualRevenue: undefined,
      value: "+12.00%",
      tone: "positive",
    });
  });

  test("puts fiscal estimates in annual columns", () => {
    const rows = buildEventRows(null, {
      symbol: "AAPL",
      recommendations: [],
      ratings: [],
      earningsEstimates: [
        { date: "2026-12-31", period: "current_year", average: 7.5, analysts: 24 },
      ],
      revenueEstimates: [
        { date: "2026-12-31", period: "current_year", average: 410_000_000_000, analysts: 21 },
      ],
    } satisfies AnalystResearchData, null, "USD");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "FY Est",
      period: "cur yr",
      qEps: undefined,
      qRevenue: undefined,
      annualEps: 7.5,
      annualRevenue: 410_000_000_000,
    });
  });

  test("keeps revenue-only estimates as estimate rows", () => {
    const rows = buildEventRows(null, {
      symbol: "AAPL",
      recommendations: [],
      ratings: [],
      earningsEstimates: [],
      revenueEstimates: [
        { date: "2026-03-31", period: "current_quarter", average: 95_000_000, analysts: 12 },
      ],
    } satisfies AnalystResearchData, null, "USD");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "Q Est",
      period: "cur qtr",
      detail: "12 rev analysts",
      qEps: undefined,
      qRevenue: 95_000_000,
    });
  });

  test("adds reported quarterly revenue and TTM without mixing metric columns", () => {
    const actions = {
      symbol: "AAPL",
      dividends: [],
      splits: [],
      earnings: [
        { date: "2026-03-31", dateType: "fiscal-period-end" as const, epsActual: 1.24, surprisePercent: 4.2 },
      ],
    };
    const financials = {
      quarterlyStatements: [
        { date: "2025-06-30", totalRevenue: 80, eps: 1 },
        { date: "2025-09-30", totalRevenue: 90, eps: 1.1 },
        { date: "2025-12-31", totalRevenue: 100, eps: 1.2 },
        { date: "2026-03-31", totalRevenue: 110, eps: 1.3 },
      ],
    };
    const rows = buildEventRows(actions, null, financials, "USD");

    const earnings = rows.find((row) => row.status === "Earnings" && row.date === "2026-03-31");
    const ttm = rows.find((row) => row.status === "TTM");

    expect(earnings).toMatchObject({
      status: "Earnings",
      period: "Mar 2026",
      qEps: 1.24,
      qRevenue: 110,
    });
    expect(earnings?.annualEps).toBeUndefined();
    expect(earnings?.annualRevenue).toBeUndefined();
    expect(ttm).toMatchObject({
      date: "2026-03-31",
      status: "TTM",
      period: "4 qtrs",
      annualEps: 4.6,
      annualRevenue: 380,
    });
    expect(ttm?.qEps).toBeUndefined();
    expect(ttm?.qRevenue).toBeUndefined();
  });

  test("sums the reported quarter EPS shown above the TTM row instead of statement GAAP EPS", () => {
    // UNH: reported (adjusted) 2.92, 2.11, 7.23, 6.38 against GAAP 2.59, 0.02, 6.90, 6.04.
    const reported = [["2025-09-30", 2.92], ["2025-12-31", 2.11], ["2026-03-31", 7.23], ["2026-06-30", 6.38]] as const;
    const actions = {
      symbol: "UNH",
      dividends: [],
      splits: [],
      earnings: [
        { date: "2026-10-13", dateType: "announcement" as const, epsEstimate: 4.15 },
        ...reported.map(([date, epsActual]) => ({ date, dateType: "fiscal-period-end" as const, currency: "USD", epsActual })),
      ],
    };
    const financials = {
      financialCurrency: "USD",
      quarterlyStatements: [["2025-06-30", 4.08], ["2025-09-30", 2.59], ["2025-12-31", 0.02], ["2026-03-31", 6.9], ["2026-06-30", 6.04]]
        .map(([date, eps]) => ({ date: date as string, eps: eps as number, totalRevenue: 100 })),
    };
    const ttm = () => buildEventRows(actions, null, financials, "USD").find((row) => row.status === "TTM");
    expect(ttm()?.annualEps).toBeCloseTo(18.64, 10);
    expect(ttm()).toMatchObject({ date: "2026-06-30", epsCurrency: "USD", annualRevenue: 400, detail: "sum" });

    // A quarter without its reported row cannot be summed from the rows, so the statement TTM
    // stays and is not labelled as their sum (ADBE: Yahoo omitted two of the last four quarters).
    actions.earnings.splice(1, 1);
    expect(ttm()?.annualEps).toBeCloseTo(15.55, 10);
    expect(ttm()?.detail).toBe("statement EPS");
  });

  test("omits a TTM row when a flow metric is missing from one of the last four quarters", () => {
    const rows = buildEventRows(null, null, {
      quarterlyStatements: [
        { date: "2025-06-30", totalRevenue: 80, eps: 1 },
        { date: "2025-09-30", totalRevenue: 90 },
        { date: "2025-12-31", totalRevenue: 100, eps: 1.2 },
        { date: "2026-03-31", totalRevenue: 110, eps: 1.3 },
      ],
    }, "USD");

    expect(rows.find((row) => row.status === "TTM")?.annualEps).toBeUndefined();
    expect(rows.find((row) => row.status === "TTM")?.annualRevenue).toBe(380);
  });

  test("keeps dividends and splits in the event table without metric values", () => {
    const data = {
      symbol: "AAPL",
      dividends: [{ exDate: "2026-02-10", amount: 0.26 }],
      splits: [{ date: "2025-12-01", description: "4-for-1 split", fromFactor: 1, toFactor: 4 }],
      earnings: [{ date: "2026-01-30", epsActual: 2.4 }],
    };

    const rows = buildEventRows(data, null, null, "USD");

    expect(rows.map((row) => row.id)).toEqual([
      "div:2026-02-10",
      "earn:2026-01-30",
      "split:2025-12-01:4-for-1 split",
    ]);
    expect(rows).toMatchObject([
      { id: "div:2026-02-10", status: "Dividend", value: "$0.26" },
      { id: "earn:2026-01-30", status: "Earnings" },
      { id: "split:2025-12-01:4-for-1 split", status: "Factor", value: "4:1" },
    ]);
    expect(rows[0]?.qEps).toBeUndefined();
    expect(rows[0]?.annualEps).toBeUndefined();
    expect(rows[2]?.qEps).toBeUndefined();
    expect(rows[2]?.annualEps).toBeUndefined();
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

describe("event source notice", () => {
  const loaded = {
    variant: "corporate-actions" as const,
    symbol: "DBK",
    actions: { symbol: "DBK", dividends: [{ exDate: "2026-05-29", amount: 1 }], splits: [], earnings: [] },
    actionsError: null,
    estimates: {
      symbol: "DBK",
      recommendations: [],
      ratings: [],
      earningsEstimates: [{ date: "2026-12-31", period: "current_year", average: 3.3, analysts: 10 }],
      revenueEstimates: [],
    } satisfies AnalystResearchData,
    estimatesError: null,
  };

  test("stays quiet when both sources delivered", () => {
    expect(eventSourceNotice(loaded)).toBeNull();
  });

  /**
   * A failed corporate-actions request left the table showing only estimate and
   * TTM rows, which reads as a working pane for a company with no events.
   */
  test("names a failed source and marks it as a failure", () => {
    expect(eventSourceNotice({ ...loaded, actions: null, actionsError: "Cloud request failed" })).toEqual({
      text: "Corporate actions unavailable: Cloud request failed",
      failed: true,
    });
  });

  test("reports genuinely empty data without calling it a failure", () => {
    expect(eventSourceNotice({
      ...loaded,
      actions: { symbol: "DBK", dividends: [], splits: [], earnings: [] },
    })).toEqual({
      text: "No dividends, splits, or reported earnings for DBK",
      failed: false,
    });
  });
});
