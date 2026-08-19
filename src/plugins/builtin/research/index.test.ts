import { describe, expect, test } from "bun:test";
import type { AnalystRatingRecord, AnalystResearchData } from "../../../types/financials";
import {
  buildAnalystSummaryLines,
  buildRatingColumns,
  formatRatingTarget,
  nextRatingSortPreference,
  sortRatingRows,
  type RatingSortPreference,
} from "./analyst-pane";
import { buildEventRows, matchEarningsSecFiling } from "./corporate-actions-pane";

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
      priorPriceTarget: 0,
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
});

describe("analyst summary", () => {
  test("keeps target range and recommendation mix in the body summary", () => {
    const lines = buildAnalystSummaryLines({
      providerId: "test",
      symbol: "AMD",
      currency: "USD",
      priceTarget: {
        current: 467.5,
        average: 472.17,
        low: 225,
        median: 482.5,
        high: 625,
        currency: "USD",
      },
      recommendationRating: 8.8,
      recommendations: [{
        period: "current month",
        strongBuy: 12,
        buy: 18,
        hold: 4,
        sell: 1,
        strongSell: 0,
      }],
      ratings,
      earningsEstimates: [],
      revenueEstimates: [],
    } satisfies AnalystResearchData);

    expect(lines[0]).toBe("low $225.00   med $482.50   high $625.00");
    expect(lines[1]).toBe("rating 8.8/10   SB 12  B 18  H 4  S 1   35 analysts (month)");
  });
});

describe("event rows", () => {
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
      detail: "22E/18R",
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
      detail: "12R",
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
        { date: "2026-05-01", epsActual: 1.24, surprisePercent: 4.2 },
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

    const earnings = rows.find((row) => row.id === "earn:2026-05-01");
    const ttm = rows.find((row) => row.status === "TTM");

    expect(earnings).toMatchObject({
      status: "Earnings",
      period: "Q26-03-31",
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
      { id: "split:2025-12-01:4-for-1 split", status: "Split", value: "1:4" },
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
  });
});
