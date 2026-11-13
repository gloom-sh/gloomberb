import { expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { TickerRepository } from "../../data/ticker-repository";
import { getLoadablePlugins } from "../../plugins/catalog";
import { runPaneFunction } from "../pane-functions";
import { createDefaultConfig } from "../../types/config";
import { createTestCliContext } from "../../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { captureConsole } from "../../test-support/console";

const config = createDefaultConfig("/tmp/gloom-fn-chart-list-fixture");
const days = ["2026-10-20", "2026-10-21", "2026-10-22"];
const closes: Record<string, number[]> = {
  AAPL: [339.5, 343.99, 348.22], MSFT: [520.1, 523.4, 521.9], VOD: [1.15, 1.16, 1.17], MC: [401.2, 403.1, 404.5], LN: [61, 61.2, 61.1],
  SAN: [93.1, 93.8, 94.2], "SAN.PA": [93.1, 93.8, 94.2],
};
/** Where each symbol lists: VOD on the LSE (its NASDAQ receipt aside), MC on Euronext Paris, SAN (Santander's receipt) on NYSE. */
const venues: Record<string, string> = { AAPL: "NASDAQ", MSFT: "NASDAQ", VOD: "LSE", MC: "EPA", LN: "NYSE", SAN: "NYSE", "SAN.PA": "EPA" };

async function runG(args: string[]) {
  const persistence = new AppPersistence(":memory:");
  const bars = (symbol: string) => days.map((day, index) => {
    const close = closes[symbol]![index]!;
    return { date: new Date(`${day}T00:00:00Z`), open: close, high: close, low: close, close, volume: 1000 };
  });
  const dataProvider = createTestDataProvider({
    search: async (query) => venues[query.toUpperCase()]
      ? [{ providerId: "test", symbol: query.toUpperCase(), name: query, exchange: venues[query.toUpperCase()]!, type: "Common Stock" }] : [],
    getQuote: async (symbol, exchange) => createTestQuote({
      symbol, currency: "USD", price: closes[symbol]!.at(-1)!, listingExchangeName: exchange || venues[symbol] || "NASDAQ", instrumentType: "Common Stock",
    }),
    getPriceHistoryWithMetadata: async (symbol) => ({ resolution: "1d", points: bars(symbol) }),
    getPriceHistory: async (symbol) => bars(symbol),
    getPriceHistoryForResolution: async (symbol) => bars(symbol),
    getDetailedPriceHistory: async (symbol) => bars(symbol),
  });
  const cli = createTestCliContext({ config, dataProvider, persistence, store: new TickerRepository(persistence.tickers) });
  (cli.context as { plugins?: unknown }).plugins = getLoadablePlugins();
  try {
    const { result: error } = await captureConsole(() => runPaneFunction(args, cli.context).then(() => null, (failure: unknown) => failure));
    return { error: error as Error | null, printed: cli.printed[0] };
  } finally {
    persistence.close();
  }
}

test("fn G AAPL MSFT charts both, as fn G AAPL,MSFT does", async () => {
  const spaced = await runG(["G", "AAPL", "MSFT"]);
  const comma = await runG(["G", "AAPL,MSFT"]);
  for (const { error, printed } of [spaced, comma]) {
    expect(error).toBeNull();
    const report = printed!.result.data as { symbols: string[]; series: Array<{ label: string; points: unknown[] }>; unavailableSymbols: string[] };
    expect(report.symbols).toEqual(["AAPL:XNAS", "MSFT:XNAS"]);
    expect(report.series.map((series) => series.label)).toEqual(["AAPL:NASDAQ Price", "MSFT:NASDAQ Price"]);
    expect(report.series.every((series) => series.points.length > 0)).toBe(true);
    expect(report.unavailableSymbols).toEqual([]);
  }
});

test("fn G of words that are one thing says what to write, and charts neither word", async () => {
  const messages = new Map<string, string | undefined>();
  for (const words of [["AAPL", "US", "Equity"], ["EUR", "USD"], ["AAPL", "MSFT:net", "income"], ["AAPL", "MSFT:revenu"]]) {
    const { error, printed } = await runG(["G", ...words]);
    expect(printed).toBeUndefined();
    messages.set(words.join(" "), error?.message.split(" Use SYMBOL")[0]);
  }
  expect([...messages]).toEqual([
    ["AAPL US Equity", 'Invalid chart series "AAPL US Equity". That is a Bloomberg code: write it AAPL.'],
    ["EUR USD", 'Invalid chart series "EUR USD". EUR USD reads as a currency pair: write it EUR/USD, or separate tickers with commas.'],
    ["AAPL MSFT:net income", 'Invalid chart series "AAPL MSFT:net income".'],
    ["AAPL MSFT:revenu", 'Invalid chart series "AAPL MSFT:revenu". Separate series with commas: AAPL,MSFT:revenu.'],
  ]);
});

/**
 * 13 Nov 2026: `fn G "VOD LN" --csv` charted VOD on NASDAQ in USD and LN, a ticker that stopped trading in 2020,
 * where HP, GP and history read the quoted code as Vodafone in London.
 */
test("fn G reads a quoted terminal code as its listing, as HP and history do, and words typed apart as a series each", async () => {
  const charted = async (args: string[]) => {
    const { error, printed } = await runG(args);
    expect(error).toBeNull();
    const report = printed!.result.data as { series: Array<{ label: string }> };
    return { labels: report.series.map((series) => series.label), warnings: printed!.result.warnings ?? [] };
  };
  expect(await charted(["G", "VOD LN"])).toEqual({ labels: ["VOD:LSE Price"], warnings: ['Read "VOD LN" as VOD:LSE.'] });
  expect((await charted(["G", "MC FP Equity"])).labels).toEqual(["MC:EPA Price"]);
  expect((await charted(["G", "VOD LN, MC FP"])).labels).toEqual(["VOD:LSE Price", "MC:EPA Price"]);
  // A qualified symbol is read as written, and tickers typed apart are a comparison.
  expect((await charted(["G", "VOD:LSE"])).labels).toEqual(["VOD:LSE Price"]);
  expect((await charted(["G", "AAPL", "MSFT"])).labels).toEqual(["AAPL:NASDAQ Price", "MSFT:NASDAQ Price"]);
});

/** Review of the G fix: it must not take GP and the other chart functions off the listing reading every ticker gets. */
test("fn GP reads its ticker's listing as quote does: SAN --exchange EPA and SAN.PA are Sanofi in Paris", async () => {
  for (const args of [["GP", "SAN", "--exchange", "EPA"], ["GP", "SAN.PA"]]) {
    const { error, printed } = await runG(args);
    expect(error).toBeNull();
    expect((printed!.result.data as { series: Array<{ label: string }> }).series.map((series) => series.label)).toEqual(["SAN:EPA Price", "Volume"]);
  }
});
