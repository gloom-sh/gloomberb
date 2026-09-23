import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { Quote, TickerFinancials } from "../../types/financials";
import type { CliCommandContext } from "../../types/plugin";
import type { HeadlessPaneContext } from "../../types/headless";
import { createTestDataProvider } from "../../test-support/data-provider";
import { renderHeadlessPaneText } from "../pane-functions/headless";
import { quoteComparisonHeadless } from "../../plugins/builtin/ticker-detail/headless";
import { marketDataCliCommands } from "./market";
import { buildTickerReport } from "./ticker";

const config = createDefaultConfig("/tmp/gloom-quote-basis-test");
const rawQuote = { symbol: "BONDTEST", price: 87, change: 1, changePercent: 100 / 86,
  currency: "USD", lastUpdated: 1_789_200_000_000, instrumentType: "BOND" } satisfies Quote;

// The same raw values travel through different display adapters. The convention
// belongs to the successful quote, independent of saved holdings/classification.
test("ticker report keeps quote and change units consistent without a saved ticker", async () => {
  for (const [quote, quoteMetadata, price, change] of [
    [{ ...rawQuote, priceBasis: "percent-of-par" }, undefined, "87% par", "+1% par"],
    [rawQuote, undefined, null, "—"],
    [{ ...rawQuote, instrumentType: undefined }, { instrumentType: "BOND" }, null, "—"],
    [{ ...rawQuote, priceBasis: "per-unit" }, undefined, "$87", "+$1.00"],
    [{ ...rawQuote, instrumentType: "STK" }, { instrumentType: "BOND" }, "$87", "+$1.00"],
  ] as const) {
    const financials = { quote, quoteMetadata, annualStatements: [], quarterlyStatements: [], priceHistory: [] } as TickerFinancials;
    const text = await buildTickerReport({ symbol: rawQuote.symbol, tickerFile: null, financials, config, toBase: async value => value });
    const lastLine = text.split("\n").find(line => line.includes("Last")) ?? "";
    const changeLine = text.split("\n").find(line => line.includes("Change")) ?? "";
    if (price === null) expect(lastLine === "" || lastLine.includes("—")).toBe(true);
    else expect(lastLine).toContain(price);
    expect(changeLine).toContain(change);
    if (price === "87% par") expect(changeLine).not.toContain("$");
  }
});

test("quote command preserves raw declarations and formats its actual output rows", async () => {
  const quotes = [
    { ...rawQuote, symbol: "PAR", priceBasis: "percent-of-par" as const },
    { ...rawQuote, symbol: "UNKNOWN" },
    { ...rawQuote, symbol: "UNIT", priceBasis: "per-unit" as const },
  ];
  let closed = 0;
  let captured: unknown;
  let rows: Array<Record<string, unknown>> = [];
  const ctx = {
    cliOptions: {},
    initMarketData: async () => ({ config, persistence: { close() { closed++; } }, dataProvider: {
      getQuotesBatch: async () => quotes.map(quote => ({ target: { symbol: quote.symbol, exchange: "" }, quote })),
    } }),
    printResult: (result: { data: unknown }, options: { rows: (data: unknown) => Array<Record<string, unknown>> }) => {
      captured = result.data;
      rows = options.rows(result.data);
    },
    fail(message: string): never { throw new Error(message); },
  } as unknown as CliCommandContext;
  await marketDataCliCommands.find(command => command.name === "quote")!.execute(quotes.map(quote => quote.symbol), ctx);
  expect((captured as Array<{ quote: Quote }>).map(row => row.quote)).toEqual(quotes);
  expect(rows.map(row => row.price)).toEqual(["87.00% par", "—", "$87.00"]);
  expect(rows.map(row => row.rawPrice)).toEqual([87, 87, 87]);
  expect(closed).toBe(1);
});

test("quote monitor headless text and raw rows agree on par, unknown and monetary units", async () => {
  for (const basis of ["percent-of-par", undefined, "per-unit"] as const) {
    const quote = { ...rawQuote, priceBasis: basis };
    const args = { symbols: [quote.symbol], argument: [quote.symbol], rawArgument: quote.symbol, options: {} };
    const ctx = { signal: new AbortController().signal, marketData: createTestDataProvider({ getQuote: async () => quote }) } as HeadlessPaneContext;
    const result = await quoteComparisonHeadless.load(args, ctx);
    const restored = JSON.parse(JSON.stringify(result));
    expect(restored.rows[0]).toMatchObject({ price: 87, change: 1, instrumentType: "BOND", currency: "USD" });
    expect(restored.rows[0].priceBasis).toBe(basis);
    const text = renderHeadlessPaneText(quoteComparisonHeadless, result, args, "Quote Monitor");
    if (basis === "percent-of-par") {
      expect(text).toContain("87.00% par"); expect(text).toContain("+1.00% par"); expect(text).not.toContain("$");
    } else if (basis === "per-unit") {
      expect(text).toContain("$87.00"); expect(text).toContain("+$1.00");
    } else {
      expect(text).not.toContain("$87"); expect(text).not.toContain("+$1"); expect(text).not.toContain("+—");
    }
  }
});
