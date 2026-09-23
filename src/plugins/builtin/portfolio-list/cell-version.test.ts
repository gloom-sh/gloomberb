import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../../types/config";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { columnContextVersion } from "./cell-version";
import { getColumnValue, getSortValue, type ColumnContext } from "./metrics";
import { buildPortfolioPaneSettingsDef, getPortfolioPaneSettings, resolveVisibleColumns } from "./settings";

const NOW = Date.UTC(2026, 8, 23, 15);
const DAY_MS = 86_400_000;

const ticker: TickerRecord = {
  metadata: {
    ticker: "SAP", exchange: "XETRA", currency: "EUR", name: "SAP SE", assetCategory: "STK",
    portfolios: ["main"], watchlists: [], custom: {}, tags: [],
    positions: [{ portfolio: "main", shares: 10, avgCost: 100, currency: "EUR", broker: "manual", dateAcquired: "2026-09-01" }],
  },
};

const financials: TickerFinancials = {
  annualStatements: [], quarterlyStatements: [],
  priceHistory: [118, 121, 119, 120].map((close, index) => ({ date: new Date(NOW - (4 - index) * 7 * DAY_MS), close })),
  fundamentals: { marketCap: 1.2e11, marketCapCurrency: "EUR", sharesOutstanding: 1e9, trailingPE: 25, eps: 4.7, dividendYield: 0.02 },
  quote: {
    symbol: "SAP", price: 120, currency: "EUR", change: 2, changePercent: 1.7, previousClose: 118,
    bid: 119.9, ask: 120.1, volume: 1_000_000, high52w: 150, low52w: 90,
    lastUpdated: NOW - 5_000, receivedAt: NOW - 3_000,
  },
};

function research(average: number) {
  return new Map([["SAP", {
    symbol: "SAP", currency: "EUR", priceTarget: { average, current: 118 }, recommendationRating: average / 20,
    recommendations: [], ratings: [], earningsEstimates: [], revenueEstimates: [],
  }]]);
}

const base: ColumnContext = {
  activeTab: "main",
  baseCurrency: "USD",
  exchangeRates: new Map([["USD", 1], ["EUR", 1.1]]),
  now: NOW,
  portfolioTotalMarketValue: 10_000,
  supplementalVersion: 1,
  analystResearch: research(150),
  corporateActions: new Map([["SAP", {
    symbol: "SAP", splits: [],
    dividends: [{ exDate: "2026-09-24", amount: 2 }, { exDate: "2026-12-24", amount: 2 }],
    earnings: [{ date: "2026-09-24" }, { date: "2026-10-24" }],
  }]]),
  earningsEvents: new Map([["SAP", null]]),
};

const variants: Array<[string, ColumnContext]> = [
  ["fx", { ...base, exchangeRates: new Map([["USD", 1], ["EUR", 1.2]]) }],
  ["total", { ...base, portfolioTotalMarketValue: 20_000 }],
  ["supplemental", { ...base, supplementalVersion: 2, analystResearch: research(180) }],
  ["second", { ...base, now: NOW + 7_000 }],
  ["day", { ...base, now: NOW + 2 * DAY_MS }],
];

test("a cell version follows every context input its column reads, and LAST follows none", () => {
  const options = buildPortfolioPaneSettingsDef(createDefaultConfig("/tmp/gloomberb-cell-version"), getPortfolioPaneSettings(undefined), "main")
    .fields.find((field) => field.key === "columnIds")!.options!;
  const columns = resolveVisibleColumns(options.map((option) => option.value), true);
  expect(columns.length).toBeGreaterThan(40);

  const read = (columnId: string, context: ColumnContext) => {
    const column = columns.find((entry) => entry.id === columnId)!;
    return JSON.stringify([getColumnValue(column, ticker, financials, context), getSortValue(column, ticker, financials, context)]);
  };
  const stale: string[] = [];
  for (const column of columns) {
    for (const [input, context] of variants) {
      if (read(column.id, context) !== read(column.id, base)
        && columnContextVersion(column.id, context) === columnContextVersion(column.id, base)) {
        stale.push(`${column.id} ignores ${input}`);
      }
    }
  }
  expect(stale).toEqual([]);

  // Each input does reach some column, so the check above is not vacuous.
  for (const [input, context] of variants) {
    expect(columns.some((column) => read(column.id, context) !== read(column.id, base))).toBe(true);
    // A quote tick elsewhere in the collection, an FX refresh or a clock tick never recomputes LAST.
    expect(columnContextVersion("price", context), input).toBe(columnContextVersion("price", base));
  }
});
