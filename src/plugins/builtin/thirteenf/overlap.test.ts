import { expect, test } from "bun:test";
import { buildFundOverlap, buildManagerEtfOverlap, overlapPeriod } from "./overlap";
import type { FundDetailData, ThirteenFFormSummary, ThirteenFHoldingRecord } from "./types";
const form: ThirteenFFormSummary = { url: "", accessionNumber: "current", submissionType: "13F-HR", periodOfReport: "2026-06-30", filedAsOfDate: "2026-08-14", cik: "1", companyName: "Fund", tableValueTotal: 100, tableEntryTotal: 1, isAmendment: false };
const holding = (overrides: Partial<ThirteenFHoldingRecord> = {}): ThirteenFHoldingRecord => ({ accessionNumber: "current", cik: "1", cusip: "one", ticker: "AAA", issuer: "A", titleOfClass: "COM", putCall: "", shareType: "SH", value: 20, shares: 2, investmentDiscretion: "SOLE", votingAuthoritySole: 2, votingAuthorityShared: 0, votingAuthorityNone: 0, ...overrides });
const detail = (rows: ThirteenFHoldingRecord[], overrides: Partial<FundDetailData> = {}): FundDetailData => ({ cik: "1", name: "Fund", forms: [form], latestForm: form, previousForm: null, latestHoldings: rows, previousHoldings: [], ...overrides });
test("overlap matches security identity despite aliases and excludes options and exits from the shared equity", () => {
  const first = detail([holding(), holding({ putCall: "CALL", value: 30 })], { previousForm: { ...form, periodOfReport: "2026-03-31" }, previousHoldings: [holding({ cusip: "exit", ticker: "BBB" })] });
  const second = detail([holding({ ticker: "RENAMED", value: 40 }), holding({ cusip: "exit", ticker: "BBB" })], { latestForm: { ...form, tableValueTotal: 200 } });
  expect(buildFundOverlap(first, second)).toEqual([{ id: "ONE||SH", ticker: "AAA", issuer: "A", type: "SH", weight: 0.2, comparedWeight: 0.2 }]);
});
test("overlap cannot mix quarter ends and incomplete reports do not acquire weights", () => {
  const first = detail([holding()]);
  expect(buildFundOverlap(first, detail([holding()], { latestForm: { ...form, periodOfReport: "2026-03-31" } }))).toEqual([]);
  const partial = detail([holding()], { latestReport: { periodOfReport: form.periodOfReport, filings: [form], complete: false, tableValueTotal: null, tableEntryTotal: null } });
  expect(buildFundOverlap(first, partial)[0]?.comparedWeight).toBeNull();
});
test("a fund one quarter ahead compares at the other fund's latest quarter, weighted against that report", () => {
  const previousForm = { ...form, accessionNumber: "prior", periodOfReport: "2026-03-31", tableValueTotal: 50 };
  const report = (source: ThirteenFFormSummary, complete = true) => ({ periodOfReport: source.periodOfReport, filings: [source], complete, tableValueTotal: source.tableValueTotal, tableEntryTotal: 1 });
  const ahead = detail([holding({ cusip: "new" })], { previousForm, previousHoldings: [holding({ value: 10 })], latestReport: report(form), previousReport: report(previousForm) });
  const behind = detail([holding()], { latestForm: previousForm, latestReport: report(previousForm) });
  expect(overlapPeriod(ahead, behind)).toBe("2026-03-31");
  expect(buildFundOverlap(ahead, behind)).toEqual([{ id: "ONE||SH", ticker: "AAA", issuer: "A", type: "SH", weight: 0.2, comparedWeight: 0.4 }]);
  const failed = { ...ahead, previousReport: report(previousForm, false), previousHoldings: [] };
  expect(overlapPeriod(failed, behind)).toBeNull();
  expect(buildFundOverlap(failed, behind)).toEqual([]);
  expect(overlapPeriod(ahead, { ...ahead, cik: "2" })).toBe("2026-06-30");
});
test("manager against an ETF: overlap sums the smaller weights, active share covers both books, untickered and unheld names are missing", () => {
  const manager = detail([
    holding({ cusip: "a", ticker: "AAA", value: 40 }),
    holding({ cusip: "b", ticker: "BRK.B", value: 30 }),
    holding({ cusip: "c", ticker: "", issuer: "Unmapped", value: 20 }),
    holding({ cusip: "d", ticker: "DDD", value: 10 }),
    holding({ cusip: "a", ticker: "AAA", putCall: "CALL", value: 500 }),
    holding({ cusip: "n", ticker: "NOTE", shareType: "PRN", value: 50 }),
  ]);
  // A file whose weights sum to a half reads as a whole: AAA 25%, BRK-B 50%, the rest elsewhere or cash.
  const etf = [{ symbol: "AAA", weight: 0.125 }, { symbol: "BRK-B", weight: 0.25 }, { symbol: "EEE", weight: 0.0625 }, { symbol: null, weight: 0.0625 }];
  const result = buildManagerEtfOverlap(manager, etf)!;
  expect(result.rows.map((row) => [row.ticker, row.weight, row.etfWeight])).toEqual([
    ["AAA", 0.4, 0.25], ["BRK.B", 0.3, 0.5], ["", 0.2, null], ["DDD", 0.1, 0],
  ]);
  expect(result.overlap).toBeCloseTo(0.25 + 0.3);
  // |0.4-0.25| + |0.3-0.5| + 0.2 + 0.1 + the ETF's 0.25 elsewhere, halved.
  expect(result.activeShare).toBeCloseTo(0.45);
  expect(result.missing.map((row) => row.issuer)).toEqual(["Unmapped", "A"]);
  expect(result.missingWeight).toBeCloseTo(0.3);
  expect(result.leftOut).toEqual({ options: 1, principal: 1 });
  expect(buildManagerEtfOverlap(manager, [{ symbol: null, weight: null }])).toBeNull();
});
