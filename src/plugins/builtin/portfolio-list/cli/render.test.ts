import { describe, expect, spyOn, test } from "bun:test";
import { serializeCliResult, type CliResult } from "../../../../cli/result";
import { DEFAULT_CLI_OPTIONS } from "../../../../cli/options";
import { createDefaultConfig } from "../../../../types/config";
import type { TickerRecord } from "../../../../types/ticker";
import type { PricePoint, Quote } from "../../../../types/financials";
import type { FuturesContractTermsPayload } from "../../../../api-client/futures-curve";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { buildTickerReport, ticker as runTickerCommand } from "../../../../cli/commands/ticker";
import { buildPositionRows } from "../../ticker-detail/overview/model";
import { calculatePortfolioSummaryTotals, getSortValue } from "../metrics";
import { showCollection } from "./render";
import { portfolioCliCommand } from "./portfolio-command";
import { createTestTicker } from "../../../../test-support/ticker";
import { createTestCliContext } from "../../../../test-support/cli-context";
import { MemoryResourceStore } from "../../../../data/memory-resource-store";
import { persistBrokerAccounts } from "../../../../brokers/account-cache";
import type { BrokerAdapter } from "../../../../types/broker";
import type { BrokerAccount } from "../../../../types/trading";

const ticker: TickerRecord = createTestTicker("AAPL", "Apple", {
  portfolios: ["main"],
  positions: [{ portfolio: "main", shares: -10, avgCost: 100, currency: "USD", broker: "manual" }],
});
const quote = { symbol: "AAPL", price: 90, currency: "USD", change: -5, changePercent: -5.26, previousClose: 95, lastUpdated: Date.now() };

