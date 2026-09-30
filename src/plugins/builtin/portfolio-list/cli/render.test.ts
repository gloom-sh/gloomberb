import { expect, spyOn, test } from "bun:test";
import { serializeCliResult, type CliResult } from "../../../../cli/result";
import { DEFAULT_CLI_OPTIONS } from "../../../../cli/options";
import { createDefaultConfig } from "../../../../types/config";
import type { TickerRecord } from "../../../../types/ticker";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { buildTickerReport, ticker as runTickerCommand } from "../../../../cli/commands/ticker";
import { buildPositionRows } from "../../ticker-detail/overview/model";
import { calculatePortfolioSummaryTotals, getSortValue } from "../metrics";
import { showCollection } from "./render";
import { portfolioCliCommand } from "./portfolio-command";
import { createTestTicker } from "../../../../test-support/ticker";
import { createTestCliContext } from "../../../../test-support/cli-context";

const ticker: TickerRecord = createTestTicker("AAPL", "Apple", {
  portfolios: ["main"],
  positions: [{ portfolio: "main", shares: -10, avgCost: 100, currency: "USD", broker: "manual" }],
});
const quote = { symbol: "AAPL", price: 90, currency: "USD", change: -5, changePercent: -5.26, previousClose: 95, lastUpdated: Date.now() };

test("CLI rejects blank acquisition cost before resolving or writing a ticker, and accepts explicit zero", async () => {
  const config = createDefaultConfig("/unused-cost-parser");
  let reads = 0;
  const saved: TickerRecord[] = [];
  const ctx = createTestCliContext({ config,
    store: { loadTicker: async () => { reads++; return ticker; }, saveTicker: async (record: TickerRecord) => { saved.push(record); } },
    dataProvider: createTestDataProvider(),
  }).context;
  for (const cost of ["", "  ", "NaN"]) {
    await expect(portfolioCliCommand.execute(["position", "set", "main", "AAPL", "10", cost], ctx)).rejects.toThrow("Average cost must be a valid number");
    expect(saved).toEqual([]);
    expect(reads).toBe(0);
  }
  const logger = spyOn(console, "log").mockImplementation(() => {});
  try { await portfolioCliCommand.execute(["position", "set", "main", "AAPL", "10", "0"], ctx); }
  finally { logger.mockRestore(); }
  expect(saved[0]?.metadata.positions[0]?.avgCost).toBe(0);
});

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
    await showCollection("main", createTestCliContext({ config, store: { loadAllTickers: async () => [ticker, missing] },
      dataProvider: createTestDataProvider({ getQuote: async symbol => { if (symbol === "MISSING") throw new Error("No quote"); return quote; } }),
    }).context);
  } finally { logger.mockRestore(); }
  const result = output.join("\n");
  expect(result).toMatch(/Total P&L[^\n]*—/);
  expect(result).toContain("P&L unavailable for MISSING");
  expect(result).toContain("+$100");
});

