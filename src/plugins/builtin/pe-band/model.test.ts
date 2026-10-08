import { describe, expect, test } from "bun:test";
import type { FinancialStatement, PricePoint, Quote, TickerFinancials } from "../../../types/financials";
import { chooseMultiples, projectPeBand, stepAt, trailingEpsSteps } from "./model";
import type { ReportDate } from "./report-dates";

const quarter = (date: string, eps: number | null, filed: string): FinancialStatement => ({
  date, currency: "USD", fieldAvailability: { eps: filed },
  ...(eps == null ? { unavailableEarnings: ["eps" as const] } : { eps }),
});
const unfiled = (date: string, eps: number): FinancialStatement => ({ date, currency: "USD", eps });
const financials = (quarterlyStatements: FinancialStatement[], annualStatements: FinancialStatement[] = [], quote?: Partial<Quote>): TickerFinancials =>
  ({ quarterlyStatements, annualStatements, priceHistory: [], quote: quote as Quote | undefined });

describe("P/E band", () => {
  test("sums four reported quarters, keeps sums that need a withheld quarter unavailable, and holds the last figure across them", () => {
    const data = financials([
      quarter("2023-03-31", 1, "2023-04-30"), quarter("2023-06-30", 1, "2023-07-30"), quarter("2023-09-30", 1, "2023-10-30"),
      quarter("2023-12-31", 1, "2024-01-30"), quarter("2024-03-31", null, "2024-04-30"), quarter("2024-06-30", 2, "2024-07-30"),
      quarter("2024-09-30", 2, "2024-10-30"), quarter("2024-12-31", 2, "2025-01-30"), quarter("2025-03-31", -9, "2025-04-30"),
      // Restated onto a split's share count: known when first filed, not when the split was evidenced.
      { ...quarter("2025-06-30", 2, "2026-03-01"), epsBasis: { status: "split-adjusted", source: "sec", originalValue: 4, originalFiled: "2025-07-30",
        basisDate: "2026-02-01", evidence: [], factor: 2 } },
    ], [{ date: "2024-12-31", currency: "USD", eps: 7, fieldAvailability: { eps: "2025-02-15" } }]);
    const steps = trailingEpsSteps(data);
    const at = (date: string) => steps.find((step) => step.periodEnd === date);

    expect(at("2023-12-31")).toMatchObject({ basis: "ttm", eps: 4, dated: true });
    expect(at("2023-12-31")!.knownAt.toISOString().slice(0, 10)).toBe("2024-01-30");
    expect(["2024-03-31", "2024-06-30", "2024-09-30"].map((date) => at(date)?.eps)).toEqual([null, null, null]);
    // The reported year stands in for the quarterly sum the withheld quarter makes unavailable.
    expect(at("2024-12-31")).toMatchObject({ basis: "annual", eps: 7 });
    expect(at("2025-03-31")!.eps).toBeCloseTo(-3, 10);
    expect(at("2025-06-30")!.knownAt.toISOString().slice(0, 10)).toBe("2025-07-30");

    expect(stepAt(steps, Date.parse("2024-08-01"))?.periodEnd).toBe("2023-12-31");
    expect(stepAt(steps, Date.parse("2025-05-15"))?.eps).toBeCloseTo(-3, 10);
    // Sixteen months after its period end a figure no longer prices the stock.
    expect(stepAt(steps.filter((step) => step.periodEnd <= "2023-12-31"), Date.parse("2025-06-01"))).toBeNull();

    const weeks: PricePoint[] = ["2024-02-05", "2024-08-05", "2025-03-03", "2025-05-19"].map((date, index) => ({ date: new Date(date), close: 40 + index * 10 }));
    const model = projectPeBand({ ...data, quote: { price: 80, currency: "USD" } as Quote }, weeks,
      { symbol: "X", lookbackYears: 0, now: Date.parse("2025-06-01") });
    // A loss leaves the week without a P/E or a band; it is not a negative multiple.
    expect(model.weeks.map((week) => week.pe)).toEqual([10, 12.5, 60 / 7, null]);
    expect(model.current).toMatchObject({ price: 80, pe: null });
    expect(model.unavailable).toBe(3);
    expect(model.rows.map((row) => row.periodEnd)).not.toContain("2024-06-30");
  });

  test("picks round multiples across the history, ranks today's P/E in it, and refuses EPS in another currency", () => {
    expect(chooseMultiples(Array.from({ length: 12 }, (_, index) => 20 + index))).toEqual([20, 25, 30]);
    expect(chooseMultiples([18.2, 18.5, 18.9])).toEqual([18, 19, 20]);
    expect(chooseMultiples([-5, 0])).toEqual([]);
    // A decade at hundreds of times earnings must not lift every line off a stock now at 20.2x (AMZN):
    // without today's P/E the lines sit at 200x-600x, with it they bracket 20.2x.
    const richPast = [20, 25, 30, 40, 60, 80, 300, 500, 600, 668];
    expect(chooseMultiples(richPast)).toEqual([200, 400, 600]);
    expect(chooseMultiples(richPast, 20.2)).toEqual([20, 30, 40]);
    // Today below the whole history still gets a line under it.
    expect(chooseMultiples(Array.from({ length: 12 }, (_, index) => 20 + index), 19.6)).toEqual([15, 20, 25, 30]);

    const quarters = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"].map((date) => quarter(date, 2.5, date));
    const weeks = [80, 100, 120, 160].map((close, index) => ({ date: new Date(Date.UTC(2026, 0, 5 + 7 * index)), close }));
    const model = projectPeBand(financials(quarters, [], { price: 140, currency: "USD" }), weeks,
      { symbol: "X", lookbackYears: 10, now: Date.parse("2026-02-01") });
    expect(model.current?.pe).toBe(14);
    expect(model.current?.percentile).toBe(75);
    expect(model.range).toEqual({ min: 8, median: 11, max: 16 });
    expect(model.sample).toEqual({ start: new Date(Date.UTC(2026, 0, 5)), weeks: 4 });

    // Pence prices against pound statements need no FX rate; dollars against Taiwan dollars do.
    const pence = projectPeBand(financials(quarters.map((row) => ({ ...row, currency: "GBP" })), [], { price: 1400, currency: "GBp" }), weeks,
      { symbol: "X", lookbackYears: 10, now: Date.parse("2026-02-01") });
    expect(pence.current?.pe).toBe(1.4);
    expect(projectPeBand(financials(quarters.map((row) => ({ ...row, currency: "TWD" })), [], { price: 140, currency: "USD" }), weeks,
      { symbol: "X", lookbackYears: 10 }).error).toBe("EPS is reported in TWD and the price is in USD.");
  });

  test("a report dates the figures with no publication date, so the weeks before it no longer price an unreleased EPS", () => {
    // The fiscal fourth quarter has no filing date on record, as in the SEC history of a company whose year ends in December.
    const quarters = [
      quarter("2023-12-31", 1, "2024-02-05"), quarter("2024-03-31", 1, "2024-05-01"), quarter("2024-06-30", 1, "2024-08-01"),
      quarter("2024-09-30", 1, "2024-11-01"), unfiled("2024-12-31", 2), quarter("2025-03-31", 2, "2025-05-01"),
    ];
    const reports: ReportDate[] = [
      { date: "2025-02-06", fiscalPeriod: "2024-12", reportedAt: "2025-02-06T21:30:00.000Z" },
      // Earlier and later than the filing dates on record: the statements' own dates stand.
      { date: "2024-10-30", fiscalPeriod: "2024-09", reportedAt: null }, { date: "2025-05-20", fiscalPeriod: "2025-03", reportedAt: null },
    ];
    const data = financials(quarters, [], { price: 120, currency: "USD" });
    const weeks: PricePoint[] = [["2025-01-06", 100], ["2025-02-10", 100], ["2025-04-07", 110], ["2025-05-05", 120]]
      .map(([date, close]) => ({ date: new Date(date as string), close: close as number }));
    const options = { symbol: "X", lookbackYears: 0, now: Date.parse("2025-06-01") };

    const today = projectPeBand(data, weeks, options);
    // Both sums that contain the undated quarter step at their period end, weeks before anyone could know them.
    expect(today.weeks.map((week) => week.pe)).toEqual([20, 20, 110 / 6, 20]);
    expect(today.undated).toBe(2);

    const dated = projectPeBand(data, weeks, { ...options, reports });
    // January prices the figure in force (4); the year's 5 arrives with the report and 6 with the quarter's filing.
    expect(dated.weeks.map((week) => week.pe)).toEqual([25, 20, 22, 20]);
    expect(dated.undated).toBe(0);
    const steps = trailingEpsSteps(data, reports);
    const known = (periodEnd: string) => steps.find((step) => step.periodEnd === periodEnd)!;
    expect(known("2024-12-31")).toMatchObject({ dated: true, eps: 5 });
    expect(known("2024-12-31").knownAt.toISOString()).toBe("2025-02-06T21:30:00.000Z");
    expect(known("2024-09-30").knownAt.toISOString().slice(0, 10)).toBe("2024-11-01");
    // A sum is known when its newest quarter is, never before the report of the older one.
    expect(known("2025-03-31")).toMatchObject({ dated: true, eps: 6 });
    expect(known("2025-03-31").knownAt.toISOString().slice(0, 10)).toBe("2025-05-01");
    expect(dated.rows.find((row) => row.periodEnd === "2024-12-31")).toMatchObject({ dated: true, price: 100 });
  });

  test("a sum with one quarter no report covers stays undated even when its newest quarter is dated", () => {
    const quarters = [
      quarter("2023-12-31", 1, "2024-02-05"), quarter("2024-03-31", 1, "2024-05-01"), unfiled("2024-06-30", 1),
      quarter("2024-09-30", 1, "2024-11-01"), quarter("2024-12-31", 2, "2025-02-06"),
    ];
    const noMatch: ReportDate[] = [{ date: "2024-08-01", fiscalPeriod: "2024-03", reportedAt: null }];
    const steps = trailingEpsSteps(financials(quarters), noMatch);
    expect(steps.map((step) => [step.periodEnd, step.dated])).toEqual([["2024-09-30", false], ["2024-12-31", false]]);
    expect(steps.every((step) => step.knownAt.toISOString().slice(0, 10) === step.periodEnd)).toBe(true);
    // The same quarter, once a report covers it, dates both sums.
    const covered = trailingEpsSteps(financials(quarters), [{ date: "2024-08-01", fiscalPeriod: "2024-06", reportedAt: null }]);
    expect(covered.map((step) => [step.periodEnd, step.dated, step.knownAt.toISOString().slice(0, 10)]))
      .toEqual([["2024-09-30", true, "2024-11-01"], ["2024-12-31", true, "2025-02-06"]]);
  });
});
