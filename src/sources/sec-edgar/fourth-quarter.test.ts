import { expect, test } from "bun:test";
import type { FinancialStatement } from "../../types/financials";
import { deriveQuarterlyStatements } from "../../time-series/fundamentals";
import { mergeFinancialStatementRows } from "../../utils/financial-statements";
import { parseCompanyFactsFinancialStatements } from "../sec-edgar";
import { withCheckedFourthQuarters } from "./fourth-quarter";

type Fact = [start: string, end: string, millions: number, form: string, fp: string, filed: string];

/** Company facts subsets as filed, amounts in millions. */
function companyFacts(concepts: Record<string, Fact[]>) {
  return { cik: 1, facts: { "us-gaap": Object.fromEntries(Object.entries(concepts).map(([concept, facts]) => [concept, {
    units: { USD: facts.map(([start, end, millions, form, fp, filed], index) => ({
      start, end, val: Math.round(millions * 1_000_000), form, fp, filed, accn: `0000000001-${filed.slice(2, 4)}-${String(index).padStart(6, "0")}`,
    })) },
  }])) } };
}

const M = 1_000_000;
const usd = (row: Partial<FinancialStatement> & { date: string }): FinancialStatement => ({ currency: "USD", ...row });

// BAC re-reported Q1 and Q2 2025 on a new tax-equity basis after its Q3
// 10-Q, while the 10-K full year already used it. Full year minus the old
// nine months (the vendor's Q4) mixes the two bases.
const bac = (line: [q1: number, q1New: number, h1: number, h1New: number, q2: number, q2New: number, nine: number, q3: number, year: number]): Fact[] => {
  const [q1, q1New, h1, h1New, q2, q2New, nine, q3, year] = line;
  return [
    ["2025-01-01", "2025-03-31", q1, "10-Q", "Q1", "2025-04-30"], ["2025-01-01", "2025-03-31", q1New, "10-Q", "Q1", "2026-05-01"],
    ["2025-01-01", "2025-06-30", h1, "10-Q", "Q2", "2025-07-31"], ["2025-01-01", "2025-06-30", h1New, "10-Q", "Q2", "2026-07-31"],
    ["2025-04-01", "2025-06-30", q2, "10-Q", "Q2", "2025-07-31"], ["2025-04-01", "2025-06-30", q2New, "10-Q", "Q2", "2026-07-31"],
    ["2025-01-01", "2025-09-30", nine, "10-Q", "Q3", "2025-10-31"], ["2025-07-01", "2025-09-30", q3, "10-Q", "Q3", "2025-10-31"],
    ["2025-01-01", "2025-12-31", year, "10-K", "FY", "2026-02-25"],
  ];
};

test("BAC: quarters restated after the nine-month figure keep the fourth quarter a gap everywhere", () => {
  const sec = parseCompanyFactsFinancialStatements(companyFacts({
    Revenues: bac([27_366, 28_247, 53_829, 55_690, 26_463, 27_443, 81_917, 28_088, 113_097]),
    NetIncomeLoss: bac([7_396, 7_360, 14_512, 14_530, 7_116, 7_170, 22_981, 8_469, 30_509]),
    IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: bac([8_116, 8_997, 15_804, 17_665, 7_688, 8_668, 25_260, 9_456, 37_695]),
    IncomeTaxExpenseBenefit: bac([720, 1_637, 1_292, 3_135, 572, 1_498, 2_279, 987, 7_186]),
  }));
  const blocked = ["totalRevenue", "operatingRevenue", "netIncome", "pretaxIncome", "taxProvision"] as const;
  expect(sec.quarterlyStatements.find((row) => row.date === "2025-12-31")?.unavailableFields).toEqual(expect.arrayContaining([...blocked]));

  // Yahoo's rows: its Q4 is the new-basis year minus the old nine months.
  const vendor = {
    annualStatements: [usd({ date: "2025-12-31", totalRevenue: 113_097 * M, operatingRevenue: 113_097 * M, netIncome: 30_509 * M, pretaxIncome: 37_695 * M, taxProvision: 7_186 * M })],
    quarterlyStatements: [
      usd({ date: "2025-03-31", totalRevenue: 28_247 * M, netIncome: 7_360 * M }),
      usd({ date: "2025-06-30", totalRevenue: 27_443 * M, netIncome: 7_170 * M }),
      usd({ date: "2025-09-30", totalRevenue: 28_088 * M, netIncome: 8_469 * M }),
      usd({ date: "2025-12-31", totalRevenue: 31_180 * M, operatingRevenue: 31_180 * M, netIncome: 7_528 * M, pretaxIncome: 12_435 * M, taxProvision: 4_907 * M, totalAssets: 3_411_738 * M }),
    ],
  };
  const checked = withCheckedFourthQuarters(vendor, sec.fourthQuarters ?? []);
  for (const quarterly of [mergeFinancialStatementRows(checked, sec.quarterlyStatements), mergeFinancialStatementRows(sec.quarterlyStatements, vendor.quarterlyStatements)]) {
    const annual = mergeFinancialStatementRows(vendor.annualStatements, sec.annualStatements);
    for (const rows of [quarterly, deriveQuarterlyStatements(quarterly, annual)]) {
      const q4 = rows.find((row) => row.date === "2025-12-31")!;
      for (const field of blocked) expect(q4[field]).toBeUndefined();
      expect(q4.totalAssets).toBe(3_411_738 * M);
    }
  }
});