test("ticker, portfolio and overview select the same current or broker P&L across extended and unusable quotes", async () => {
  const config = createDefaultConfig("/unused-pnl-selection");
  for (const avgCost of [100, undefined]) {
    const record = { metadata: { ...ticker.metadata, positions: [{ portfolio: "main", broker: "demo", shares: 10,
      avgCost, currency: "EUR", marketValue: 1150, unrealizedPnl: 75, markPrice: 115 }] } };
    for (const currentQuote of [
      { ...quote, price: 120, currency: "USD", marketState: "POST" as const, postMarketPrice: 130 },
      { ...quote, price: Number.NaN, currency: "USD" },
    ]) {
      const financials = { quote: currentQuote, annualStatements: [], quarterlyStatements: [], priceHistory: [] };
      const toBase = (value: number, currency: string) => currency === "EUR" ? value * 1.2 : value;
      const expected = avgCost === 100 && Number.isFinite(currentQuote.price) ? 100 : 90;
      const expectedBasis = expected === 100 ? "quote-and-cost" : "broker-snapshot";
      const report = await buildTickerReport({ symbol: "AAPL", tickerFile: record, financials, config, toBase: async (value, currency) => toBase(value, currency) });
      expect(report).toMatch(/Broker Mark[^\n]*115/);
      expect(report).toMatch(new RegExp(`${expectedBasis === "broker-snapshot" ? "Broker P&L" : "P&L"}[^\\n]*\\+\\$${expected}`));
      const overview = buildPositionRows({ ticker: record, quote: currentQuote, quoteCurrency: "USD", baseCurrency: "USD", toBase })[0]!;
      expect(overview).toMatchObject({ pnlValue: expected, pnlBasis: expectedBasis });
      const context = { activeTab: "main", baseCurrency: "USD", exchangeRates: new Map([["EUR", 1.2]]), now: Date.now() };
      expect(getSortValue({ id: "pnl", label: "P&L", width: 10, align: "right" }, record, financials, context)).toBe(expected);
      expect(calculatePortfolioSummaryTotals([record], new Map([["AAPL", financials]]), "USD", context.exchangeRates, true, "main")).toMatchObject({
        unrealizedPnl: expected, unrealizedPnlBasis: expectedBasis,
      });
    }
  }
});

