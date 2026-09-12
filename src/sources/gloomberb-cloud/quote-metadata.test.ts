import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient, type CloudQuotePayload } from "../../api-client";
import { createGloomberbCloudProvider } from "./index";

let quoteSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { quoteSpy?.mockRestore(); quoteSpy = undefined; });

test("static quote metadata preserves source facts while stale prices remain rejected", async () => {
  const raw: CloudQuotePayload = { symbol: "EURUSD=X", listingExchangeName: "CCY", currency: "USD", instrumentType: "CURRENCY",
    price: 1.1602274179458618, change: -0.001077882, changePercent: -0.0928, lastUpdated: Date.parse("2026-09-11T21:29Z"),
    receivedAt: Date.parse("2026-09-12T03:48Z"), stale: true };
  quoteSpy = spyOn(apiClient, "getCloudQuote").mockResolvedValue({ status: "success", data: raw, stale: true });
  const provider = createGloomberbCloudProvider();
  await expect(provider.getQuote("EURUSD=X")).rejects.toThrow("stale");
  expect(await provider.getQuoteMetadata!("EURUSD=X")).toEqual({ symbol: "EURUSD=X", listingExchangeName: "CCY", currency: "USD", instrumentType: "CURRENCY",
    source: { providerId: "gloomberb-cloud", lastUpdated: raw.lastUpdated, stale: true, provenance: undefined } });
  expect(raw.price).toBe(1.1602274179458618);
  raw.lastUpdated = NaN;
  expect((await provider.getQuoteMetadata!("EURUSD=X"))?.source.lastUpdated).toBeUndefined();
});

test("metadata validates the requested listing and preserves normalized minor units without price fields", async () => {
  const provider = createGloomberbCloudProvider();
  quoteSpy = spyOn(apiClient, "getCloudQuote");
  for (const [ticker, exchange, symbol, listing, currency, accepted] of [
    ["ASML:XAMS", "NASDAQ", "ASML", "XAMS", "EUR", true],
    ["ASML", "AMS", "ASML", "NASDAQ", "USD", false],
    ["ASML", "AMS", "ASML", "", "EUR", false],
    ["CL=F", "NYMEX", "CL=F", "NY MERCANTILE", "USD", true],
    ["CL=F", "COMEX", "CL=F", "NY MERCANTILE", "USD", false],
    ["ASML", "AMS", "ASML:XNAS", "AMS", "EUR", false],
    ["ASML", "AMS", "OTHER", "AMS", "EUR", false],
    ["VOD:XLON", "NASDAQ", "VOD.L", "LSE", "GBp", true],
    ["9988", "HKEX", "9988.HK", "HKG", "HKD", true],
    ["BTC-USD", "CCC", "BTC-USD", "CCC", "USD", true],
  ] as const) {
    quoteSpy.mockResolvedValue({ status: "success", stale: false, providerMeta: { stale: true },
      data: { symbol, listingExchangeName: listing, currency, instrumentType: "EQUITY", price: 123, change: 0, changePercent: 0, lastUpdated: 1234 } });
    const result = await provider.getQuoteMetadata!(ticker, exchange);
    expect(result !== null).toBe(accepted);
    if (result) {
      expect(result.currency).toBe(currency === "GBp" ? "GBP" : currency);
      expect(result.source).toMatchObject({ lastUpdated: 1234, stale: true });
      expect(Object.keys(result).sort()).toEqual(["currency", "instrumentType", "listingExchangeName", "source", "symbol"]);
      expect("price" in result || "receivedAt" in result.source).toBe(false);
    }
  }
  quoteSpy.mockResolvedValue({ status: "unsupported", data: null });
  await expect(provider.getQuoteMetadata!("UNKNOWN")).rejects.toThrow();
});
