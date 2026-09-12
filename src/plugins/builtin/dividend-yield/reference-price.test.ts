import { afterEach, expect, test } from "bun:test";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import type { HeadlessPaneContext } from "../../../types/plugin";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { fetchDividendData } from "./client";
import { createDividendYieldHeadless, projectDividendYieldHeadless } from "./headless";
import { fetchProviderDividendData } from "./provider-client";

afterEach(() => setHttpFetchTransport(null));

function chartFixture() {
  const timestamp = Math.floor(Date.now() / 1000);
  const meta = { currency: "USD", exchangeName: "NMS", regularMarketPrice: 100,
    regularMarketTime: timestamp, dataGranularity: "1mo" };
  setHttpFetchTransport(async (url) => {
    if (url.includes("fc.yahoo.com")) return new Response("", { headers: { "set-cookie": "test=fixture" } });
    if (url.includes("getcrumb")) return new Response("fixture");
    if (url.includes("/chart/")) return Response.json({ chart: { result: [{ meta, timestamp: [timestamp],
      indicators: { quote: [{ close: [100] }] },
      events: { dividends: { cash: { date: timestamp - 86_400, amount: 4 } } },
    }] } });
    return Response.json({ quoteSummary: { result: [] } });
  });
  return meta;
}

test("dividend price/time selection stays paired through native and headless fallback", async () => {
  const meta = chartFixture();
  const chartAsOf = new Date(meta.regularMarketTime * 1000).toISOString();
  const fallback = await fetchDividendData("FUND", 250, "NASDAQ", "EUR");
  expect(fallback).toMatchObject({ price: 100, priceAsOf: chartAsOf, priceStale: false });
  expect(fallback.metrics.trailingYield).toBe(0.04);

  const supplied = await fetchDividendData("FUND", 250, "NASDAQ", "USD");
  expect(supplied.price).toBe(250);
  expect(supplied.priceAsOf).toBeUndefined(); // Its caller owns the separate quote timestamp.
  const quoteTime = meta.regularMarketTime * 1000 - 1_000;
  for (const currency of ["USD", "EUR"]) {
    const result = await createDividendYieldHeadless().load({ argument: "FUND", symbols: ["FUND"], options: {} }, {
      resolveInstrument: async () => ({ symbol: "FUND", exchange: "NASDAQ" }),
      marketData: { getQuote: async () => ({ symbol: "FUND", price: 250, currency,
        lastUpdated: quoteTime, stale: true, change: 0, changePercent: 0 }) },
    } as unknown as HeadlessPaneContext);
    expect(result.metadata?.priceAsOf).toBe(currency === "USD" ? new Date(quoteTime).toISOString() : chartAsOf);
    expect(result.metadata?.priceStale).toBe(currency === "USD");
    expect(result.sections[0]?.entries?.find((row) => row.label === "Trailing yield")?.value).toBe(currency === "USD" ? 0.016 : 0.04);
  }
});

test("old, missing and recovered Yahoo times do not alter the cash numerator or borrow fetch time", async () => {
  const meta = chartFixture();
  const fresh = meta.regularMarketTime;
  for (const timestamp of [fresh - 10 * 86_400, undefined, 0, NaN, Infinity, 1e20, fresh + 86_400, fresh]) {
    meta.regularMarketTime = timestamp as number;
    const data = await fetchDividendData("FUND", null);
    const result = projectDividendYieldHeadless(data, { argument: "FUND", symbols: ["FUND"], options: {} });
    expect(data.metrics.trailingRate).toBe(4);
    expect(data.metrics.trailingYield).toBe(0.04);
    const status = result.sections[0]?.entries?.find((row) => row.label === "Price status")?.value;
    if (timestamp === fresh) {
      expect(data.priceAsOf).toBe(new Date(fresh * 1000).toISOString());
      expect(data.priceStale).toBe(false);
      expect(status).toBeUndefined();
    } else if (timestamp === fresh - 10 * 86_400) {
      expect(data.priceStale).toBe(true);
      expect(status).toContain("Stale reference price");
    } else {
      expect(data.priceAsOf).toBeUndefined();
      expect(data.priceStale).toBeUndefined();
      expect(result.metadata?.priceAsOf).toBeNull();
      expect(status).toContain("time unavailable");
    }
  }
});

test("provider quote metadata handles missing dates without losing valid cash or borrowing an unused quote time", async () => {
  let quoteTime = NaN;
  const provider = createTestDataProvider({
    getCorporateActions: async () => ({ symbol: "FUND", currency: "USD", coverage: { dividends: "available" },
      dividends: [{ exDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), amount: 4 }], splits: [], earnings: [] }),
    getQuote: async () => ({ symbol: "FUND", currency: "USD", price: 80, lastUpdated: quoteTime, change: 0, changePercent: 0 }),
  });
  for (const timestamp of [NaN, 1e20, Date.now() + 86_400_000, Date.now()]) {
    quoteTime = timestamp;
    const data = await fetchProviderDividendData(provider, "FUND", null);
    expect(data.metrics.trailingYield).toBe(0.05);
    expect(data.priceAsOf).toBe(Number.isFinite(new Date(timestamp).getTime()) && timestamp <= Date.now() ? new Date(timestamp).toISOString() : undefined);
  }
  const supplied = await fetchProviderDividendData(provider, "FUND", 200, "", "USD");
  expect(supplied.price).toBe(200);
  expect(supplied.priceAsOf).toBeUndefined();
});

test("a future external quote time cannot make a dividend yield look fresh or borrow chart time", async () => {
  const meta = chartFixture();
  let quoteTime = Date.now() + 86_400_000;
  const load = () => createDividendYieldHeadless().load({ argument: "FUND", symbols: ["FUND"], options: {} }, {
    resolveInstrument: async () => ({ symbol: "FUND", exchange: "NASDAQ" }),
    marketData: { getQuote: async () => ({ symbol: "FUND", price: 200, currency: "USD",
      lastUpdated: quoteTime, exchangeName: "NASDAQ", marketState: "CLOSED", stale: false, change: 0, changePercent: 0 }) },
  } as unknown as HeadlessPaneContext);
  const future = await load();
  expect(future.metadata?.priceAsOf).toBeNull();
  expect(future.metadata?.priceStale).toBeNull();
  expect(future.sections[0]?.entries?.find((row) => row.label === "Trailing yield")?.value).toBe(0.02);
  expect(future.sections[0]?.entries?.find((row) => row.label === "Price status")?.value).toContain("time unavailable");
  quoteTime = meta.regularMarketTime * 1000 - 1_000;
  const recovered = await load();
  expect(recovered.metadata?.priceAsOf).toBe(new Date(quoteTime).toISOString());
  expect(recovered.metadata?.priceStale).toBe(false);
  expect(recovered.sections[0]?.entries?.find((row) => row.label === "Price status")).toBeUndefined();
});
