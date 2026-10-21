import { afterEach, expect, test } from "bun:test";
import type { QuoteBatchResult, QuoteSubscriptionTarget } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { marketDataCliCommands } from "./market";

const quoteCommand = marketDataCliCommands.find((command) => command.name === "quote")!;

// A quote that finds nothing sets the exit status; it must not become the test run's.
afterEach(() => { process.exitCode = 0; });

const stuttgart = (symbol: string): Quote => createTestQuote({
  symbol, name: "MIXI, Inc.", currency: "EUR", price: 22, listingExchangeName: "FWB2", exchangeName: "FWB2", instrumentType: "EQUITY",
});

/** Gloom Cloud for a bare code that only a listing abroad carries (MXN, EUR), and for one US ticker. */
async function quoteWarnings(args: string[]): Promise<string[]> {
  const quoted: Record<string, Quote> = {
    MXN: stuttgart("MXN"),
    EUR: { ...stuttgart("EUR"), name: "Euro Tech AG" },
    "MXN:FWB2": stuttgart("MXN:FWB2"),
    USD: createTestQuote({ symbol: "USD", name: "ProShares Ultra Semiconductors", listingExchangeName: "NYSE ARCA", exchangeName: "NYSE ARCA", instrumentType: "ETF" }),
    AAPL: createTestQuote({ symbol: "AAPL", name: "Apple Inc.", listingExchangeName: "NASDAQ", exchangeName: "NASDAQ", instrumentType: "EQUITY" }),
  };
  const cli = createTestCliContext({
    dataProvider: createTestDataProvider({
      getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => targets.map((target) => (
        quoted[target.symbol] ? { target, quote: quoted[target.symbol]! } : { target, quote: null, error: `Not a ticker: ${target.symbol}.` }
      )),
    }),
  });
  await quoteCommand.execute(args, cli.context);
  return ((cli.printed[0] as PrintedCliResult).result.warnings ?? []) as string[];
}

test("a three-letter currency code that quotes a listing abroad still quotes it, with a line naming the currency and how to ask for it", async () => {
  expect(await quoteWarnings(["MXN"])).toContain("MXN is also a currency: fx MXN, quote USD/MXN");
  // The pair is quoted the way markets quote it: euros in dollars, pesos by the dollar.
  expect(await quoteWarnings(["EUR"])).toContain("EUR is also a currency: fx EUR, quote EUR/USD");
});

test("the currency line is for a bare code read on a listing abroad, never for a named venue, a US listing or the dollar", async () => {
  const currency = (warnings: string[]) => warnings.filter((warning) => warning.includes("is also a currency"));
  expect(currency(await quoteWarnings(["MXN:FWB2"]))).toEqual([]);
  expect(currency(await quoteWarnings(["MXN", "--exchange", "FWB2"]))).toEqual([]);
  // A fund trades as USD on a US venue, and there is no USD/USD to quote.
  expect(currency(await quoteWarnings(["USD"]))).toEqual([]);
  expect(currency(await quoteWarnings(["AAPL"]))).toEqual([]);
});
