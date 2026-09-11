import { expect, test } from "bun:test";
import { parseCompanyFactsFinancialStatements } from "../sources/sec-edgar";
import { mergeFinancialStatementRows } from "../utils/financial-statements";
import { extractFundamentalSeries } from "./fundamentals";
import { graphRowsForFinancials } from "./reporting";

const old = { form: "10-K", accn: "0000320193-19-000119", filed: "2019-10-31" };
const next = { form: "10-K", accn: "0000320193-20-000096", filed: "2020-10-30" };
const oldPeriod = { start: "2016-09-25", end: "2017-09-30" };
const comparison = { start: "2017-10-01", end: "2018-09-29" };
const payload = { facts: { "us-gaap": {
  StockholdersEquityNoteStockSplitConversionRatio1: { units: { pure: [{ ...next, end: "2020-08-28", val: 4 }] } },
  EarningsPerShareDiluted: { units: { "USD/shares": [
    { ...old, ...oldPeriod, val: 9.21 }, { ...old, ...comparison, val: 11.91 }, { ...next, ...comparison, val: 2.98 },
  ] } },
  NetIncomeLoss: { units: { USD: [
    { ...old, ...oldPeriod, val: 48_351_000_000 },
    { ...old, ...comparison, val: 59_531_000_000 }, { ...next, ...comparison, val: 59_531_000_000 },
  ] } },
} } };

test("SEC split correction survives cached statement merging, graph growth and JSON export", () => {
  const projected = parseCompanyFactsFinancialStatements(payload);
  const annualStatements = mergeFinancialStatementRows(projected.annualStatements, [
    { date: "2017-09-30", currency: "USD", eps: 9.21, netIncome: 48_351_000_000 },
  ]);
  expect(annualStatements[0]).toMatchObject({ eps: 2.3025, netIncome: 48_351_000_000, fieldAvailability: { eps: "2020-10-30", netIncome: "2019-10-31" }, dateEvidence: { filed: "2019-10-31" } });
  const refreshed = mergeFinancialStatementRows([{ date: "2017-09-30", currency: "USD", eps: 9.21 }], projected.annualStatements);
  expect(refreshed[0]).toMatchObject({ eps: 2.3025, epsBasis: { factor: 4 }, fieldAvailability: { eps: "2020-10-30" } });
  const unrelated = mergeFinancialStatementRows([{ date: "2017-09-30", currency: "USD", eps: 10 }], projected.annualStatements)[0]!;
  expect(unrelated.eps).toBe(10);
  expect(unrelated.epsBasis).toBeUndefined();
  const financials = { annualStatements, quarterlyStatements: [], priceHistory: [] };
  const series = extractFundamentalSeries(financials, { kind: "security", instrument: { symbol: "AAPL" }, fieldId: "fundamental.eps", period: "annual", timestampMode: "period-end" });
  const exported = JSON.parse(JSON.stringify(series));
  expect(exported[0]).toMatchObject({ value: 2.3025, observedAt: "2017-09-30T00:00:00.000Z", availableAt: "2020-10-30T00:00:00.000Z", provenance: { quality: "derived", secEpsBasis: { originalValue: 9.21, factor: 4 } } });
  expect(graphRowsForFinancials(financials, "fundamental", "eps", "annual", "AAPL")[1]!.growth).toBeCloseTo(2.98 / 2.3025 - 1, 10);
});

test("unresolved EPS cannot return through cached fallback, inferred P/E or a multi-year growth gap", () => {
  const row = { ...parseCompanyFactsFinancialStatements(payload).annualStatements[0]!, eps: undefined };
  row.epsBasis = { ...row.epsBasis!, status: "unresolved", factor: undefined };
  const merged = mergeFinancialStatementRows([row], [{ date: row.date, currency: "USD", eps: 9.21, dilutedShares: 5_251_692_000 }]);
  expect(merged[0]!.eps).toBeUndefined();
  const financials = { annualStatements: [
    { date: "2016-09-24", currency: "USD", eps: 2 }, ...merged,
    { date: "2018-09-29", currency: "USD", eps: 3 },
  ], quarterlyStatements: [], priceHistory: [{ date: new Date("2019-10-31"), close: 50 }],
  quote: { symbol: "AAPL", price: 50, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.parse("2019-10-31") } };
  const eps = graphRowsForFinancials(financials, "fundamental", "eps", "annual", "AAPL");
  expect(eps.map((point) => point.date)).toEqual(["2016-09-24", "2018-09-29"]);
  expect(eps[1]!.growth).toBeNull();
  const pe = extractFundamentalSeries({ ...financials, annualStatements: merged }, { kind: "security", instrument: { symbol: "AAPL" }, fieldId: "valuation.trailingPE", period: "annual", timestampMode: "period-end" });
  expect(pe).toEqual([]);
});
