import { afterEach, expect, test } from "bun:test";
import type { DataProvider } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import type { TickerChanges } from "../../types/ticker-changes";
import type { MarketContext } from "../types";
import { createDefaultConfig } from "../../types/config";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../test-support/data-provider";
import { captureConsole } from "../../test-support/console";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { printCliError } from "../errors";
import { marketDataCliCommands } from "./market";
import { ticker } from "./ticker";

const history = marketDataCliCommands.find((command) => command.name === "history")!;
const quote = marketDataCliCommands.find((command) => command.name === "quote")!;
const config = createDefaultConfig("/tmp/gloom-moved-symbols-fixture");

afterEach(() => { process.exitCode = 0; });

// HFC's company became DINO; RDS-A's (and RDS-B's) became SHEL, as Gloom Cloud answers them.
const HFC_HOP = { from: "HFC", to: "DINO", date: "2022-03-15" };
const RDS_HOP = { from: "RDS.A", to: "SHEL", date: "2022-01-31" };
const FB_HOP = { from: "FB", to: "META", date: "2022-06-09" };
const CHANGES: Record<string, TickerChanges> = {
  HFC: { symbol: "HFC", moved: { symbol: "DINO", name: "HF Sinclair Corp", hops: [HFC_HOP] }, formerly: null, listedName: null, changes: [HFC_HOP] },
  "RDS-A": { symbol: "RDS.A", moved: { symbol: "SHEL", name: "Shell plc", hops: [RDS_HOP] }, formerly: null, listedName: null, changes: [RDS_HOP] },
  // A new company holds META now: the fund that was META moved to METV, Meta Platforms renamed into it.
  META: {
    symbol: "META", moved: null, formerly: [FB_HOP], listedName: "Meta Platforms, Inc.",
    changes: [FB_HOP, { from: "META", to: "METV", date: "2022-01-31" }],
  },
};

const HFC_LAST = Date.parse("2022-03-14T23:00:00.002Z");
const RDS_LAST = Date.parse("2022-01-29T00:00:00.001Z");
// The old lines' quotes stopped in 2022, while their source still states today's session.
const QUOTES: Record<string, Quote> = {
  HFC: createTestQuote({ symbol: "HFC", price: 36.39, lastUpdated: HFC_LAST, lastTradeTime: HFC_LAST, marketState: "REGULAR", stale: true }),
  "RDS-A": createTestQuote({
    symbol: "RDS-A", name: "Shell Plc Sponsored American Depositary Receipt", price: 51.04, listingExchangeName: "NYSE", exchangeName: "NYSE",
    lastUpdated: RDS_LAST, lastTradeTime: RDS_LAST, marketState: "REGULAR", stale: true,
  }),
  META: createTestQuote({ symbol: "META", name: "Meta Platforms, Inc.", price: 736.72, listingExchangeName: "NASDAQ", exchangeName: "NASDAQ", marketState: "REGULAR" }),
  AAPL: createTestQuote({ symbol: "AAPL", name: "Apple Inc.", price: 342, listingExchangeName: "NASDAQ", exchangeName: "NASDAQ", marketState: "REGULAR" }),
};
// Bars come back for every symbol: another listing's under HFC (a Canadian line), SHEL's under RDS-A.
const CLOSES: Record<string, number> = { HFC: 0.26, "RDS-A": 103.58, META: 736.72, AAPL: 342 };

function source(changes: DataProvider["getTickerChanges"] = async (symbol) => CHANGES[symbol] ?? null): DataProvider {
  const quoteOf = (symbol: string) => {
    const found = QUOTES[symbol];
    if (!found) throw new Error(`Not a ticker: ${symbol}.`);
    return found;
  };
  return createTestDataProvider({
    getQuote: async (symbol) => quoteOf(symbol),
    getQuotesBatch: async (targets) => targets.map((target) => ({ target, quote: quoteOf(target.symbol) })),
    getPriceHistoryWithMetadata: async (symbol) => ({
      resolution: "1d",
      points: [{ date: new Date("2026-10-14"), open: CLOSES[symbol]!, high: CLOSES[symbol]!, low: CLOSES[symbol]!, close: CLOSES[symbol]!, volume: 0 }],
    }),
    getTickerFinancials: async (symbol) => createTestFinancials({ quote: quoteOf(symbol), profile: { sector: "Financial Services" } }),
    getNews: async () => [],
    getTickerChanges: changes,
  });
}

async function runHistory(args: string[], dataProvider = source()) {
  const cli = createTestCliContext({ config, dataProvider });
  const error = await history.execute(args, cli.context).then(() => null, (failure: unknown) => failure);
  return { error, printed: cli.printed[0] as PrintedCliResult | undefined };
}

