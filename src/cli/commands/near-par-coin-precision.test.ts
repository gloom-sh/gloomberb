import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import { createTestCliContext } from "../../test-support/cli-context";
import { createTestQuote } from "../../test-support/data-provider";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { marketDataCliCommands } from "./market";
import { buildTickerReport } from "./ticker";

const config = createDefaultConfig("/tmp/gloom-near-par-unused");
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u00a0/g, " ").replace(/ {2,}/g, " ");
const coin = { instrumentType: "CRYPTOCURRENCY", marketState: "REGULAR", listingExchangeName: "CCC", exchangeName: "CCC", currency: "USD" } as const;

/**
 * `quote USDT-USD` printed $0.9989 where `ticker` printed $0.99886, and Bond USD0 read $0.9762 against
 * $0.97619265. A coin near a dollar prints to four decimals in both, as CRYP prints it; a sub-cent coin keeps its eight.
 */
test("quote and ticker print a coin near a dollar to the same four decimals, and a sub-cent coin to its own", async () => {
  const quotes = [
    createTestQuote({ ...coin, symbol: "USDT-USD", name: "Tether USDt", price: 0.99886, previousClose: 0.9983, change: 0.00056, changePercent: 0.06,
      open: 0.99838, low: 0.99822, high: 0.99891 }),
    createTestQuote({ ...coin, symbol: "BUSD0-USD", name: "Bond USD0", price: 0.97619265, previousClose: 0.9759, change: 0.0003, changePercent: 0.03 }),
    createTestQuote({ ...coin, symbol: "SHIB-USD", name: "Shiba Inu", price: 0.00001234, previousClose: 0.0000122, change: 0.00000014, changePercent: 1.15 }),
  ];
  const cli = createTestCliContext({ dataProvider: {
    getQuotesBatch: async () => quotes.map((quote) => ({ target: { symbol: quote.symbol, exchange: "" }, quote })),
  } });
  await marketDataCliCommands.find((command) => command.name === "quote")!.execute(quotes.map((quote) => quote.symbol), cli.context);
  const { result, options } = cli.printed[0]!;
  const table = plain(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, width: 200 }, options));
  const reports = await Promise.all(quotes.map(async (quote) => plain(await buildTickerReport({
    symbol: quote.symbol, tickerFile: null, config, toBase: async (value) => value,
    financials: { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] },
  }))));
  for (const [index, last] of ["$0.9989", "$0.9762", "$0.00001234"].entries()) {
    expect(table).toContain(` ${last} `);
    expect(reports[index]).toContain(`Last ${last}\n`);
  }
  expect(reports[0]).toContain("Open $0.9984\n");
  expect(reports[0]).toContain("Day Range $0.9982 - $0.9989\n");
});
