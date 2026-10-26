import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../../data/app-persistence";
import { TickerRepository } from "../../../data/ticker-repository";
import { getLoadablePlugins } from "../../catalog";
import { runPaneFunction } from "../../../cli/pane-functions";
import { marketDataCliCommands } from "../../../cli/commands/market";
import { createDefaultConfig } from "../../../types/config";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import { createTestCliContext, type PrintedCliResult } from "../../../test-support/cli-context";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { captureConsole } from "../../../test-support/console";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { argumentWithListing } from "./headless";

const quoteCommand = marketDataCliCommands.find((command) => command.name === "quote")!;
const config = createDefaultConfig("/tmp/gloom-chart-bare-listing-fixture");

afterEach(() => { process.exitCode = 0; });

// 2222 is Kotobuki Spirits in Tokyo and Saudi Aramco in Riyadh; no source quotes the bare code.
// AAPL quotes as itself.
const QUOTES: Record<string, ReturnType<typeof createTestQuote>> = {
  "2222:JPX": createTestQuote({ symbol: "2222", name: "Kotobuki Spirits Co., Ltd.", currency: "JPY", instrumentType: "EQUITY", listingExchangeName: "JPX" }),
  "2222:TADAWUL": createTestQuote({ symbol: "2222", name: "Saudi Arabian Oil Co.", currency: "SAR", instrumentType: "EQUITY", listingExchangeName: "TADAWUL" }),
  AAPL: createTestQuote({ symbol: "AAPL", name: "Apple Inc.", currency: "USD", instrumentType: "EQUITY", listingExchangeName: "NASDAQ" }),
  // The bare coin ticker is a fund, as the data service answers it.
  ETH: createTestQuote({ symbol: "ETH", name: "Grayscale Ethereum Mini Trust ETF", currency: "USD", instrumentType: "ETF", listingExchangeName: "ARCA" }),
};
const VENUES: Record<string, Array<[string, string]>> = {
  "2222": [["JPX", "Kotobuki Spirits Co., Ltd."], ["TADAWUL", "Saudi Arabian Oil Co."]],
  AAPL: [["NASDAQ", "Apple Inc."]],
};
const BARS = Array.from({ length: 5 }, (_, day) => ({
  date: new Date(Date.UTC(2026, 9, 5 + day)), open: 30, high: 30, low: 30, close: 30, volume: 1_000,
}));

function quoteOf(symbol: string, exchange = "") {
  const key = parsePublicTickerKey(symbol);
  const venue = key.exchange || exchange;
  const quote = QUOTES[venue && key.symbol !== "AAPL" ? `${key.symbol}:${venue}` : key.symbol];
  if (!quote) throw new Error(`No quote provider available for ${symbol}`);
  return quote;
}

const dataProvider = createTestDataProvider({
  search: async (query) => (VENUES[query.trim().toUpperCase()] ?? []).map(([exchange, name]) => ({
    providerId: "test", symbol: query.trim().toUpperCase(), name, exchange, type: "Common Stock", currency: "USD",
  })),
  getQuote: async (symbol, exchange) => quoteOf(symbol, exchange),
  getQuotesBatch: async (targets: QuoteSubscriptionTarget[]) => targets.map((target) => {
    try {
      return { target, quote: quoteOf(target.symbol, target.exchange) };
    } catch (error) {
      return { target, quote: null, error: (error as Error).message };
    }
  }),
  // The bars come back for the bare code too, as a source that picks one line answers.
  getTickerFinancials: async (symbol, exchange) => {
    let quote = null;
    try { quote = quoteOf(symbol, exchange); } catch { /* history without a quote */ }
    return createTestFinancials({ quote: quote ?? undefined, priceHistory: BARS });
  },
  getPriceHistory: async () => BARS,
  getPriceHistoryWithMetadata: async () => ({ resolution: "1d", points: BARS }),
});

function failing(cli: ReturnType<typeof createTestCliContext>) {
  const failure: { message?: string; details?: string } = {};
  cli.context.fail = (message: string, details?: string): never => {
    Object.assign(failure, { message, details });
    throw new Error(message);
  };
  return failure;
}

