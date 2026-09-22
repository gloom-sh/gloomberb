import { expect, test } from "bun:test";
import { buildFundOverlap } from "./overlap";
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