test("TSLA 2024: the guard holds until the restated nine months are filed, and ignores re-rounding", () => {
  const facts: Fact[] = [
    ["2024-01-01", "2024-03-31", 1_129, "10-Q", "Q1", "2024-04-24"], ["2024-01-01", "2024-03-31", 1_390, "10-Q", "Q1", "2025-04-23"],
    ["2024-04-01", "2024-06-30", 1_478, "10-Q", "Q2", "2024-07-24"], ["2024-04-01", "2024-06-30", 1_400, "10-Q", "Q2", "2025-07-24"],
    ["2024-07-01", "2024-09-30", 2_167, "10-Q", "Q3", "2024-10-24"],
    ["2024-01-01", "2024-09-30", 4_774, "10-Q", "Q3", "2024-10-24"],
    ["2024-01-01", "2024-12-31", 7_091, "10-K", "FY", "2025-01-30"],
  ];
  const fourthQuarter = (extra: Fact[]) => parseCompanyFactsFinancialStatements(companyFacts({ NetIncomeLoss: [...facts, ...extra] }))
    .fourthQuarters?.find((check) => check.date === "2024-12-31" && check.fields.includes("netIncome"));
  expect(fourthQuarter([])?.fourthQuarter).toBeUndefined();
  expect(fourthQuarter([["2024-01-01", "2024-09-30", 4_963, "10-Q", "Q3", "2025-10-23"]])?.fourthQuarter).toBe(2_128 * M);

  // A filer moving from thousands to millions re-rounds its comparatives.
  const rounded = parseCompanyFactsFinancialStatements(companyFacts({ NetIncomeLoss: [
    ["2025-01-01", "2025-03-31", 2_759.3, "10-Q", "Q1", "2025-05-01"], ["2025-01-01", "2025-03-31", 2_759, "10-Q", "Q1", "2026-04-30"],
    ["2025-01-01", "2025-09-30", 14_002.3, "10-Q", "Q3", "2025-10-30"], ["2025-01-01", "2025-12-31", 20_640, "10-K", "FY", "2026-02-12"],
  ] }));
  expect(rounded.fourthQuarters?.[0]?.fourthQuarter).toBe(6_637_700_000);
});

test("O: a vendor fourth quarter that absorbed a narrower quarterly measure is a gap, never recomputed", () => {
  const sec = parseCompanyFactsFinancialStatements(companyFacts({ Revenues: [
    ["2025-01-01", "2025-03-31", 1_380.505, "10-Q", "Q1", "2025-05-06"], ["2025-04-01", "2025-06-30", 1_410.378, "10-Q", "Q2", "2025-08-07"],
    ["2025-07-01", "2025-09-30", 1_470.552, "10-Q", "Q3", "2025-11-04"], ["2025-01-01", "2025-09-30", 4_261.435, "10-Q", "Q3", "2025-11-04"],
    ["2025-01-01", "2025-12-31", 5_749.377, "10-K", "FY", "2026-02-25"],
  ] }));
  expect(sec.fourthQuarters).toEqual([{ date: "2025-12-31", fields: ["totalRevenue", "operatingRevenue"], annual: 5_749_377_000, fourthQuarter: 1_487_942_000 }]);
  const vendor = {
    annualStatements: [usd({ date: "2025-12-31", totalRevenue: 5_749_377_000 })],
    quarterlyStatements: [
      usd({ date: "2025-06-30", totalRevenue: 1_338_516_000 }), usd({ date: "2025-09-30", totalRevenue: 1_387_631_000 }),
      usd({ date: "2025-12-31", totalRevenue: 1_708_836_000, netIncome: 296_085_000 }),
    ],
  };
  const quarterly = mergeFinancialStatementRows(withCheckedFourthQuarters(vendor, sec.fourthQuarters!), sec.quarterlyStatements);
  const annual = mergeFinancialStatementRows(vendor.annualStatements, sec.annualStatements);
  // Without the gap the chart computed 5,749,377 less SEC's Q1 and Yahoo's
  // Q2 and Q3: 1,642,725,000, matching neither source.
  const q4 = deriveQuarterlyStatements(quarterly, annual).find((row) => row.date === "2025-12-31")!;
  expect(q4.totalRevenue).toBeUndefined();
  expect(q4.unavailableFields).toContain("totalRevenue");
  expect(q4.netIncome).toBe(296_085_000);
});

test("AAPL control: consistent filings and vendor quarters are unchanged", () => {
  const sec = parseCompanyFactsFinancialStatements(companyFacts({ RevenueFromContractWithCustomerExcludingAssessedTax: [
    ["2024-09-29", "2024-12-28", 124_300, "10-Q", "Q1", "2025-01-31"], ["2024-09-29", "2024-12-28", 124_300, "10-Q", "Q1", "2026-01-30"],
    ["2024-12-29", "2025-03-29", 95_359, "10-Q", "Q2", "2025-05-02"], ["2025-03-30", "2025-06-28", 94_036, "10-Q", "Q3", "2025-08-01"],
    ["2024-09-29", "2025-06-28", 313_695, "10-Q", "Q3", "2025-08-01"], ["2024-09-29", "2025-06-28", 313_695, "10-Q", "Q3", "2026-07-31"],
    ["2024-09-29", "2025-09-27", 416_161, "10-K", "FY", "2025-10-31"],
  ] }));
  expect(sec.fourthQuarters?.[0]?.fourthQuarter).toBe(102_466 * M);
  expect(sec.quarterlyStatements.some((row) => row.unavailableFields?.includes("totalRevenue"))).toBe(false);
  const vendor = {
    annualStatements: [usd({ date: "2025-09-30", totalRevenue: 416_161 * M })],
    quarterlyStatements: [usd({ date: "2025-09-30", totalRevenue: 102_466 * M })],
  };
  expect(withCheckedFourthQuarters(vendor, sec.fourthQuarters!)).toEqual(vendor.quarterlyStatements);
});
