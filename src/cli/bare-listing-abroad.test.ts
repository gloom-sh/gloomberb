import { afterEach, expect, spyOn, test } from "bun:test";
import { AppPersistence } from "../data/app-persistence";
import { JsonTickerRepository } from "../data/json-ticker-repository";
import { TickerRepository } from "../data/ticker-repository";
import { getLoadablePlugins } from "../plugins/catalog";
import { noProviderError } from "../sources/provider-errors";
import { resolveTickerOpenTarget } from "../tickers/open-target";
import { createDefaultConfig } from "../types/config";
import type { DataProvider } from "../types/data-provider";
import type { InstrumentSearchResult } from "../types/instrument";
import { createTestCliContext } from "../test-support/cli-context";
import { captureConsole } from "../test-support/console";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../test-support/data-provider";
import { createTestArticle } from "../test-support/news";
import { marketDataCliCommands } from "./commands/market";
import { ticker } from "./commands/ticker";
import * as paneShot from "./desktop-pane-shot";
import { resolveCliListing } from "./listing-arg";
import { runPaneFunction } from "./pane-functions";
import { DEFAULT_CLI_OPTIONS } from "./options";
import { serializeCliResult } from "./result";
import type { MarketContext } from "./types";

/**
 * O8A is Pelican Aqua Holding, listed in Frankfurt alone: the data service answers "Not a ticker" for the bare code,
 * search lists O8A on FWB2, and that listing quotes. AAPL quotes as itself; 2222 is two companies' code.
 */
const LISTINGS: Record<string, Array<[string, string]>> = {
  O8A: [["FWB2", "Pelican Aqua Holding Plc"]],
  "2222": [["JPX", "Kotobuki Spirits Co., Ltd."], ["TADAWUL", "Saudi Arabian Oil Co."]],
};
const O8A = createTestQuote({ symbol: "O8A", name: "Pelican Aqua Holding Plc", price: 1.21, currency: "EUR", listingExchangeName: "FWB2", exchangeName: "FWB2" });
const AAPL = createTestQuote({ symbol: "AAPL", name: "Apple Inc.", listingExchangeName: "NASDAQ", exchangeName: "NASDAQ" });

const notATicker = (symbol: string) => new Error(`Not a ticker: ${symbol}.`);

/** The Frankfurt line, asked by its key or by the code with its venue, as the service answers both. */
const onFrankfurt = (symbol: string, exchange = "") => exchange === "FWB2" && (symbol === "O8A:FWB2" || symbol === "O8A");

function quoteOf(symbol: string, exchange = ""): ReturnType<DataProvider["getQuote"]> {
  if (symbol === "AAPL") return Promise.resolve(AAPL);
  if (onFrankfurt(symbol, exchange)) return Promise.resolve(O8A);
  return Promise.reject(notATicker(symbol));
}

/** Each request the provider was asked, as `method symbol exchange`. */
function frankfurtOnly(overrides: Partial<DataProvider> = {}) {
  const asked: string[] = [];
  const dataProvider = createTestDataProvider({
    search: async (query) => (LISTINGS[query.toUpperCase()] ?? []).map(([exchange, name]): InstrumentSearchResult => ({
      providerId: "test", symbol: query.toUpperCase(), name, exchange, type: "Common Stock", currency: "EUR",
    })),
    getQuote: async (symbol, exchange) => { asked.push(`quote ${symbol} ${exchange ?? ""}`.trim()); return quoteOf(symbol, exchange); },
    getTickerFinancials: async (symbol, exchange) => {
      asked.push(`financials ${symbol} ${exchange ?? ""}`.trim());
      if (!onFrankfurt(symbol, exchange)) throw notATicker(symbol);
      return createTestFinancials({ quote: O8A, profile: { description: "A maritime aqua-service company.", sector: "Consumer Defensive" } });
    },
    getNews: async (query) => {
      asked.push(`news ${query.ticker} ${query.exchange ?? ""}`.trim());
      return onFrankfurt(query.ticker ?? "", query.exchange) ? [createTestArticle("wellboats", { title: "Pelican Aqua orders two more wellboats", tickers: ["O8A"] })] : [];
    },
    ...overrides,
  });
  return { dataProvider, asked };
}

const store = { loadTicker: async () => null, loadAllTickers: async () => [] };

afterEach(() => {
  process.exitCode = 0;
});

