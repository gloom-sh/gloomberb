import { expect, test } from "bun:test";
import { parseCompanyFactsFinancialStatements } from "./sec-edgar";

const bankConcept = "RevenuesNetOfInterestExpense";
const fact = (rows: object[], unit = "USD") => ({ units: { [unit]: rows } });
const quarter = { start: "2025-04-01", end: "2025-06-30", form: "10-Q", fp: "Q2", filed: "2025-08-05", accn: "0000019617-25-000615", val: 44_912_000_000 };
const parseBank = (rows: object[], unit = "USD") => parseCompanyFactsFinancialStatements({ facts: { "us-gaap": { [bankConcept]: fact(rows, unit) } } });
const revenueBy = (payload: object) => Object.fromEntries(parseCompanyFactsFinancialStatements(payload).quarterlyStatements
  .map(row => [row.date, row.totalRevenue]));

test("bank revenue fills quarters another tag leaves empty when both tags report the same amounts", () => {
  // JPM tags total net revenue under both concepts; filings that carry both agree.
  const q1 = { ...quarter, start: "2025-01-01", end: "2025-03-31", fp: "Q1", filed: "2025-05-01", accn: "0000019617-25-000400", val: 45_310_000_000 };
  expect(revenueBy({ facts: { "us-gaap": {
    Revenues: fact([q1]),
    [bankConcept]: fact([q1, quarter]),
  } } })).toEqual({ "2025-03-31": q1.val, "2025-06-30": quarter.val });
});

test("bank revenue stays out when a filing shows it measures something else than the filer's revenue tag", () => {
  // AXP tags fee revenue alone under the contract-revenue concept. Mixing its
  // total net revenue into empty periods would create false jumps.
  const fee = { ...quarter, val: 6_047_000_000 };
  const q3 = { ...quarter, start: "2025-07-01", end: "2025-09-30", fp: "Q3", accn: "0000004962-25-000900", val: 9_710_000_000 };
  expect(revenueBy({ facts: { "us-gaap": {
    RevenueFromContractWithCustomerExcludingAssessedTax: fact([fee]),
    [bankConcept]: fact([{ ...quarter, val: 7_889_000_000 }, q3]),
  } } })).toEqual({ "2025-06-30": fee.val });
});

test("a bank-revenue quarterly frame cannot admit YTD, missing, invalid or reversed duration", () => {
  for (const duration of [
    { start: "2025-01-01", end: "2025-06-30" },
    { start: "2025-01-01", end: "2025-09-30" },
    { start: undefined }, { start: "invalid" }, { start: "2025-02-30" },
    { start: "2025-06-31", end: "2025-09-30" },
    { start: "2025-07-01" }, { start: "2025-06-01" },
  ]) {
    const parsed = parseBank([{ ...quarter, ...duration, frame: "CY2025Q2" }]);
    expect(parsed.quarterlyStatements).toEqual([]);
  }
  expect(parseBank([{ ...quarter, frame: "CY2025Q2", form: "8-K" }]).quarterlyStatements).toEqual([]);
  expect(parseBank([quarter], "EUR").quarterlyStatements).toEqual([]);
  // The new concept does not change the established frame policy for other tags.
  const legacy = parseCompanyFactsFinancialStatements({ facts: { "us-gaap": {
    Revenues: fact([{ ...quarter, start: "2025-01-01", frame: "CY2025Q2" }]),
  } } });
  expect(legacy.quarterlyStatements[0]?.totalRevenue).toBe(quarter.val);
});

test("direct bank revenue keeps zero and negative values, duration limits and existing annual rules", () => {
  for (const [start, end, val] of [["2025-04-01", "2025-05-31", 0], ["2025-04-01", "2025-07-30", -2]] as const) {
    const rows = parseBank([{ ...quarter, start, end, val, frame: "CY2025Q2" }]).quarterlyStatements;
    expect(rows[0]?.totalRevenue).toBe(val);
  }
  for (const [start, end] of [["2025-04-01", "2025-05-30"], ["2025-04-01", "2025-07-31"]]) {
    expect(parseBank([{ ...quarter, start, end, frame: "CY2025Q2" }]).quarterlyStatements).toEqual([]);
  }
  const annual = { ...quarter, start: "2025-01-01", end: "2025-12-31", form: "10-K", fp: "FY", filed: "2026-02-13" };
  expect(parseBank([annual]).annualStatements[0]?.totalRevenue).toBe(annual.val);
  expect(parseBank([{ ...annual, form: "10-Q" }]).annualStatements).toEqual([]);
  expect(parseBank([{ ...annual, start: "2025-03-01" }]).annualStatements).toEqual([]);
});

test("bank revenue is a fallback; same-concept restatements retain their own disclosure dates", () => {
  for (const tag of ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"]) {
    const result = parseCompanyFactsFinancialStatements({ facts: { "us-gaap": {
      [tag]: fact([{ ...quarter, val: 100 }]),
      [bankConcept]: fact([{ ...quarter, val: 200, filed: "2026-08-06" }]),
    } } });
    expect(result.quarterlyStatements[0]).toMatchObject({ totalRevenue: 100, fieldAvailability: { totalRevenue: "2025-08-05" } });
  }
  const repeat = { ...quarter, filed: "2026-08-06", frame: "CY2025Q2" };
  expect(parseBank([quarter, repeat]).quarterlyStatements[0]?.fieldAvailability?.totalRevenue).toBe("2025-08-05");
  const amended = { ...quarter, val: quarter.val + 1, filed: "2026-05-01", form: "10-Q/A" };
  expect(parseBank([quarter, amended, { ...repeat, val: amended.val }]).quarterlyStatements[0]).toMatchObject({
    totalRevenue: amended.val, fieldAvailability: { totalRevenue: "2026-05-01" },
  });
});