async function runTicker(symbol: string, dataProvider = source()) {
  let data: unknown = null;
  const error = await ticker(symbol, {
    initMarketData: async () => ({
      config, dataDir: "/tmp/gloom-moved-symbols-fixture", dataProvider,
      store: { loadTicker: async () => null, loadAllTickers: async () => [] }, persistence: { close: () => {} },
    }) as unknown as MarketContext,
    fail: (message) => { throw new Error(message); },
    printResult: (result) => { data = result.data; },
  }).then(() => null, (failure: unknown) => failure);
  return { error, data };
}

/** What `--json` prints for a failure: the same printer the CLI ends every failed command with. */
async function jsonError(error: unknown) {
  const { stderr } = await captureConsole(() => printCliError(error, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  return JSON.parse(stderr) as { ok: boolean; error: Record<string, unknown> };
}

test("history and ticker of a symbol whose company moved serve nothing of their own and name its new symbol, in one line and in --json", async () => {
  const hfc = await runHistory(["HFC"]);
  expect((hfc.error as Error).message).toBe("HFC became DINO on 2022-03-15: `gloomberb history DINO`");
  expect(hfc.printed).toBeUndefined();
  expect(await jsonError(hfc.error)).toEqual({
    ok: false,
    error: {
      code: "ticker_moved",
      message: "HFC became DINO on 2022-03-15: `gloomberb history DINO`",
      retry: "gloomberb history DINO",
      tickerChange: {
        symbol: "HFC", kind: "moved", note: "HFC became DINO on 2022-03-15", changes: [HFC_HOP],
        tradesAs: "DINO", issuer: "HF Sinclair", listed: null,
      },
    },
  });
  // The range asked for carries over; SHEL's bars are not served under RDS-A's name.
  const rds = await runHistory(["RDS-A", "--range", "5Y"]);
  expect((rds.error as Error).message).toBe("RDS-A became SHEL on 2022-01-31: `gloomberb history SHEL --range 5Y`");
  expect(rds.printed).toBeUndefined();

  for (const [symbol, line] of [
    ["HFC", "HFC became DINO on 2022-03-15: `gloomberb ticker DINO`"],
    ["RDS-A", "RDS-A became SHEL on 2022-01-31: `gloomberb ticker SHEL`"],
  ] as const) {
    const report = await runTicker(symbol);
    expect((report.error as Error).message).toBe(line);
    expect(report.data).toBeNull();
    expect((await jsonError(report.error)).error).toMatchObject({ code: "ticker_moved", retry: line.split("`")[1] });
  }
});

async function runQuote(symbols: string[]) {
  const cli = createTestCliContext({ config, dataProvider: source() });
  await quote.execute(symbols, cli.context);
  const [{ result, options }] = cli.printed as [PrintedCliResult];
  return { result, rows: options!.rows!(result.data) as Array<{ symbol: string; session: string; price: string }> };
}

test("quote of a moved symbol names its new symbol beside the old line's last price and reads STALE; META and AAPL are served as before", async () => {
  const moved = await runQuote(["HFC", "RDS-A"]);
  expect(moved.result.warnings).toEqual([
    "HFC became DINO on 2022-03-15: `gloomberb quote DINO`",
    "RDS-A became SHEL on 2022-01-31: `gloomberb quote SHEL`",
    "HFC: no longer trading since 2022-03-14 (last price $36.39)",
    "RDS-A (Shell Plc Sponsored American Depositary Receipt): no longer trading since 2022-01-28 (last price $51.04)",
  ]);
  expect(moved.rows.map(({ symbol, session, price }) => [symbol, session, price])).toEqual([["HFC", "STALE", "$36.39"], ["RDS-A", "STALE", "$51.04"]]);
  // A dead line's market is not where its price is: the closing line says nothing of the session beside it.
  expect(moved.result.freshness?.market).toBeUndefined();
  const current = await runQuote(["META", "AAPL"]);
  expect(current.result.warnings).toBeUndefined();
  expect(current.rows.map(({ symbol, session }) => [symbol, session])).toEqual([["META", "OPEN"], ["AAPL", "OPEN"]]);

  // META (a new company holds it) and AAPL (no change) serve their own bars and report, with nothing extra.
  const meta = await runHistory(["META"]);
  expect(meta.error).toBeNull();
  expect((meta.printed!.result.data as Array<{ close: number }>).map((row) => row.close)).toEqual([736.72]);
  expect(meta.printed!.result.warnings).toEqual(["Asked 1Y, data starts 2026-10-14 (first available bar)"]);
  expect((await runTicker("AAPL")).error).toBeNull();
  // A change lookup that fails is no note and no failure: the bars are served.
  const offline = await runHistory(["HFC"], source(async () => { throw new Error("fetch failed"); }));
  expect(offline.error).toBeNull();
  expect(offline.printed!.result.data).toHaveLength(1);
});