test("CLI rejects a blank or ambiguous acquisition cost and bare CASH before resolving or writing a ticker, and accepts explicit zero, a decimal comma and a three-decimal cost", async () => {
  const config = createDefaultConfig("/unused-cost-parser");
  let reads = 0;
  const saved: TickerRecord[] = [];
  const ctx = createTestCliContext({ config,
    store: { loadTicker: async () => { reads++; return ticker; }, loadAllTickers: async () => [], saveTicker: async (record: TickerRecord) => { saved.push(record); } },
    dataProvider: createTestDataProvider(),
  }).context;
  for (const cost of ["", "  ", "NaN"]) {
    await expect(portfolioCliCommand.execute(["position", "set", "main", "AAPL", "10", cost], ctx)).rejects.toThrow("Average cost must be a number such as 1234.5, 1,234.5 or 1.234,5");
    expect(saved).toEqual([]);
    expect(reads).toBe(0);
  }
  // A cost that reads two ways is refused naming both, never stored as either.
  await expect(portfolioCliCommand.execute(["position", "set", "main", "AAPL", "10", "1,234"], ctx)).rejects.toThrow("1234 (thousands) or 1.234 (decimal comma)");
  expect(reads).toBe(0);
  // Bare CASH once resolved to the company trading as CASH and valued the cash as its shares.
  await expect(portfolioCliCommand.execute(["position", "set", "main", "CASH", "500000", "1", "USD"], ctx)).rejects.toThrow("cash line");
  expect(reads).toBe(0);
  const logger = spyOn(console, "log").mockImplementation(() => {});
  try {
    await portfolioCliCommand.execute(["position", "set", "main", "AAPL", "10", "0"], ctx);
    await portfolioCliCommand.execute(["position", "set", "main", "AAPL", "10", "18,50"], ctx);
    // A cost per share is a price, not an amount of its currency: a lone dot is a decimal point.
    await portfolioCliCommand.execute(["position", "set", "main", "AAPL", "10", "123.456"], ctx);
  } finally { logger.mockRestore(); }
  expect(saved.map((record) => record.metadata.positions[0]?.avgCost)).toEqual([0, 18.5, 123.456]);
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
  expect(result).toMatch(/TOTAL[^\n]*—/);
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

test("a broker account's saved cash stands in for cash entered by hand, so it is never counted twice", async () => {
  const resources = new MemoryResourceStore();
  const instance = { id: "ibkr-main", brokerType: "ibkr", label: "IBKR", config: {} };
  persistBrokerAccounts(resources, instance, { id: "ibkr" } as unknown as BrokerAdapter,
    [{ accountId: "U1", name: "U1", currency: "USD", totalCashValue: 1_000, updatedAt: 1 } as BrokerAccount]);
  const config = createDefaultConfig("/unused-broker-cash");
  config.brokerInstances = [instance];
  config.portfolios = [{ id: "broker:ibkr-main:U1", name: "U1", currency: "USD", brokerId: "ibkr", brokerInstanceId: "ibkr-main",
    brokerAccountId: "U1", cash: { amount: 50_000, currency: "USD" }, targetWeights: { AAPL: 80 } }];
  const held: TickerRecord = { metadata: { ...ticker.metadata, portfolios: [config.portfolios[0]!.id],
    positions: [{ portfolio: config.portfolios[0]!.id, shares: 100, avgCost: 80, currency: "USD", broker: "ibkr" }] } };
  const cli = createTestCliContext({ config, store: { loadAllTickers: async () => [held] },
    persistence: { close() {}, resources }, dataProvider: createTestDataProvider({ getQuote: async () => quote }) }, { format: "json" });
  await showCollection("U1", cli.context);
  const { data, metadata } = cli.printed[0]!.result;
  expect(metadata).toMatchObject({ total: 10_000, cash: { source: "broker", amount: 1_000, value: 1_000, weight: 10 } });
  expect(data[0]).toMatchObject({ marketValue: 9_000, weight: 90, targetWeight: 80, drift: 10, tradeValue: -1_000 });
  expect(data[0].tradeShares).toBeCloseTo(-1_000 / 90, 8);
});

test("portfolio show --explain follows the report with the terms its table shows, and --json lists them", async () => {
  const config = createDefaultConfig("/unused-explain");
  config.portfolios = [{ id: "main", name: "Main", currency: "USD", targetWeights: { AAPL: 50 } }];
  const held: TickerRecord = { metadata: { ...ticker.metadata, positions: [{ portfolio: "main", shares: 10, avgCost: 80, currency: "USD", broker: "manual" }] } };
  const dependencies = { config, store: { loadAllTickers: async () => [held] }, dataProvider: createTestDataProvider({ getQuote: async () => quote }) };
  const output: string[] = [];
  const logger = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  try { await portfolioCliCommand.execute(["show", "Main", "--explain"], createTestCliContext(dependencies).context); }
  finally { logger.mockRestore(); }
  const text = output.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  const terms = text.slice(text.indexOf("Terms"));
  expect(text.indexOf("Terms")).toBeGreaterThan(text.indexOf("TOTAL"));
  for (const term of ["Weight", "Target", "Drift", "Trade", "Percentage point (pp)"]) expect(terms).toContain(`  ${term}  `);

  const cli = createTestCliContext(dependencies, { format: "json" });
  await portfolioCliCommand.execute(["show", "Main", "--explain"], cli.context);
  expect(cli.printed[0]!.result.metadata?.glossary).toMatchObject([{ term: "Weight" }, { term: "Target" }, { term: "Drift" }, { term: "Trade" }, { term: "Percentage point", short: "pp" }]);
  // Only show reads it; another action says where it belongs.
  await expect(portfolioCliCommand.execute(["target", "show", "Main", "--explain"], cli.context)).rejects.toThrow("--explain is an option of portfolio show");
});

test("portfolio show weighs each lot of a ticker by its own value and gives its target, drift and trade once, on a position line", async () => {
  const config = createDefaultConfig("/unused-lots");
  config.portfolios = [{ id: "main", name: "Main", currency: "USD", targetWeights: { AAPL: 50 } }];
  const lot = (shares: number, avgCost: number) => ({ portfolio: "main", shares, avgCost, currency: "USD", broker: "manual" });
  const held: TickerRecord = { metadata: { ...ticker.metadata, positions: [lot(10, 80), lot(20, 70)] } };
  const output: string[] = [];
  const logger = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  try { await showCollection("Main", createTestCliContext({ config, store: { loadAllTickers: async () => [held] }, dataProvider: createTestDataProvider({ getQuote: async () => quote }) }).context); }
  finally { logger.mockRestore(); }
  const lines = output.join("\n").replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((line) => line.startsWith("AAPL")).map((line) => line.replace(/\s+/g, " "));

  // At 90 the lots are worth 900 and 1,800: 33.3% and 66.7% of the total, with no target, drift or trade of their own.
  expect(lines).toEqual([
    expect.stringMatching(/^AAPL:NASDAQ .* 10 \$80\.00 \$900 33\.3% — — — — /),
    expect.stringMatching(/^AAPL:NASDAQ .* 20 \$70\.00 \$1,800 66\.7% — — — — /),
    // The position's: 30 shares, 2,700, all of the total against a 50.0% target, sell 15 (-1,350).
    "AAPL:NASDAQ (2 lots) 30 $2,700 100.0% 50.0% +50.0pp -15 -$1,350",
  ]);

  // JSON keeps one row per lot, the first with the position's figures, and marks them.
  const cli = createTestCliContext({ config, store: { loadAllTickers: async () => [held] }, dataProvider: createTestDataProvider({ getQuote: async () => quote }) }, { format: "json" });
  await showCollection("Main", cli.context);
  const { data } = cli.printed[0]!.result;
  expect(data[0]).toMatchObject({ weight: 100, targetWeight: 50, lots: 2 });
  expect(data[0].lotWeight).toBeCloseTo(100 / 3, 8);
  expect(data[1]).toMatchObject({ weight: null, targetWeight: null, lots: 2 });
});

describe("a portfolio holding a hedge", () => {
  const config = createDefaultConfig("/unused-hedge");
  config.portfolios = [{ id: "hedge", name: "Hedge", currency: "USD" }];
  const spy = createTestTicker("SPY", "SPDR S&P 500", { exchange: "ARCA", assetCategory: "ETF", portfolios: ["hedge"],
    positions: [{ portfolio: "hedge", shares: 600, avgCost: 660, currency: "USD", broker: "manual" }] });
  // Short ten gold contracts, entered at 100 oz each as `position set` stores them.
  const gold = (lot: Partial<TickerRecord["metadata"]["positions"][number]> = {}) => createTestTicker("GC=F", "Gold Dec 26", {
    exchange: "CMX", assetCategory: "FUTURE", portfolios: ["hedge"],
    positions: [{ portfolio: "hedge", shares: -10, avgCost: 4216.30, currency: "USD", broker: "manual", multiplier: 100, ...lot }],
  });
  const quotes: Record<string, Quote> = {
    SPY: { symbol: "SPY", price: 700, currency: "USD", change: 7, changePercent: 1, previousClose: 693, lastUpdated: Date.now() },
    // The Sunday Globex print, after Friday's settlement.
    "GC=F": { symbol: "GC=F", price: 4198, currency: "USD", change: 16.9, changePercent: 0.4, previousClose: 4181.10, lastUpdated: Date.now() },
  };
  const terms = (symbol: string): Promise<FuturesContractTermsPayload | null> => Promise.resolve(symbol !== "GC=F" ? null : {
    symbol, root: "GC", name: "Gold", contract: "GCZ26", contractSymbol: "GCZ26", deliveryMonth: "2026-12",
    spec: { unit: "USD / troy oz", size: "100 troy oz", pointValue: 100, tick: 0.1, tickValue: 10, settlement: "physical" },
    lastTrade: null, firstNotice: null, inDelivery: false, settlement: { price: 4181.10, date: "2026-10-16" },
  });
  const history = async (): Promise<PricePoint[]> => [
    { date: new Date("2026-10-15T00:00:00Z"), close: 4170.10 },
    { date: new Date("2026-10-16T00:00:00Z"), close: 4181.10 },
    // Monday's session has closed but is not settled: no settlement to measure from.
    { date: new Date("2026-10-19T00:00:00Z"), close: 4199, unsettled: true },
  ];
  const dependencies = (records: TickerRecord[]) => ({ config, store: { loadAllTickers: async () => records },
    dataProvider: createTestDataProvider({ getQuote: async (symbol) => quotes[symbol]! }) });
  const exported = async (records: TickerRecord[], options: Parameters<typeof showCollection>[2] = {}) => {
    const cli = createTestCliContext(dependencies(records), { format: "json" });
    await showCollection("Hedge", cli.context, { futuresSources: { terms, history }, ...options });
    return cli.printed[0]!.result as CliResult & { data: Record<string, unknown>[]; metadata: Record<string, unknown> };
  };
  const printed = async (records: TickerRecord[], options: Parameters<typeof showCollection>[2] = {}) => {
    const output: string[] = [];
    const logger = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
    try { await showCollection("Hedge", createTestCliContext(dependencies(records)).context, { futuresSources: { terms, history }, ...options }); }
    finally { logger.mockRestore(); }
    return output.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  };

  test("a short future counts its contracts at their size: value, cost, P&L and weight are signed, and exposure nets and grosses them", async () => {
    const { data, metadata } = await exported([spy, gold()]);
    const [future, equity] = [data.find((row) => row.symbol === "GC=F")!, data.find((row) => row.symbol === "SPY")!];
    // -10 contracts x 100 oz x $4,198: worth -$4,198,000, sold for $4,216,300.
    expect(future).toMatchObject({ shares: -10, marketValue: -4_198_000, costBasis: -4_216_300, contractMultiplier: 100, contractSize: "100 oz" });
    expect(future.unrealizedPnl as number).toBeCloseTo(18_300, 6);
    expect(equity).toMatchObject({ shares: 600, marketValue: 420_000, costBasis: 396_000, unrealizedPnl: 24_000 });
    expect(equity).not.toHaveProperty("contractMultiplier");
    expect(metadata.exposure).toEqual({ long: 420_000, short: -4_198_000, net: -3_778_000, gross: 4_618_000 });
    // The shorts outweigh the longs, so there is no positive total to weigh by.
    expect([future.weight, equity.weight]).toEqual([null, null]);

    const text = await printed([spy, gold()]);
    expect(text).toMatch(/GC=F:CMX .* -10 × 100 oz .* -\$4,198,000/);
    expect(text).toContain("Exposure: long $420,000, short -$4,198,000, net -$3,778,000, gross $4,618,000");
    expect(text).toContain("No weights: the shorts outweigh the longs and cash");

    // A book the longs outweigh weighs the short against its total.
    const hedged = { ...gold(), metadata: { ...gold().metadata, positions: [{ ...gold().metadata.positions[0]!, shares: -0.05 }] } };
    const weighed = (await exported([spy, hedged])).data;
    const total = 420_000 - 0.05 * 419_800;
    expect(weighed.find((row) => row.symbol === "GC=F")!.weight as number).toBeCloseTo((-0.05 * 419_800 / total) * 100, 8);
  });

  test("--close values a future at its settlement and dates it by the session, never at the Globex print", async () => {
    const { data, metadata } = await exported([spy, gold()], { basis: "regular-close" });
    const future = data.find((row) => row.symbol === "GC=F")!;
    expect(future).toMatchObject({ quotePrice: 4181.10, valuationPrice: 4181.10, valuationAsOf: "2026-10-16", valuationPriceKind: "settle" });
    expect(future.marketValue as number).toBeCloseTo(-4_181_100, 6);
    expect(future.quoteChange as number).toBeCloseTo(11, 6);
    expect(future.unrealizedPnl as number).toBeCloseTo(35_200, 6);
    expect(data.find((row) => row.symbol === "SPY")).not.toHaveProperty("valuationPriceKind");
    // The day's move is gold's settlement against the one before, -$11,000 for the short, plus SPY's.
    expect(metadata.dayChange as number).toBeCloseTo(600 * 7 - 11_000, 6);

    const text = await printed([spy, gold()], { basis: "regular-close" });
    expect(text).toContain("Priced at the regular close, futures at the settle");
    expect(text).toMatch(/GC=F:CMX +\$4,181\.10 .* Fri 16 Oct settle/);
    expect(text).not.toContain("4,198");

    // Without a confirmed settlement the future is not valued at the close, and the report says why.
    const unsettled = { terms: async (symbol: string) => ({ ...(await terms(symbol))!, settlement: null }), history };
    const missing = await exported([spy, gold()], { basis: "regular-close", futuresSources: unsettled });
    expect(missing.data.find((row) => row.symbol === "GC=F")).toMatchObject({ marketValue: null, valuationPrice: null });
    expect(missing.metadata).toMatchObject({ unsettledSymbols: ["GC=F"], complete: false });
  });

  test("a future without a contract size is not valued at one unit a contract, and one entered without it takes its terms' size", async () => {
    const unsized = gold({ multiplier: undefined });
    expect((await exported([spy, unsized])).data.find((row) => row.symbol === "GC=F")).toMatchObject({ marketValue: -4_198_000, contractMultiplier: 100 });

    const noTerms = { terms: async () => null, history };
    const { data, metadata } = await exported([spy, unsized], { futuresSources: noTerms });
    expect(data.find((row) => row.symbol === "GC=F")).toMatchObject({ marketValue: null, costBasis: null, unrealizedPnl: null, contractMultiplier: null });
    expect(metadata).toMatchObject({ unknownContractSizeSymbols: ["GC=F"], complete: false, exposure: { long: 420_000, short: 0 } });
    const text = await printed([spy, unsized], { futuresSources: noTerms });
    expect(text).toContain("No contract size for GC=F:CMX, so its value, cost and P&L are not shown.");
    expect(text).not.toContain("Cost unavailable for GC=F");
  });
});
