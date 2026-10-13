import { expect, spyOn, test } from "bun:test";
import type { Quote } from "../../types/financials";
import type { InstrumentSearchResult } from "../../types/instrument";
import type { QuoteBatchResult, QuoteSubscriptionTarget } from "../../types/data-provider";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { createTestDataProvider } from "../../test-support/data-provider";
import { currencyPairSpelling } from "../../utils/currency-pair";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { printCliResult } from "../result";
import { setCliColorEnabledOverride } from "../../utils/cli-output";
import { marketDataCliCommands } from "./market";

const quoteCommand = marketDataCliCommands.find((command) => command.name === "quote")!;

const at = (iso: string) => Date.parse(iso);

// Monday 12 Oct 2026 in the evening, the FX week open: what the service holds for each pair's own listing.
const listed: Record<string, Quote> = {
  "USDNGN=X": {
    symbol: "USDNGN=X", name: "USD/NGN", currency: "NGN", price: 1322.87, change: -5.52, changePercent: -0.4155,
    previousClose: 1328.39, marketState: "REGULAR", listingExchangeName: "CCY", exchangeName: "CCY",
    instrumentType: "CURRENCY", dataSource: "delayed", providerId: "gloomberb-cloud", stale: false, lastUpdated: at("2026-10-12T22:38:00Z"),
  },
  "EURUSD=X": {
    symbol: "EURUSD=X", name: "EUR/USD", currency: "USD", price: 1.11594, change: 0.00121, changePercent: 0.1085,
    previousClose: 1.11473, marketState: "REGULAR", listingExchangeName: "CCY", exchangeName: "CCY",
    instrumentType: "CURRENCY", dataSource: "delayed", providerId: "gloomberb-cloud", stale: false, lastUpdated: at("2026-10-12T22:48:00Z"),
  },
  "USDJPY=X": {
    symbol: "USDJPY=X", name: "USD/JPY", currency: "JPY", price: 158.574, change: 0.401, changePercent: 0.2535,
    previousClose: 158.173, marketState: "REGULAR", listingExchangeName: "CCY", exchangeName: "CCY",
    instrumentType: "CURRENCY", dataSource: "delayed", providerId: "gloomberb-cloud", stale: false, lastUpdated: at("2026-10-12T22:47:00Z"),
  },
};

/**
 * A quote service that, like the real one, keeps an answer per spelling it is
 * asked by: another spelling of a pair gets its own copy, read as CLOSED, with
 * no change and an older time, as `quote USDNGN=X usd/ngn` showed. It lists
 * each pair once, on the currency venue (search reads USD_NGN as the pair
 * too), and the coin MNT-USD under its own letters.
 */
function pairSource() {
  const asked: string[] = [];
  const otherSpelling = (symbol: string): Quote | null => {
    const pair = currencyPairSpelling(symbol, "CCY");
    const quote = pair ? listed[pair.symbol] : undefined;
    return quote ? { ...quote, change: 0, changePercent: 0, marketState: "CLOSED", lastUpdated: quote.lastUpdated - 2 * 60_000 } : null;
  };
  const coin: Quote = {
    symbol: "MNT-USD", name: "microNFT USD", currency: "USD", price: 0.00018727, change: 0, changePercent: 0,
    marketState: "REGULAR", listingExchangeName: "CCC", lastUpdated: at("2026-10-12T22:40:00Z"),
  };
  const dataProvider = createTestDataProvider({
    search: async (query: string): Promise<InstrumentSearchResult[]> => {
      const text = query.trim().toUpperCase().replace("_", "/");
      if (text === "MNT-USD") return [{ providerId: "test", symbol: "MNT-USD", name: "microNFT USD", exchange: "CCC", type: "CRYPTOCURRENCY" }];
      const pair = currencyPairSpelling(text) ?? currencyPairSpelling(text, "CCY");
      const quote = pair ? listed[pair.symbol] : undefined;
      return quote ? [{ providerId: "test", symbol: quote.symbol, name: quote.name!, exchange: "CCY", type: "CURRENCY", currency: quote.currency }] : [];
    },
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => targets.map((target) => {
      asked.push(target.symbol);
      const quote = listed[target.symbol] ?? (target.symbol === "MNT-USD" ? coin : otherSpelling(target.symbol));
      return quote ? { target, quote } : { target, quote: null, error: `Not a ticker: ${target.symbol}.` };
    }),
  });
  return { dataProvider, asked };
}

