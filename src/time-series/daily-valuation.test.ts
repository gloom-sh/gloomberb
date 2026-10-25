import { expect, test } from "bun:test";
import type { FinancialStatement, TickerFinancials } from "../types/financials";
import { createTestDataProvider } from "../test-support/data-provider";
import { extractFundamentalSeries } from "./fundamentals";
import { resolveChartSpecData } from "./resolve";
import { dailyValuationHistory } from "./daily-valuation";
import type { ChartSpec, SecuritySeriesSource } from "./types";

const source = (metric = "trailingPE"): SecuritySeriesSource => ({
  kind: "security", instrument: { symbol: "TEST", exchange: "NYSE" },
  fieldId: `valuation.${metric}`, period: "daily", timestampMode: "available-at",
});
const quarter = (date: string, availableAt: string, eps: number | undefined = 1): FinancialStatement => ({
  date, availableAt, currency: "USD", eps, totalRevenue: 100, ebitda: 20,
  freeCashFlow: 10, dilutedShares: 10, totalDebt: 30, cashAndCashEquivalents: 10,
});
const quarters = () => [
  quarter("2024-03-31", "2024-05-01"), quarter("2024-06-30", "2024-08-01"),
  quarter("2024-09-30", "2024-11-01"), quarter("2024-12-31", "2025-02-03"),
  quarter("2025-03-31", "2025-05-01", 2),
];
function financials(rows = quarters(), days = ["2025-01-31", "2025-02-03", "2025-04-30", "2025-05-01", "2025-05-02"]): TickerFinancials {
  return {
    financialCurrency: "USD", annualStatements: [], quarterlyStatements: rows,
    quote: { symbol: "TEST", currency: "USD", price: 100, change: 0, changePercent: 0, lastUpdated: Date.parse("2025-05-02T20:00:00Z") },
    priceHistory: days.map((date, index) => ({ date: new Date(date), close: 20 + index })),
  };
}
const values = (data: TickerFinancials, metric?: string) => extractFundamentalSeries(data, source(metric)).map(point => point.value);

test("timed reports step at the first close after publication, respecting an early-close session", () => {
  const history = ["2025-07-02", "2025-07-03", "2025-07-07"].map(day => ({ date: new Date(day), close: 40 }));
  const basis = (availableAt: string, eps: number) => ({ availableAt: new Date(availableAt),
    observedAt: new Date(availableAt), atPrice: (price: number) => price / eps });
  const bases = [basis("2025-07-01", 4), basis("2025-07-03T16:00:00Z", 5), basis("2025-07-03T18:00:00Z", 8)];
  expect(dailyValuationHistory(history, bases, "NYSE").map(point => point.value)).toEqual([10, 8, 5]);
});

test("daily TTM steps on public report dates and reprices every close, with no quarter-end lookahead or live overwrite", () => {
  const data = financials();
  expect(values(data)).toEqual([null, 21 / 4, 22 / 4, 23 / 5, 24 / 5]);
  const latest = extractFundamentalSeries(data, source()).at(-1)!;
  expect(latest.availableAt?.toISOString().slice(0, 10)).toBe("2025-05-01");
  expect(latest.observedAt.toISOString().slice(0, 10)).toBe("2025-05-02");
  expect(values(JSON.parse(JSON.stringify(data)))).toEqual(values(data));
});

test("losses, withheld EPS and missing quarterly inputs break the line instead of reviving an annual figure", () => {
  for (const missing of [-5, 0, undefined]) {
    const rows = quarters();
    rows[4] = { ...rows[4]!, eps: missing === 0 ? -3 : missing };
    const data = financials(rows);
    data.annualStatements = [{ date: "2024-12-31", availableAt: "2025-02-03", currency: "USD", eps: 100 }];
    expect(values(data)).toEqual([null, 21 / 4, 22 / 4, null, null]);
  }
  const gap = financials(quarters().filter((_, index) => index !== 1));
  gap.annualStatements = [{ date: "2024-12-31", availableAt: "2025-02-03", currency: "USD", eps: 100 }];
  expect(values(gap)).toEqual([]);
});

test("annual-only companies step on publication, while an undated figure cannot establish historical knowledge", () => {
  const data = financials([]);
  data.annualStatements = [
    { date: "2024-12-31", availableAt: "2025-02-03", currency: "USD", eps: 4 },
    { date: "2025-12-31", currency: "USD", eps: 100 },
  ];
  expect(values(data)).toEqual([null, 21 / 4, 22 / 4, 23 / 4, 24 / 4]);
  delete data.annualStatements[0]!.availableAt;
  expect(values(data)).toEqual([]);
});

test("a verified split-adjusted EPS keeps its original report boundary and matches split-adjusted closes", () => {
  const data = financials(quarters().slice(0, 4), ["2025-02-03", "2025-03-03"]);
  data.priceHistory.forEach(bar => { bar.close = 25; });
  for (const row of data.quarterlyStatements) {
    row.epsBasis = { status: "split-adjusted", source: "sec", originalValue: 4,
      originalFiled: row.availableAt, basisDate: "2025-03-01", factor: 4, evidence: [] };
    row.fieldAvailability = { eps: "2025-03-03" };
  }
  expect(values(data)).toEqual([6.25, 6.25]);
  data.quarterlyStatements[0]!.epsBasis!.status = "unresolved";
  expect(values(data)).toEqual([]);
});

