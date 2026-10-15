import { afterEach, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "../../api-client";
import { marketDataCliCommands } from "../../cli/commands/market";
import { formatMarketPriceWithCurrency, liveQuoteFormatOptions } from "../../market-data/market/format";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { createDefaultConfig } from "../../types/config";
import { GloomberbCloudProvider } from "./index";

afterEach(() => {
  apiClient.dispose();
  setCloudApiFetchTransport(null);
});

const lastUpdated = Date.parse("2026-10-14T14:40:00Z");
/** The cloud quote rows as the server answered them on 2026-10-14: no price basis on any. */
const served: Record<string, Record<string, unknown>> = {
  "SXO=F": { symbol: "SXO=F", name: "E-Mini S&P Oil & Gas Exploration & Production Select Industry Dec 26", exchangeName: "CME", currency: "USD", instrumentType: "FUTURE", price: 7663, change: -59.5 },
  "SXOZ26.CME": { symbol: "SXOZ26.CME", name: "E-Mini S&P Oil & Gas Exploration & Production Select Industry Dec 26", exchangeName: "CME", currency: "USD", instrumentType: "FUTURE", price: 7663, change: -59.5 },
  "ES=F": { symbol: "ES=F", name: "E-Mini S&P 500 Dec 26", exchangeName: "CME", currency: "USD", instrumentType: "FUTURE", price: 7803.5, change: -52.25 },
  "MYM=F": { symbol: "MYM=F", name: "Micro E-Mini Dow Dec 26", exchangeName: "CBOT", currency: "USD", instrumentType: "FUTURE", price: 51947, change: -88 },
  "CL=F": { symbol: "CL=F", name: "WTI Crude Oil Dec 26", exchangeName: "NY Mercantile", currency: "USD", instrumentType: "FUTURE", price: 94.06, change: 0.89 },
  // Goldmoney and the aerospace ETF share the XAU and XAR codes with two sector futures.
  XAU: { symbol: "XAU", name: "Goldmoney Inc.", exchangeName: "TSX", currency: "CAD", instrumentType: "EQUITY", price: 13.05, change: 0 },
  XAR: { symbol: "XAR", name: "State Street SPDR S&P Aerospace & Defense ETF", exchangeName: "NYSEArca", currency: "USD", instrumentType: "ETF", price: 223.05, change: 0.18 },
};

test("an index future's continuous symbol and contract quote in points through the cloud quote path; namesakes keep their currency", async () => {
  apiClient.setSessionToken(null);
  setCloudApiFetchTransport((async (input: Request | string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/batch")) throw new Error("expected single quotes");
    const symbol = url.searchParams.get("symbol") ?? "";
    const row = served[symbol];
    return row
      ? Response.json({ status: "success", data: { ...row, providerId: "gloomberb-cloud", dataSource: "delayed", lastUpdated, changePercent: 0 } })
      : Response.json({ error: "not found" }, { status: 404 });
  }) as unknown as typeof fetch);
  const provider = new GloomberbCloudProvider();

  const quotes = await Promise.all(Object.keys(served).map((symbol) => provider.getQuote(symbol, "")));
  expect(Object.fromEntries(quotes.map((quote) => [quote.symbol, quote.priceBasis ?? null]))).toEqual({
    "SXO=F": "points", "SXOZ26.CME": "points", "ES=F": "points", "MYM=F": "points", "CL=F": null, XAU: null, XAR: null,
  });
  // The currency stays on the quote: a tick's dollar value is read from it.
  expect(quotes.every((quote) => quote.currency === served[quote.symbol]!.currency)).toBe(true);

  const price = (symbol: string) => {
    const quote = quotes.find((entry) => entry.symbol === symbol)!;
    return formatMarketPriceWithCurrency(quote.price, quote.currency, liveQuoteFormatOptions(quote, quote.currency));
  };
  expect(["SXO=F", "SXOZ26.CME", "ES=F", "CL=F", "XAU", "XAR"].map(price))
    .toEqual(["7,663.00", "7,663.00", "7,803.50", "$94.06", "CA$13.05", "$223.05"]);

  // The quote command prints what the shared formatter does, with no dollar sign on an index level.
  const cli = createTestCliContext({ config: createDefaultConfig("/tmp/gloom-futures-basis-test"), dataProvider: {
    getQuotesBatch: async (targets: Array<{ symbol: string; exchange?: string }>) =>
      targets.map((target) => ({ target: { symbol: target.symbol, exchange: "" }, quote: quotes.find((quote) => quote.symbol === target.symbol)! })),
  } });
  await marketDataCliCommands.find((command) => command.name === "quote")!.execute(["SXO=F", "ES=F", "XAU"], cli.context);
  const [{ result, options }] = cli.printed as [PrintedCliResult];
  const rows = options!.rows!(result.data) as Array<Record<string, unknown>>;
  expect(rows.map((row) => row.price)).toEqual(["7,663.00", "7,803.50", "CA$13.05"]);
});
