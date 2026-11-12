import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import type { CloudQuotePayload } from "../../api-client/types/quotes";
import { marketDataCliCommands } from "../../cli/commands/market";
import { serializeCliResult } from "../../cli/result";
import { DEFAULT_CLI_OPTIONS } from "../../cli/options";
import { AppPersistence } from "../../data/app-persistence";
import { createTestCliContext } from "../../test-support/cli-context";
import { AssetDataRouter } from "../provider-router";
import { GloomberbCloudProvider } from "./index";

// 11 Nov 2026, 18:40 UTC: TTEK's quote was 19 minutes behind on a 15-minute feed, and every read of it, the
// service's copy it could not refresh included, said it had just been fetched: a stalled feed read as a live one.
const originals = { getCloudQuote: apiClient.getCloudQuote, getCloudQuotesBatch: apiClient.getCloudQuotesBatch };
afterEach(() => Object.assign(apiClient, originals));

const now = Date.parse("2026-11-11T18:40:00Z");
const fetchedByService = Date.parse("2026-11-11T18:22:00Z");
const lastTrade = Date.parse("2026-11-11T18:21:00Z");
const quoteCommand = marketDataCliCommands.find((command) => command.name === "quote")!;

function payload(symbol: string, retrievedAt?: number): CloudQuotePayload {
  return {
    symbol, name: `${symbol} Inc.`, price: 37.76, currency: "USD", change: -2.89, changePercent: -7.1, previousClose: 40.65,
    lastUpdated: lastTrade, lastTradeTime: lastTrade, marketState: "REGULAR", sessionConfidence: "derived",
    listingExchangeName: "NASDAQ", exchangeName: "NASDAQ", instrumentType: "Common Stock",
    providerId: "gloomberb-cloud", dataSource: "delayed", ...(retrievedAt ? { retrievedAt } : {}),
  };
}

test("a quote the service kept says when the service fetched it, in quote --json and on the batch path", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const store = new AppPersistence(":memory:");
  // The service's expired copy of TTEK, flagged stale, and a fresh quote of AAPL it fetched just now.
  apiClient.getCloudQuotesBatch = async (requests) => ({ status: "success", data: { items: requests.map((request) => ({
    ...request, exchange: request.exchange ?? "", status: "success" as const,
    ...(request.symbol === "TTEK" ? { stale: true, data: payload("TTEK", fetchedByService) } : { data: payload("AAPL") }),
  })) } });
  apiClient.getCloudQuote = async (symbol) => ({ status: "success", stale: true, data: payload(symbol, fetchedByService) });
  try {
    const router = new AssetDataRouter(new GloomberbCloudProvider(), [], store.resources);
    const batch = await router.getQuotesBatch([{ symbol: "TTEK", exchange: "NASDAQ" }, { symbol: "AAPL", exchange: "NASDAQ" }]);
    const quotes = Object.fromEntries(batch.map((result) => [result.target.symbol, result.quote]));
    expect(quotes.TTEK).toMatchObject({ stale: true, retrievedAt: fetchedByService });
    // A quote the service sends with no fetch time of its own is dated by this read.
    expect(quotes.AAPL?.retrievedAt).toBe(now);

    const cli = createTestCliContext({ dataProvider: new AssetDataRouter(new GloomberbCloudProvider(), [], store.resources) },
      { format: "json" });
    await quoteCommand.execute(["TTEK:NASDAQ"], cli.context);
    const [{ result, options }] = cli.printed;
    const printed = JSON.parse(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "json" }, options)) as
      { data: Array<{ quote: Record<string, unknown> }> };
    expect(printed.data[0]!.quote).toMatchObject({ retrievedAt: fetchedByService, lastTradeTime: lastTrade, stale: true });
  } finally {
    store.close();
    clock.mockRestore();
  }
});
