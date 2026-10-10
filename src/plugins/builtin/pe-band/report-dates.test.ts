import { describe, expect, test } from "bun:test";
import type { EarningsHistoryPayload } from "../../../api-client/earnings";
import type { FinancialStatement } from "../../../types/financials";
import { datedByReport, reportDatesFrom, type ReportDate } from "./report-dates";

const report = (date: string, fiscalPeriod: string, reportedAt: string | null = null): ReportDate => ({ date, fiscalPeriod, reportedAt });
const row = (date: string, extra: Partial<FinancialStatement> = {}): FinancialStatement => ({ date, currency: "USD", eps: 2, ...extra });
const knownBy = (statement: FinancialStatement, reports: ReportDate[]) => datedByReport(statement, reports).fieldAvailability?.eps;

describe("report dates", () => {
  test("match a quarter by its fiscal month, through 52/53-week period ends, and never to another quarter", () => {
    // Apple, Nvidia, a period that ends the day after a month does, and a 53-week year that ends in January.
    expect(knownBy(row("2025-12-27"), [report("2026-01-29", "2025-12")])).toBe("2026-01-29");
    expect(knownBy(row("2026-01-25"), [report("2026-02-25", "2026-01")])).toBe("2026-02-25");
    expect(knownBy(row("2017-07-01"), [report("2017-08-01", "2017-06")])).toBe("2017-08-01");
    expect(knownBy(row("2026-01-03"), [report("2026-02-12", "2026-01")])).toBe("2026-02-12");

    const others = [report("2025-10-30", "2025-09"), report("2026-04-30", "2026-03")];
    expect(knownBy(row("2025-12-27"), others)).toBeUndefined();
    // A report that predates the period, or comes half a year after it, is not this quarter's.
    expect(knownBy(row("2025-12-27"), [report("2025-12-20", "2025-12")])).toBeUndefined();
    expect(knownBy(row("2025-12-27"), [report("2026-09-01", "2025-12")])).toBeUndefined();
    // Two dates for the same quarter are ambiguous; the same date twice is not.
    expect(knownBy(row("2025-12-27"), [report("2026-01-29", "2025-12"), report("2026-02-05", "2025-12")])).toBeUndefined();
    expect(knownBy(row("2025-12-27"), [report("2026-01-29", "2025-12"), report("2026-01-29", "2025-12")])).toBe("2026-01-29");
  });

  test("date a figure by its report unless it is on record earlier, and a fiscal year by the report of its last quarter", () => {
    const reports = [report("2025-10-30", "2025-09")];
    expect(knownBy(row("2025-09-27", { fieldAvailability: { eps: "2025-10-31" } }), reports)).toBe("2025-10-30");
    expect(knownBy(row("2025-09-27", { availableAt: "2025-11-03" }), reports)).toBe("2025-10-30");
    expect(knownBy(row("2025-09-27", { fieldAvailability: { eps: "2025-10-29" } }), reports)).toBe("2025-10-29");
    expect(datedByReport(row("2025-09-27", { eps: undefined }), reports).fieldAvailability).toBeUndefined();
    // A map that dates other lines still leaves EPS undated, and keeps them.
    expect(datedByReport(row("2025-09-27", { fieldAvailability: { netIncome: "2025-10-31" } }), reports).fieldAvailability)
      .toEqual({ netIncome: "2025-10-31", eps: "2025-10-30" });
  });

  test("use the filing time only when it falls on the report date in New York and UTC", () => {
    const period = row("2026-03-28");
    expect(knownBy(period, [report("2026-04-30", "2026-03", "2026-04-30T20:30:41.000Z")])).toBe("2026-04-30T20:30:41.000Z");
    // A filing days after the report is the quarterly report's, and 02:00 UTC is the evening before in New York.
    expect(knownBy(period, [report("2026-04-30", "2026-03", "2026-05-01T20:30:41.000Z")])).toBe("2026-04-30");
    expect(knownBy(period, [report("2026-04-30", "2026-03", "2026-04-30T02:00:00.000Z")])).toBe("2026-04-30");
    expect(knownBy(period, [report("2026-04-30", "2026-03", "2026-05-01T00:45:00.000Z")])).toBe("2026-04-30");
  });

  test("keep only reports that happened and name their quarter", () => {
    const entry = (date: string, fiscalPeriod: string | null, epsActual: number | null, reportedAt: string | null) =>
      ({ symbol: "X", date, fiscalPeriod, epsActual, reportedAt } as EarningsHistoryPayload["reports"][number]);
    const payload: EarningsHistoryPayload = { asOf: "2026-10-08T18:00:00.000Z", symbol: "X", name: null, reports: [
      entry("2026-10-29", "2026-09", null, null),
      entry("2026-07-30", "2026-06", 1.91, "2026-07-30T20:30:28.000Z"),
      entry("2026-04-30", "2026-03", 2.01, null),
      entry("2026-01-29", "2025-12", null, "2026-01-29T21:30:33.000Z"),
      entry("2025-10-30", "2025-09", null, null),
      entry("2023-11-02", null, null, "2023-11-02T20:30:32.000Z"),
    ] };
    expect(reportDatesFrom(payload)).toEqual([
      report("2026-07-30", "2026-06", "2026-07-30T20:30:28.000Z"), report("2026-04-30", "2026-03"),
      report("2026-01-29", "2025-12", "2026-01-29T21:30:33.000Z"),
    ]);
    expect(reportDatesFrom({ ...payload, asOf: "not a date" })).toEqual([]);
  });
});