test("actual ticker command preserves stored positions and structured research when the returned quote is absent", async () => {
  const config = createDefaultConfig("/unused-no-quote-report");
  const record = { metadata: { ...ticker.metadata, positions: [{ portfolio: "main", broker: "demo", shares: 10,
    currency: "USD", marketValue: 1200, unrealizedPnl: 150, markPrice: 120 }] } };
  const financials = { annualStatements: [], quarterlyStatements: [], priceHistory: [], fundamentals: { eps: 5 } };
  let closes = 0;
  const dependencies = {
    initMarketData: async () => ({ config, dataDir: "/unused-no-quote-report", persistence: { close() { closes++; } },
      store: { loadTicker: async () => record }, dataProvider: { ...createTestDataProvider({ getTickerFinancials: async () => financials }), getNews: async () => [] },
    }) as any,
    fail: (message: string): never => { throw new Error(message); },
  };
  const output: string[] = [];
  const logger = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  try { await runTickerCommand("AAPL", dependencies); }
  finally { logger.mockRestore(); }
  expect(output.join("\n")).toContain("Quote unavailable.");
  expect(output.join("\n")).toMatch(/Position[^\n]*10 shares @ —/);
  expect(output.join("\n")).toMatch(/Cost Basis[^\n]*—/);
  expect(output.join("\n")).toMatch(/Market Value[^\n]*\$1,200/);
  expect(output.join("\n")).toMatch(/Broker P&L[^\n]*\+\$150/);
  let result: CliResult | undefined;
  await runTickerCommand("AAPL", { ...dependencies, printResult: value => { result = value; } });
  const json = JSON.parse(serializeCliResult(result!, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  expect(json.data.quote).toBeNull();
  expect(json.data.fundamentals).toEqual({ eps: 5 });
  expect(json.data.ticker.positions[0].avgCost).toBeUndefined();
  expect(json.data.ticker.positions[0].unrealizedPnl).toBe(150);
  expect(closes).toBe(2);
});

test("no-quote ticker command does not assign display currency to untyped broker values", async () => {
  const config = createDefaultConfig("/unused-no-source-currency");
  const record: TickerRecord = { metadata: { ...ticker.metadata, currency: "", positions: [{ portfolio: "main", broker: "demo", shares: 10,
    marketValue: 1200, unrealizedPnl: 150, markPrice: 120 }] } };
  const financials = { annualStatements: [], quarterlyStatements: [], priceHistory: [] };
  let conversions = 0;
  const dependencies = {
    initMarketData: async () => ({ config, dataDir: "/unused-no-source-currency", persistence: { close() {} },
      store: { loadTicker: async () => record }, dataProvider: { ...createTestDataProvider({
        getTickerFinancials: async () => financials,
        getExchangeRate: async (currency) => { conversions++; return currency === "EUR" ? 1.2 : 1; },
      }), getNews: async () => [] },
    }) as any,
    fail: (message: string): never => { throw new Error(message); },
  };
  const output: string[] = [];
  const logger = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  try { await runTickerCommand("AAPL", dependencies); }
  finally { logger.mockRestore(); }
  expect(output.join("\n")).toContain("Currency unavailable.");
  expect(output.join("\n")).toMatch(/Position[^\n]*10 shares @ —/);
  for (const label of ["Market Value", "P&L", "Broker Mark"]) expect(output.join("\n")).toMatch(new RegExp(`${label}[^\\n]*—`));
  expect(conversions).toBe(0);
  let result: CliResult | undefined;
  await runTickerCommand("AAPL", { ...dependencies, printResult: value => { result = value; } });
  const rawPosition = JSON.parse(serializeCliResult(result!, { ...DEFAULT_CLI_OPTIONS, format: "json" })).data.ticker.positions[0];
  expect(rawPosition).toMatchObject({ shares: 10, marketValue: 1200, unrealizedPnl: 150, markPrice: 120 });
  expect(rawPosition.currency).toBeUndefined();
  for (const sourceCurrency of ["position", "metadata"] as const) {
    const declared: TickerRecord = { metadata: { ...record.metadata, currency: sourceCurrency === "metadata" ? "EUR" : "",
      positions: [{ ...record.metadata.positions[0]!, currency: sourceCurrency === "position" ? "EUR" : undefined }] } };
    const report = await buildTickerReport({ symbol: "AAPL", tickerFile: declared, financials, config,
      toBase: async (value, currency) => currency === "EUR" ? value * 1.2 : Number.NaN });
    expect(report).toMatch(/Market Value[^\n]*\$1,440/);
    expect(report).toMatch(/Broker P&L[^\n]*\+\$180/);
    expect(report).toMatch(/Broker Mark[^\n]*€120/);
    expect(report).not.toContain("Currency unavailable");
  }
});

test("portfolio JSON and CSV exports preserve signed positions, currencies and unknown totals", async () => {
  const config = createDefaultConfig("/unused-test-data");
  const missing: TickerRecord = { metadata: { ...ticker.metadata, ticker: "MISSING" } };
  const cli = createTestCliContext({ config, store: { loadAllTickers: async () => [ticker, missing] },
    dataProvider: createTestDataProvider({ getQuote: async symbol => { if (symbol === "MISSING") throw new Error("No quote"); return quote; } }),
  }, { format: "json" });
  const output: string[] = [];
  const logger = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  try { await showCollection("main", cli.context); } finally { logger.mockRestore(); }
  const result = cli.printed[0]?.result;
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

test("portfolio exports retain missing cost and broker P&L basis without borrowing the live quote timestamp", async () => {
  const config = createDefaultConfig("/unused-test-data");
  const unknown: TickerRecord = { metadata: { ...ticker.metadata, positions: [
    { portfolio: "main", broker: "demo", shares: 10, currency: "USD", unrealizedPnl: 200 },
  ] } };
  let result: CliResult | undefined;
  const live = { ...quote, price: 120 };
  const exportRecord = async (record: TickerRecord, hasQuote: boolean) => {
    const cli = createTestCliContext({ config, store: { loadAllTickers: async () => [record] },
      dataProvider: createTestDataProvider({ getQuote: async () => { if (!hasQuote) throw new Error("No quote"); return live; } }),
    }, { format: "json" });
    await showCollection("main", cli.context);
    result = cli.printed[0]!.result;
    return JSON.parse(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  };
  const exported = await exportRecord(unknown, true);
  expect(exported.data[0]).toMatchObject({ avgCost: null, costBasis: null, marketValue: 1200, unrealizedPnl: 200,
    pnlBasis: "broker-snapshot", brokerUnrealizedPnl: 200, brokerPnlAsOf: null, quoteAsOf: live.lastUpdated });
  expect(exported.metadata).toMatchObject({ complete: false, totalUnrealizedPnl: 200, unavailableCostSymbols: ["AAPL"], brokerPnlSymbols: ["AAPL"] });
  const csv = serializeCliResult(result!, { ...DEFAULT_CLI_OPTIONS, format: "csv" });
  expect(csv).toContain("pnlBasis,brokerUnrealizedPnl");
  expect(csv).toContain("broker-snapshot,200,USD,");
  const noMark = await exportRecord(unknown, false);
  expect(noMark.data[0]).toMatchObject({ marketValue: null, unrealizedPnl: 200, pnlBasis: "broker-snapshot" });
  expect(noMark.metadata.complete).toBe(false);
  const report = await buildTickerReport({ symbol: "AAPL", tickerFile: unknown, financials: { quote: live, annualStatements: [], quarterlyStatements: [], priceHistory: [] }, config, toBase: async value => value });
  expect(report).toMatch(/Cost Basis[^\n]*—/);
  expect(report).toMatch(/Broker P&L[^\n]*\+\$200/);
  const restored = { metadata: { ...unknown.metadata, positions: [{ ...unknown.metadata.positions[0]!, avgCost: 100 }] } };
  expect((await exportRecord(restored, true)).data[0]).toMatchObject({ costBasis: 1000, unrealizedPnl: 200, pnlBasis: "quote-and-cost" });
  expect((await exportRecord(restored, true)).metadata.complete).toBe(true);
});

test("portfolio CLI quote context follows the selected contract and unresolved identity retains only its own broker mark", async () => {
  const config = createDefaultConfig("/unused-portfolio-identity");
  config.portfolios = [{ id: "a", name: "A", currency: "USD" }, { id: "b", name: "B", currency: "USD" }];
  const record: TickerRecord = { metadata: { ...ticker.metadata, ticker: "ACME", portfolios: ["a", "b"], positions: [
    { portfolio: "a", shares: 10, avgCost: 80, markPrice: 100, currency: "USD", broker: "ibkr", brokerInstanceId: "feed-a", brokerContractId: 101 },
    { portfolio: "b", shares: 10, avgCost: 160, markPrice: 200, currency: "USD", broker: "ibkr", brokerInstanceId: "feed-b", brokerContractId: 202 },
  ], broker_contracts: [
    { brokerId: "ibkr", brokerInstanceId: "feed-a", conId: 101, symbol: "ACME", currency: "USD", secType: "STK" },
    { brokerId: "ibkr", brokerInstanceId: "feed-b", conId: 202, symbol: "ACME", currency: "USD", secType: "STK" },
  ] } };
  const calls: unknown[] = [];
  const provider = createTestDataProvider({ getQuote: async (_symbol, _exchange, context) => {
    calls.push(context);
    return { ...quote, symbol: "ACME", price: context?.instrument?.conId === 202 ? 200 : 100 };
  } });
  const cli = createTestCliContext({ config, store: { loadAllTickers: async () => [record] }, dataProvider: provider }, { format: "json" });
  const ctx = cli.context;
  for (const id of ["a", "b"]) {
    await showCollection(id, ctx);
    expect(calls.at(-1)).toMatchObject({ brokerId: "ibkr", brokerInstanceId: `feed-${id}`, instrument: { conId: id === "a" ? 101 : 202 } });
    expect(cli.printed.at(-1)!.result.data[0]).toMatchObject({ quotePrice: id === "a" ? 100 : 200, marketValue: id === "a" ? 1000 : 2000, unrealizedPnl: id === "a" ? 200 : 400 });
  }
  record.metadata.broker_contracts!.pop();
  await showCollection("b", ctx);
  expect(calls).toHaveLength(2);
  expect(cli.printed.at(-1)!.result.data[0]).toMatchObject({ quotePrice: null, marketValue: 2000, unrealizedPnl: 400, pnlBasis: "broker-snapshot" });
  expect(cli.printed.at(-1)!.result.metadata?.complete).toBe(true);
  const output: string[] = [], logger = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  try { await showCollection("b", { ...ctx, cliOptions: DEFAULT_CLI_OPTIONS }); } finally { logger.mockRestore(); }
  expect(output.join("\n")).toContain("+$400");
  expect(calls).toHaveLength(2);
});
