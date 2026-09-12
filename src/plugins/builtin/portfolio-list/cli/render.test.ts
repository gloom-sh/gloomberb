import { expect, spyOn, test } from "bun:test";
import { serializeCliResult, type CliResult } from "../../../../cli/result";
import { DEFAULT_CLI_OPTIONS } from "../../../../cli/options";
import { createDefaultConfig } from "../../../../types/config";
import type { CliCommandContext } from "../../../../types/plugin";
import type { TickerRecord } from "../../../../types/ticker";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { buildTickerReport } from "../../../../cli/commands/ticker";
import { showCollection } from "./render";

const ticker: TickerRecord = { metadata: {
  ticker: "AAPL", name: "Apple", exchange: "NASDAQ", currency: "USD", portfolios: ["main"], watchlists: [], custom: {}, tags: [],
  positions: [{ portfolio: "main", shares: -10, avgCost: 100, currency: "USD", broker: "manual" }],
} };
const quote = { symbol: "AAPL", price: 90, currency: "USD", change: -5, changePercent: -5.26, previousClose: 95, lastUpdated: Date.now() };

test("ticker and collection CLI reconcile short P&L and withhold totals for a missing holding", async () => {
  const config = createDefaultConfig("/unused-test-data");
  const report = await buildTickerReport({ symbol: "AAPL", tickerFile: ticker, financials: { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] }, config, toBase: async value => value });
  expect(report).toMatch(/P&L[^\n]*\+\$100/);
  expect(report).toMatch(/Position[^\n]*-10 shares/);
  expect(report).toMatch(/Cost Basis[^\n]*-\$1,000/);
  expect(report).toMatch(/Market Value[^\n]*-\$900/);

  const missing: TickerRecord = { metadata: { ...ticker.metadata, ticker: "MISSING" } };
  const output: string[] = [];
  const logger = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  try {
    await showCollection("main", {
      initMarketData: async () => ({ config, persistence: { close() {} }, store: { loadAllTickers: async () => [ticker, missing] },
        dataProvider: createTestDataProvider({ getQuote: async symbol => { if (symbol === "MISSING") throw new Error("No quote"); return quote; } }),
      }),
      fail: (message: string) => { throw new Error(message); },
    } as unknown as CliCommandContext);
  } finally { logger.mockRestore(); }
  const result = output.join("\n");
  expect(result).toMatch(/Total P&L[^\n]*—/);
  expect(result).toContain("P&L unavailable for MISSING");
  expect(result).toContain("+$100");
});

test("portfolio JSON and CSV exports preserve signed positions, currencies and unknown totals", async () => {
  const config = createDefaultConfig("/unused-test-data");
  const missing: TickerRecord = { metadata: { ...ticker.metadata, ticker: "MISSING" } };
  let result: CliResult | undefined;
  const output: string[] = [];
  const logger = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  try {
    await showCollection("main", {
      cliOptions: { ...DEFAULT_CLI_OPTIONS, format: "json" },
      printResult: (value: CliResult) => { result = value; },
      initMarketData: async () => ({ config, persistence: { close() {} }, store: { loadAllTickers: async () => [ticker, missing] },
        dataProvider: createTestDataProvider({ getQuote: async symbol => { if (symbol === "MISSING") throw new Error("No quote"); return quote; } }),
      }),
      fail: (message: string) => { throw new Error(message); },
    } as unknown as CliCommandContext);
  } finally { logger.mockRestore(); }
  expect(output).toEqual([]);
  const json = JSON.parse(serializeCliResult(result!, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  expect(json.data[0]).toMatchObject({ symbol: "AAPL", shares: -10, costBasis: -1000, marketValue: -900, unrealizedPnl: 100, positionCurrency: "USD", baseCurrency: "USD" });
  expect(json.data[1]).toMatchObject({ symbol: "MISSING", marketValue: null, unrealizedPnl: null });
  expect(json.metadata).toMatchObject({ totalUnrealizedPnl: null, complete: false, unavailableSymbols: ["MISSING"],
    accountingBasis: expect.any(String), manualAccounting: expect.any(String) });
  const csv = serializeCliResult(result!, { ...DEFAULT_CLI_OPTIONS, format: "csv" });
  expect(csv).toContain("unrealizedPnl,baseCurrency");
  expect(csv).toContain("-1000,-900,100,USD");
});
