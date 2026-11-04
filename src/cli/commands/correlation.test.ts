import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { TickerRepository } from "../../data/ticker-repository";
import { createDefaultConfig } from "../../types/config";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../test-support/data-provider";
import { captureConsole } from "../../test-support/console";
import { overviewCliCommands } from "./overview";

const correlation = overviewCliCommands.find((command) => command.name === "correlation")!;
const config = createDefaultConfig("/tmp/gloom-correlation-fixture");

afterEach(() => { process.exitCode = 0; });

// RIOT is the miner; the bare BTC is the Grayscale fund, as the data service answers it, and BTC-USD the coin.
const QUOTES: Record<string, ReturnType<typeof createTestQuote>> = {
  RIOT: createTestQuote({ symbol: "RIOT", name: "Riot Platforms, Inc.", currency: "USD", instrumentType: "EQUITY", listingExchangeName: "NASDAQ" }),
  BTC: createTestQuote({ symbol: "BTC", name: "Grayscale Bitcoin Mini Trust ETF", currency: "USD", instrumentType: "ETF", listingExchangeName: "ARCA" }),
  "BTC-USD": createTestQuote({ symbol: "BTC-USD", name: "Bitcoin USD", currency: "USD", instrumentType: "CRYPTOCURRENCY", listingExchangeName: "CCC" }),
  "ETH-USD": createTestQuote({ symbol: "ETH-USD", name: "Ethereum USD", currency: "USD", instrumentType: "CRYPTOCURRENCY", listingExchangeName: "CCC" }),
  3046: createTestQuote({ symbol: "3046", name: "Samsung Ethereum Futures Active ETF", currency: "HKD", instrumentType: "ETF", listingExchangeName: "HKEX" }),
};
const bars = (drift: number) => Array.from({ length: 30 }, (_, day) => {
  const close = 30 + day * drift + (day % 3);
  return { date: new Date(Date.UTC(2026, 9, 1 + day)), open: close, high: close, low: close, close, volume: 1_000 };
});

async function run(args: string[], history?: (symbol: string) => ReturnType<typeof bars>) {
  const quoteOf = (symbol: string) => {
    const quote = QUOTES[symbol.toUpperCase()];
    if (!quote) throw new Error(`Not a ticker: ${symbol}.`);
    return quote;
  };
  const dataProvider = createTestDataProvider({
    search: async (query) => {
      const quote = QUOTES[query.trim().toUpperCase()];
      return quote ? [{ providerId: "test", symbol: quote.symbol, name: quote.name!, exchange: quote.listingExchangeName!, type: quote.instrumentType!, currency: "USD" }] : [];
    },
    getQuote: async (symbol) => quoteOf(symbol),
    getTickerFinancials: async (symbol) => createTestFinancials({ quote: quoteOf(symbol), priceHistory: bars(1) }),
    getPriceHistory: async (symbol) => history?.(symbol.toUpperCase()) ?? bars(symbol.toUpperCase() === "RIOT" ? 0.5 : 1),
  });
  const persistence = new AppPersistence(":memory:");
  const cli = createTestCliContext({ config, dataProvider, persistence, store: new TickerRepository(persistence.tickers) });
  try {
    await captureConsole(() => correlation.execute(args, cli.context));
    return cli.printed[0] as PrintedCliResult;
  } finally {
    persistence.close();
  }
}

test("correlation with the bare BTC says it read the Grayscale fund and names the coin's pair, as quote does", async () => {
  const fund = await run(["RIOT", "BTC"]);
  expect(fund.result.warnings).toEqual(["BTC is Grayscale Bitcoin Mini Trust ETF, not bitcoin. For bitcoin use BTC-USD."]);
  // The coin's pair, and a listing named on its exchange, are what was asked: no coin note.
  const coinNote = (warnings: string[] | undefined) => (warnings ?? []).filter((line) => line.includes("For bitcoin use"));
  expect(coinNote((await run(["RIOT", "BTC-USD"])).result.warnings)).toEqual([]);
  expect(coinNote((await run(["RIOT", "BTC:ARCA"])).result.warnings)).toEqual([]);
});

test("an HK ETF with a few contradictory bars correlates against its coin over the bars history keeps, and a side with none says so", async () => {
  // ETH trades every day; the HK counter on weekdays, with two bars whose high sits under the open, as the source sent 3046's.
  const eth = Array.from({ length: 60 }, (_, day) => {
    const close = 2_000 + 40 * Math.sin(day / 3) + day;
    return { date: new Date(Date.UTC(2026, 8, 1 + day)), open: close, high: close, low: close, close, volume: 1_000 };
  });
  const hk = eth.filter((bar) => bar.date.getUTCDay() % 6 !== 0).map((bar, index) => {
    const close = bar.close / 380;
    return index === 5 || index === 20 ? { ...bar, open: close + 0.1, high: close, low: close, close } : { ...bar, open: close, high: close, low: close, close };
  });
  const result = await run(["ETH-USD", "3046:HKEX"], (symbol) => symbol.startsWith("3046") ? hk : eth);
  const row = (result.result.data as Array<{ correlation: number | null; samples: number }>)[0]!;
  expect(row.correlation).toBeCloseTo(1);
  // 44 weekdays less the two contradictory bars leaves 42 closes and 41 returns.
  expect(row.samples).toBe(41);
  expect(result.result.warnings).toContain("3046:HKEX: 2 of 44 bars have contradictory prices in the source data; left out, as history leaves them blank");
  const empty = await run(["ETH-USD", "3046:HKEX"], (symbol) => symbol.startsWith("3046") ? [] : eth);
  expect((empty.result.data as Array<{ correlation: number | null }>)[0]!.correlation).toBeNull();
  expect(empty.result.warnings).toContain("3046:HKEX has no daily bars in the 1Y range");
});
