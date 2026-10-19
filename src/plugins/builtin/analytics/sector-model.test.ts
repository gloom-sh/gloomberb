import { expect, test } from "bun:test";
import type { TickerRecord } from "../../../types/ticker";
import { buildSectorRowsFromPortfolioColumns, sortSectorRows } from "./sector-model";
import { createTestTicker } from "../../../test-support/ticker";

const holding = (symbol: string, currency = "USD", assetCategory = "STK"): TickerRecord => (createTestTicker(symbol, symbol, {
  currency,
  assetCategory,
  sector: "Technology",
  portfolios: ["main"],
  positions: [{ portfolio: "main", shares: 10, avgCost: 100, markPrice: 120, currency, broker: "manual" }],
}));
const context = () => ({ activeTab: "main", baseCurrency: "USD", exchangeRates: new Map<string, number>(), now: 0 });

test("missing FX does not disappear from concentration or renormalize the remaining portfolio", () => {
  const tickers = [holding("AAPL"), holding("SAP", "EUR"), holding("QQQ", "USD", "ETF")];
  const ctx = context();
  const missing = buildSectorRowsFromPortfolioColumns(tickers, new Map(), ctx);
  expect(missing.unvaluedSymbols).toEqual(["SAP"]);
  expect(missing.fundSymbols).toEqual(["QQQ"]);
  expect(missing.rows.find((row) => row.sector === "Technology")).toMatchObject({ value: null, pnl: null, costBasis: null, weight: null, returnPct: null });
  expect(missing.rows.find((row) => row.sector === "Funds")).toMatchObject({ value: 1200, pnl: 200, weight: null });
  ctx.exchangeRates.set("EUR", 1.2);
  const restored = buildSectorRowsFromPortfolioColumns(tickers, new Map(), ctx);
  expect(restored.unvaluedSymbols).toEqual([]);
  expect(restored.rows.find((row) => row.sector === "Technology")?.weight).toBeCloseTo(2640 / 3840);
  expect(restored.rows.find((row) => row.sector === "Funds")?.weight).toBeCloseTo(1200 / 3840);
});

test("a short nets against its sector's value, returns are over the capital put in, and missing cost cannot become zero", () => {
  const long = holding("AAPL");
  const short = holding("MSFT");
  short.metadata.positions[0]!.shares = -10;
  short.metadata.positions[0]!.avgCost = 130;
  const aggregate = () => buildSectorRowsFromPortfolioColumns([long, short], new Map(), context()).rows[0]!;
  // Long 1,200 and short -1,200: a flat book has no positive total to weigh by.
  expect(aggregate()).toMatchObject({ value: 0, costBasis: 2300, pnl: 300, weight: null });
  expect(aggregate().returnPct).toBeCloseTo(300 / 2300 * 100);
  short.metadata.positions[0]!.avgCost = Number.NaN;
  expect(aggregate()).toMatchObject({ value: 0, costBasis: null, pnl: null, returnPct: null });
  const rows = [aggregate(), { ...aggregate(), id: "known", returnPct: -5 }];
  for (const direction of ["asc", "desc"] as const) {
    expect(sortSectorRows(rows, { columnId: "return", direction }).at(-1)?.returnPct).toBeNull();
  }
});

test("known zero broker values and marks retain zero weight and losses without becoming missing data", () => {
  for (const zeroValue of [{ marketValue: 0 }, { markPrice: 0 }]) {
    const worthless = holding("ZERO");
    worthless.metadata.sector = "Energy";
    worthless.metadata.positions = [{ portfolio: "main", shares: 10, avgCost: 100, currency: "USD", broker: "manual", ...zeroValue }];
    const calculate = () => buildSectorRowsFromPortfolioColumns([holding("AAPL"), worthless], new Map(), context());
    expect(calculate().unvaluedSymbols).toEqual([]);
    expect(calculate().rows.find((row) => row.sector === "Energy")).toMatchObject({ value: 0, weight: 0, pnl: -1000, returnPct: -100 });
    expect(calculate().rows.find((row) => row.sector === "Technology")?.weight).toBe(1);
    worthless.metadata.positions = [{ portfolio: "main", shares: 10, avgCost: 100, currency: "USD", broker: "manual" }];
    expect(calculate().unvaluedSymbols).toEqual(["ZERO"]);
    expect(calculate().rows.every((row) => row.weight === null)).toBe(true);
  }
});

test("a future without a contract size is left out of every sector by name, and the others keep their weights", () => {
  const gold = createTestTicker("GC=F", "Gold", { assetCategory: "FUTURE", sector: "Commodities", portfolios: ["main"],
    positions: [{ portfolio: "main", shares: -2, avgCost: 4200, markPrice: 4198, currency: "USD", broker: "manual" }] });
  const allocation = buildSectorRowsFromPortfolioColumns([holding("AAPL"), holding("QQQ", "USD", "ETF"), gold], new Map(), context());
  expect(allocation).toMatchObject({ unsizedSymbols: ["GC=F"], unvaluedSymbols: [] });
  expect(allocation.rows.map((row) => row.sector)).toEqual(["Funds", "Technology"]);
  expect(allocation.rows.map((row) => row.weight)).toEqual([0.5, 0.5]);
});
