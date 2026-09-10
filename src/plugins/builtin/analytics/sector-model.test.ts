import { expect, test } from "bun:test";
import type { TickerRecord } from "../../../types/ticker";
import { buildSectorRowsFromPortfolioColumns, sortSectorRows } from "./sector-model";

const holding = (symbol: string, currency = "USD", assetCategory = "STK"): TickerRecord => ({ metadata: {
  ticker: symbol, name: symbol, currency, assetCategory, exchange: "NASDAQ", sector: "Technology",
  portfolios: ["main"], watchlists: [], custom: {}, tags: [],
  positions: [{ portfolio: "main", shares: 10, avgCost: 100, markPrice: 120, currency, broker: "manual" }],
} });
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

test("gross long/short concentration keeps signed P&L and missing cost cannot become zero", () => {
  const long = holding("AAPL");
  const short = holding("MSFT");
  short.metadata.positions[0]!.shares = -10;
  short.metadata.positions[0]!.avgCost = 130;
  const aggregate = () => buildSectorRowsFromPortfolioColumns([long, short], new Map(), context()).rows[0]!;
  expect(aggregate()).toMatchObject({ value: 2400, costBasis: 2300, pnl: 300, weight: 1 });
  expect(aggregate().returnPct).toBeCloseTo(300 / 2300 * 100);
  short.metadata.positions[0]!.avgCost = Number.NaN;
  expect(aggregate()).toMatchObject({ value: 2400, costBasis: null, pnl: null, weight: 1, returnPct: null });
  const rows = [aggregate(), { ...aggregate(), id: "known", returnPct: -5 }];
  for (const direction of ["asc", "desc"] as const) {
    expect(sortSectorRows(rows, { columnId: "return", direction }).at(-1)?.returnPct).toBeNull();
  }
});