test("a bare code no source quotes is the listing quote reads it on, named; a code that quotes, or several companies list, stays as typed", async () => {
  const { dataProvider, asked } = frankfurtOnly();
  const o8a = await resolveCliListing("O8A", undefined, { store, dataProvider });
  expect(o8a).toMatchObject({ symbol: "O8A", exchange: "FWB2", key: "O8A:FWB2", request: { symbol: "O8A:FWB2", exchange: "FWB2" }, readAs: "O8A -> FWB2" });

  // A US code keeps its own listing; one the shipped listings know asks nothing at all.
  expect((await resolveCliListing("AAPL", undefined, { store, dataProvider })).key).toBe("AAPL");
  asked.length = 0;
  const known = frankfurtOnly({ knownUsStock: (symbol) => symbol === "AAPL" });
  expect((await resolveCliListing("AAPL", undefined, { store, dataProvider: known.dataProvider })).key).toBe("AAPL");
  expect(known.asked).toEqual([]);
  // Two companies' code goes to neither: the command asks which once its own request fails, as `quote` does.
  expect((await resolveCliListing("2222", undefined, { store, dataProvider })).key).toBe("2222");
  // A source that failed says nothing of the code: no search is made of an outage.
  let searched = 0;
  const outage = frankfurtOnly({
    getQuote: async (symbol) => { throw noProviderError(`No quote provider available for ${symbol}`, { failure: new Error("timed out") }, symbol); },
    search: async () => { searched += 1; return []; },
  });
  expect((await resolveCliListing("O8A", undefined, { store, dataProvider: outage.dataProvider })).key).toBe("O8A");
  expect(searched).toBe(0);
  // `quote` reads the code itself after its own request, so it gets it as typed.
  expect((await resolveCliListing("O8A", undefined, { store, dataProvider }, { listingAbroad: false })).key).toBe("O8A");
});

const config = createDefaultConfig("/tmp/gloom-bare-listing-abroad");

test("ticker and news read a bare code listed abroad alone on that listing, and name it, as quote does", async () => {
  const { dataProvider, asked } = frankfurtOnly();

  let report: any;
  let warnings: string[] = [];
  await ticker("O8A", {
    listingIpo: async () => null,
    initMarketData: async () => ({ config, dataDir: "/tmp/gloom-bare-listing-abroad", store, persistence: { close: () => {} }, dataProvider }) as unknown as MarketContext,
    fail: (message) => { throw new Error(message); },
    printResult: (result) => { report = result.data; warnings = result.warnings ?? []; },
  });
  expect(asked).toContain("financials O8A:FWB2 FWB2");
  expect(asked).not.toContain("financials O8A");
  expect(report).toMatchObject({ symbol: "O8A:FWB2", listing: { exchange: "FWB2", name: "Pelican Aqua Holding Plc" } });
  expect(warnings).toContain("O8A -> FWB2");

  const cli = createTestCliContext({ dataProvider });
  await marketDataCliCommands.find((command) => command.name === "news")!.execute(["O8A"], cli.context);
  const news = cli.printed[0]!;
  expect(news.result.metadata).toMatchObject({ ticker: "O8A:FWB2" });
  expect(news.result.warnings).toEqual(["O8A -> FWB2"]);
  expect(serializeCliResult(news.result, { ...DEFAULT_CLI_OPTIONS, color: false }, news.options)).toContain("Pelican Aqua orders two more wellboats");
});

async function runFrankfurtDes(config: ReturnType<typeof createDefaultConfig>) {
  const { dataProvider } = frankfurtOnly();
  const persistence = new AppPersistence(":memory:");
  const fn = createTestCliContext({ config, dataProvider, persistence, store: new TickerRepository(persistence.tickers) });
  fn.context.plugins = getLoadablePlugins();
  try {
    await captureConsole(() => runPaneFunction(["DES", "O8A"], fn.context));
    return fn.printed[0]!.result;
  } finally {
    persistence.close();
  }
}

test("fn DES routes the bare code to Frankfurt and names the listing in a warning", async () => {
  const prepare = spyOn(paneShot, "prepareDesktopPaneShotView").mockImplementation(() => {});
  const render = spyOn(paneShot, "renderDesktopPaneScreenshot").mockResolvedValue({
    visibleText: "Company overview", rows: [], truncated: false, truncationReasons: [], loadingStateDetected: false,
    errorStateDetected: false, errorStateMarkers: [], emptyStateDetected: false, emptyStateMarkers: [], semanticUi: [],
  });
  try {
    const result = await runFrankfurtDes(config);
    expect(render).toHaveBeenCalledTimes(1);
    expect(result.warnings).toContain("O8A -> FWB2");
    expect(result.data.symbols).toEqual(["O8A:FWB2"]);
    expect(result.failure).toBeUndefined();
  } finally {
    render.mockRestore();
    prepare.mockRestore();
  }
});

test.skipIf(process.env.GLOOM_TEST_DES_RENDER !== "1")("renders DES in Chrome with fixture data", async () => {
  const profile = process.env.GLOOMBERB_HOME;
  if (!profile) throw new Error("Run this smoke check with bun --no-env-file scripts/smoke-des-render.ts.");
  const result = await runFrankfurtDes(createDefaultConfig(profile));
  expect(result.failure).toBeUndefined();
  expect(result.data).toMatchObject({ source: "dom", empty: false, symbols: ["O8A:FWB2"] });
  expect(result.data.visibleText).toContain("A maritime aqua-service company.");
}, 90_000);

test("the command bar and a $O8A link open the code on the listing search finds for it", async () => {
  const { dataProvider } = frankfurtOnly();
  // A board row or a link opens public listings only; the command bar searches first.
  for (const publicOnly of [false, true]) {
    const tickerRepository = new JsonTickerRepository();
    const target = await resolveTickerOpenTarget({ query: "O8A", tickers: new Map(), dataProvider, tickerRepository, publicOnly });
    expect(target?.ticker.metadata).toMatchObject({ ticker: "O8A", exchange: "FWB2", name: "Pelican Aqua Holding Plc" });
  }
});
