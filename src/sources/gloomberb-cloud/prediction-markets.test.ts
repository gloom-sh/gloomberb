import { afterEach, expect, test } from "bun:test";
import { createTestTicker } from "../../test-support/ticker";
import { resolveTickerInstrumentKind } from "../../tickers/instrument-kind";
import { publicListingTarget } from "../listing-target";
import { AssetDataRouter } from "../provider-router";
import { GloomberbCloudProvider } from "./index";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// The three shapes a saved Kalshi market reaches the app in. The first read as
// symbol KALSHI on an exchange named after the market, which is what Gloom Cloud
// saw: `symbol=KALSHI&exchange=KXGREENLAND-29`.
const saved = [
  { symbol: "KALSHI:KXGREENLAND-29", exchange: "KALSHI" },
  { symbol: "KXGREENLAND-29", exchange: "KALSHI" },
  { symbol: "KALSHI", exchange: "KXGREENLAND-29" },
] as const;

test("a saved prediction market is named by its market id and never asked of Gloom Cloud", async () => {
  const requested: string[] = [];
  globalThis.fetch = (async (input: Request | string | URL) => {
    requested.push(String(input instanceof Request ? input.url : input));
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const router = new AssetDataRouter(null, [new GloomberbCloudProvider()]);
  router.setBackgroundRevalidation(false);

  for (const { symbol, exchange } of saved) {
    expect(publicListingTarget(symbol, exchange)).toEqual({ symbol: "KXGREENLAND-29", exchange: "KALSHI" });
    expect(resolveTickerInstrumentKind(createTestTicker(symbol, "Greenland", { exchange, assetCategory: "STK" }))).toBe("prediction");
    const answers = await Promise.allSettled([
      router.getQuote(symbol, exchange),
      router.getTickerFinancials(symbol, exchange),
      router.getPriceHistory(symbol, exchange, "1M"),
      router.getAnalystResearch(symbol, exchange),
      router.getOptionsChain(symbol, exchange),
      router.getHolders(symbol, exchange),
      router.getQuotesBatch([{ symbol, exchange }]).then((results) => {
        if (results[0]?.error) throw results[0].error;
      }),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual(Array(answers.length).fill("rejected"));
  }
  expect(requested).toEqual([]);
});