async function run(args: string[], command: "fn" | "quote") {
  const persistence = new AppPersistence(":memory:");
  const cli = createTestCliContext({ config, dataProvider, persistence, store: new TickerRepository(persistence.tickers) });
  (cli.context as { plugins?: unknown }).plugins = getLoadablePlugins();
  const failure = failing(cli);
  try {
    const execute = async () => command === "fn" ? runPaneFunction(args, cli.context) : quoteCommand.execute(args, cli.context);
    await captureConsole(() => execute().catch(() => {}));
    return { failure, printed: cli.printed[0] as PrintedCliResult | undefined };
  } finally {
    persistence.close();
  }
}

test("a chart reads a bare code several companies list as quote does: it asks which, with quote's listings", async () => {
  const quoted = await run(["2222"], "quote");
  const charted = await run(["G", "2222"], "fn");
  expect(charted.printed).toBeUndefined();
  expect(charted.failure.message).toBe("Choose an exchange for 2222.");
  expect(charted.failure.message).toBe(quoted.failure.message!);
  expect(charted.failure.details).toBe(quoted.failure.details!.replaceAll("gloom quote", "gloom fn G"));
  expect(charted.failure.details).toContain("2222:TADAWUL Saudi Arabian Oil Co. (try: gloom fn G 2222:TADAWUL)");
  // Each retry keeps the rest of the argument.
  expect((await run(["G", "2222:volume, AAPL"], "fn")).failure.details).toContain("(try: gloom fn G 2222:JPX:volume, AAPL)");
});

test("a chart of a bare coin ticker read as a fund says where the coin is, as quote does", async () => {
  const { printed } = await run(["G", "ETH, AAPL"], "fn");
  expect(printed!.result.warnings).toEqual(["ETH is Grayscale Ethereum Mini Trust ETF, not ethereum. For ethereum use ETH-USD."]);
  expect((await run(["G", "AAPL"], "fn")).printed!.result.warnings ?? []).toEqual([]);
});

test("a charted listing names its company and its currency", async () => {
  for (const [argument, name, unit] of [["2222:TADAWUL", "Saudi Arabian Oil Co.", "SAR/share"], ["AAPL", "Apple Inc.", "USD/share"]] as const) {
    const { failure, printed } = await run(["G", argument], "fn");
    expect(failure.message).toBeUndefined();
    const [series] = (printed!.result.data as { series: Array<{ name?: string; unit?: string }> }).series;
    expect([series?.name, series?.unit]).toEqual([name, unit]);
  }
});

test("fn G charts the series of a list pasted with stray separators, and nothing for the empty items", async () => {
  const { failure, printed } = await run(["G", "AAPL,,2222:TADAWUL,"], "fn");
  expect(failure.message).toBeUndefined();
  expect((printed!.result.data as { series: Array<{ name?: string }> }).series.map((series) => series.name))
    .toEqual(["Apple Inc.", "Saudi Arabian Oil Co."]);
  // Separators alone are no list.
  const none = await run(["G", ",, ,"], "fn");
  expect(none.printed).toBeUndefined();
  expect(none.failure.message).toStartWith('Invalid chart series ",, ,": no series between its separators.');
});

test("a retry names the listing in place of the bare symbol, wherever the argument has it", () => {
  expect(argumentWithListing("BDI", "BDI", "BDI:TSX")).toBe("BDI:TSX");
  expect(argumentWithListing("aapl, bdi:volume", "BDI", "BDI:TSX")).toBe("aapl, BDI:TSX:volume");
  // A named listing, or an argument that does not spell the series, is left alone.
  expect(argumentWithListing("BDI:NEO, BDI", "BDI", "BDI:TSX")).toBe("BDI:NEO, BDI:TSX");
  expect(argumentWithListing("FUT:CL", "CL=F", "CL=F:NYMEX")).toBe("CL=F:NYMEX");
});
