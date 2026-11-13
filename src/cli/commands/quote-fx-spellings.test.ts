import { afterEach, expect, spyOn, test } from "bun:test";
import type { Quote } from "../../types/financials";
import type { InstrumentSearchResult } from "../../types/instrument";
import type { QuoteBatchResult, QuoteSubscriptionTarget } from "../../types/data-provider";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { createTestDataProvider } from "../../test-support/data-provider";
import { currencyPairSpelling } from "../../utils/currency-pair";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { printCliResult, serializeCliResult } from "../result";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCliColorEnabledOverride } from "../../utils/cli-output";
import { marketDataCliCommands } from "./market";

// A quote that finds nothing sets the exit status; it must not become the test run's.
afterEach(() => { process.exitCode = 0; });

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
    // Each names the entry it was typed as, and the first one it repeats.
    const quoted = ({ input: _input, duplicateOf: _duplicateOf, ...row }: Record<string, unknown>) => row;
    for (const [index, row] of rows.entries()) expect(quoted(row), `${typed[index]} as ${pair}`).toEqual(quoted(rows[0]!));
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
      "warning: Not a ticker: USD/XYZ. Try `gloom search USD/XYZ`.",
    ]);
  } finally {
    spy.mockRestore();
    write.mockRestore();
    setCliColorEnabledOverride(null);
  }
});

/**
 * 13 Nov 2026: eight pasted lines exported five rows. BRK-B had none, BRK.B and BRK/B read two symbols with no
 * duplicate mark, and N/A and the blank line had none (a warning only), so the export no longer lined up with the sheet.
 */
test("a pasted list's export has a row for every line up to the last, a blank or non-symbol line too, and one Symbol per share class", async () => {
  const stock = (symbol: string, name: string, price: number): Quote => ({
    symbol, name, currency: "USD", price, change: 1, changePercent: 0.2, previousClose: price - 1, marketState: "REGULAR",
    listingExchangeName: "NYSE", exchangeName: "NYSE", instrumentType: "EQUITY", dataSource: "delayed", providerId: "gloomberb-cloud",
    stale: false, lastUpdated: at("2026-10-12T19:00:00Z"),
  });
  const quotes: Record<string, Quote> = {
    "BRK.B": stock("BRK.B", "Berkshire Hathaway Inc.", 589.83), "BRK-B": stock("BRK-B", "Berkshire Hathaway Inc.", 589.83),
    MSFT: stock("MSFT", "Microsoft Corporation", 523),
  };
  const dataProvider = createTestDataProvider({
    search: async () => [],
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => targets.map((target) => {
      const quote = quotes[target.symbol];
      return quote ? { target, quote } : { target, quote: null, error: `Not a ticker: ${target.symbol}.` };
    }),
  });
  const stdin = spyOn(Bun.stdin, "text").mockResolvedValue("BRK.B\nBRK-B\nBRK/B\nN/A\n\nMSFT\n\n");
  try {
    const cli = createTestCliContext({ dataProvider }, { format: "csv" });
    await quoteCommand.execute(["--file", "-"], cli.context);
    const [printed] = cli.printed as [PrintedCliResult];
    const csv = serializeCliResult(printed.result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, printed.options).split("\n");
    const head = csv[0]!.split(",");
    const rows = csv.slice(1).map((line) => line.split(",")).filter((row) => row.length === head.length)
      .map((row) => ["Symbol", "input", "duplicate_of", "status"].map((column) => row[head.indexOf(column)]));
    expect(rows).toEqual([
      ["BRK.B", "BRK.B", "", ""],
      ["BRK.B", "BRK-B", "BRK.B", ""],
      ["BRK.B", "BRK/B", "BRK.B", ""],
      ["N/A", "N/A", "", "not a symbol"],
      ["", "", "", "blank line"],
      ["MSFT", "MSFT", "", ""],
    ]);
  } finally {
    stdin.mockRestore();
  }
});

test("a list's export has a row for every line as typed, in its order, each repeat of a listing marked", async () => {
  // A sheet's column pasted as a file: four lines that are all USD/JPY, and a code no listing is read from between them.
  const dir = mkdtempSync(join(tmpdir(), "quote-input-"));
  const file = join(dir, "symbols.txt");
  writeFileSync(file, ["USDJPY Curncy", "ＵＳＤＪＰＹ", "GTJPY10Y Govt", "usdjpy", "USD/JPY", "EURUSD=X", "USDJPY Curncy"].join("\n"));
  try {
    const source = pairSource();
    const cli = createTestCliContext({ dataProvider: source.dataProvider }, { format: "csv" });
    await quoteCommand.execute(["--file", file], cli.context);
    const [printed] = cli.printed as [PrintedCliResult];
    const csv = serializeCliResult(printed.result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, printed.options).split("\n");
    const head = csv[0]!.split(",");
    const cells = (line: string) => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const rows = csv.slice(1, 9).filter((line) => cells(line).length === head.length).map((line) => {
      const row = cells(line);
      return [row[head.indexOf("Symbol")], row[head.indexOf("input")], row[head.indexOf("duplicate_of")], row[head.indexOf("status")]!.slice(0, 15)];
    });
    expect(rows).toEqual([
      ["USDJPY=X", "USDJPY Curncy", "", ""],
      ["USDJPY=X", "ＵＳＤＪＰＹ", "USDJPY Curncy", ""],
      ["GTJPY10Y Govt", "GTJPY10Y Govt", "", "\"GTJPY10Y Govt "],
      ["USDJPY=X", "usdjpy", "USDJPY Curncy", ""],
      ["USDJPY=X", "USD/JPY", "USDJPY Curncy", ""],
      ["EURUSD=X", "EURUSD=X", "", ""],
      // The exact repeat keeps its own row, as every line does.
      ["USDJPY=X", "USDJPY Curncy", "USDJPY Curncy", ""],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
