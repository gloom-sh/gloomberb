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
const closes: Record<string, number[]> = { AAPL: [339.5, 343.99, 348.22], MSFT: [520.1, 523.4, 521.9] };

async function runG(args: string[]) {
  const persistence = new AppPersistence(":memory:");
  const bars = (symbol: string) => days.map((day, index) => {
    const close = closes[symbol]![index]!;
    return { date: new Date(`${day}T00:00:00Z`), open: close, high: close, low: close, close, volume: 1000 };
  });
  const dataProvider = createTestDataProvider({
    getQuote: async (symbol) => createTestQuote({ symbol, currency: "USD", price: closes[symbol]!.at(-1)!, listingExchangeName: "NASDAQ", instrumentType: "Common Stock" }),
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
    expect(report.series.map((series) => series.label)).toEqual(["AAPL:XNAS Price", "MSFT:XNAS Price"]);
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