test("daily sales, enterprise and cash flow multiples share the trailing denominator and retain invalid-price gaps", () => {
  const data = financials();
  expect(values(data, "priceSales")).toEqual([null, .525, .55, .575, .6]);
  expect(values(data, "evSales")).toEqual([null, .575, .6, .625, .65]);
  expect(values(data, "evEbitda")).toEqual([null, 230 / 80, 240 / 80, 250 / 80, 260 / 80]);
  expect(values(data, "priceFcf")).toEqual([null, 210 / 40, 220 / 40, 230 / 40, 240 / 40]);
  data.priceHistory[3]!.close = 0;
  expect(values(data)).toEqual([null, 21 / 4, 22 / 4, null, 24 / 5]);
  expect(extractFundamentalSeries(data, source())[3]!.provenance?.valuationPriceIssues?.[0]?.kind).toBe("history");
  data.quarterlyStatements[4]!.freeCashFlow = -100;
  expect(values(data, "priceFcf").slice(-2)).toEqual([null, null]);
});

test("PEG uses only known positive year-over-year trailing EPS growth and reprices between reports", () => {
  const rows = quarters().slice(0, 4);
  rows.push(quarter("2025-03-31", "2025-05-01", 2), quarter("2025-06-30", "2025-08-01", 2),
    quarter("2025-09-30", "2025-11-01", 2), quarter("2025-12-31", "2026-02-02", 2));
  const data = financials(rows, ["2026-01-30", "2026-02-02", "2026-02-03"]);
  expect(values(data, "pegRatio")).toEqual([null, (21 / 8) / 100, (22 / 8) / 100]);
});

test("undated vendor Q4 fields cannot freeze daily TTM on the prior year or block dated annual derivations", () => {
  const data = financials();
  // The fourth-quarter snapshot has values, but its field map dates only
  // cash flow. The annual filing establishes the trailing year instead.
  const fourth = data.quarterlyStatements[3]!;
  fourth.fieldAvailability = { freeCashFlow: "2025-02-03" };
  data.annualStatements = [{ ...quarter("2024-12-31", "2025-02-03", 4), totalRevenue: 400, ebitda: 80, freeCashFlow: 40 }];
  expect(values(data)).toEqual([null, 21 / 4, 22 / 4, 23 / 5, 24 / 5]);
  expect(values(data, "priceSales")).toEqual([null, .525, .55, .575, .6]);
  // Capitalization uses the latest reported shares; TTM average shares
  // belong to an income/EPS fallback, not the market-cap numerator.
  data.quarterlyStatements[4]!.dilutedShares = 20;
  expect(values(data, "priceSales").slice(-2)).toEqual([1.15, 1.2]);
});

test("daily forward P/E uses recorded consensus, never future reports, and a later loss resets the denominator", () => {
  const data = financials([], ["2025-02-03", "2025-02-04", "2025-02-05", "2025-02-06"]);
  data.epsEstimates = { currency: "USD", consensus: [],
    reported: Array.from({ length: 6 }, (_, index) => ({ date: `${2025 + index}-01-01`, epsEstimate: 100 })),
    snapshots: [
      { observedOn: "2025-02-04", period: "next year", epsAverage: 5, source: "test" },
      { observedOn: "2025-02-06", period: "next year", epsAverage: -1, source: "test" },
    ] };
  expect(values(data, "forwardPE")).toEqual([null, 21 / 5, 22 / 5, null]);
});

test("resolver requests daily price history even at a coarser viewport and preserves source closes in the daily result", async () => {
  const data = financials();
  const requests: string[] = [];
  const provider = createTestDataProvider({
    getTickerFinancials: async () => data,
    getPriceHistoryForResolution: async (_ticker, _exchange, _range, resolution) => { requests.push(resolution); return data.priceHistory; },
    getDetailedPriceHistory: async (_ticker, _exchange, _start, _end, barSize) => { requests.push(barSize); return data.priceHistory; },
  });
  const spec: ChartSpec = { version: 2, viewport: { range: "1Y", resolution: "1mo", dateWindow: { start: "2025-01-01", end: "2025-05-02" } },
    panels: [{ id: "main" }], studies: [], series: [{ id: "pe", source: source(), panelId: "main", style: "line", transform: "raw", axis: "left", interpolation: "none" }] };
  let captured: TickerFinancials | undefined;
  const model = await resolveChartSpecData(spec, { dataProvider: provider,
    onSecurityData: (_series, snapshot) => { captured = snapshot; },
    loadFredSeries: async () => { throw new Error("Unexpected economic series"); } });
  expect(requests).toEqual(["1d"]);
  expect(model.series[0]?.nativeFrequency).toBe("daily");
  expect(model.series[0]?.points.at(-1)?.value).toBe(24 / 5);
  expect(captured?.priceHistory.at(-1)?.close).toBe(24);
  const short = await resolveChartSpecData({ ...spec, viewport: { range: "1D", resolution: "auto" } }, { dataProvider: provider,
    now: new Date("2025-05-04"), loadFredSeries: async () => { throw new Error("Unexpected economic series"); } });
  expect(short.series[0]?.points.map(point => point.value)).toEqual([23 / 5, 24 / 5]);
});