async function quoteRows(args: string[]) {
  const source = pairSource();
  const cli = createTestCliContext({ dataProvider: source.dataProvider });
  await quoteCommand.execute(args, cli.context);
  const [printed] = cli.printed as [PrintedCliResult];
  return {
    rows: printed.options!.rows!(printed.result.data) as Array<Record<string, unknown>>,
    data: printed.result.data as Array<{ error: string | null }>,
    printed,
    asked: source.asked,
  };
}

test("every spelling of a pair quotes the same listing, so its rows are the same row", async () => {
  // Case is no spelling of its own: a symbol typed twice in two cases is one row (`normalizeSymbols`).
  const spellings: Record<string, string[]> = {
    "USDNGN=X": ["USDNGN=X", "usd/ngn", "USD-NGN", "usdngn", "NGN=X", "USDNGN:CCY"],
    "EURUSD=X": ["EURUSD=X", "EUR/USD", "eur-usd", "eurusd", "EURUSD:FX"],
    "USDJPY=X": ["USDJPY=X", "jpy=x", "USD/JPY", "usd-jpy", "usdjpy"],
  };
  for (const [pair, typed] of Object.entries(spellings)) {
    const { rows, asked } = await quoteRows(typed);
    // One request, for the pair's own listing, whatever was typed.
    expect(new Set(asked), pair).toEqual(new Set([pair]));
    expect(rows, pair).toHaveLength(typed.length);
    for (const [index, row] of rows.entries()) expect(row, `${typed[index]} as ${pair}`).toEqual(rows[0]!);
    const first = rows[0]!;
    expect([first.symbol, first.session, first.rawPrice, first.updatedAt], pair)
      .toEqual([pair, "OPEN", listed[pair]!.price, new Date(listed[pair]!.lastUpdated).toISOString()]);
    expect(first.changePercent).toBe(Math.round(listed[pair]!.changePercent * 100) / 100);
  }
});

test("a listing under the same letters keeps them: MNT-USD is the coin", async () => {
  const { rows, asked } = await quoteRows(["MNT-USD", "BTC-USD", "usd-ngn"]);
  expect(asked).toEqual(["MNT-USD", "BTC-USD", "USDNGN=X"]);
  expect(rows.map((row) => row.symbol)).toEqual(["MNT-USD", "BTC-USD", "USDNGN=X"]);
});

test("a pair-like miss names the listing search finds nearest, and nothing when search finds none", async () => {
  // USD_NGN is no spelling of a pair, but search lists the pair for it, as it does on the service.
  const { data, rows, printed, asked } = await quoteRows(["usd_ngn", "USD/XYZ"]);
  expect(asked).toEqual(["USD_NGN", "USD/XYZ"]);
  expect(data.map((row) => row.error)).toEqual(["Not a ticker: USD_NGN. Did you mean USDNGN=X (USD/NGN)?", "Not a ticker: USD/XYZ."]);
  expect(rows.map((row) => row.price)).toEqual(["", ""]);
  // In text the row still reads "not a ticker", and only the miss without a pair gets the search hint.
  const spy = spyOn(console, "error").mockImplementation(() => {});
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    setCliColorEnabledOverride(false);
    printCliResult(printed.result, DEFAULT_CLI_OPTIONS, printed.options, ["usd_ngn", "USD/XYZ"]);
    const table = String(write.mock.calls[0]?.[0]);
    expect(table.match(/not a ticker/g)).toHaveLength(2);
    expect(spy.mock.calls.map((call) => String(call[0]))).toEqual([
      "warning: Not a ticker: USD_NGN. Did you mean USDNGN=X (USD/NGN)?",
      "warning: Not a ticker: USD/XYZ. Try `gloomberb search USD/XYZ`.",
    ]);
  } finally {
    spy.mockRestore();
    write.mockRestore();
    setCliColorEnabledOverride(null);
  }
});
