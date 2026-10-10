import { expect, test } from "bun:test";
import { createEmptyAnswerProvider, createNotFoundProvider, createTestDataProvider } from "../../test-support/data-provider";
import { createProviderMiss, providerMissReason } from "../provider-errors";
import { AssetDataRouter } from "./index";

const REASON = "Spot gold is not quoted; GC=F is the front-month future.";

test("a reason the provider gave replaces the generic no-provider wording on every route", async () => {
  const router = new AssetDataRouter(null, [createEmptyAnswerProvider(REASON)]);
  const failures = await Promise.all([
    router.getQuote("XAU/USD").catch((error) => error),
    router.getTickerFinancials("XAU/USD").catch((error) => error),
    router.getExchangeRate("XAU").catch((error) => error),
    router.getQuotesBatch([{ symbol: "XAU/USD", exchange: "" }]).then(([result]) => result!.error),
    router.getTickerFinancialsBatch([{ symbol: "XAU/USD", exchange: "" }]).then(([result]) => result!.error),
  ]);
  expect(failures.map((failure) => failure instanceof Error ? failure.message : failure)).toEqual(Array(5).fill(REASON));
  expect(providerMissReason(failures[0])).toBe(REASON);
  expect(providerMissReason(failures[2])).toBe(REASON);
});

test("without a reason the generic wording stays as it was", async () => {
  const router = new AssetDataRouter(null, [createEmptyAnswerProvider()]);
  await expect(router.getQuote("XAU/USD")).rejects.toThrow("No quote provider available for XAU/USD");
  await expect(router.getTickerFinancials("XAU/USD")).rejects.toThrow("No provider available for XAU/USD");
  await expect(router.getExchangeRate("XAU")).rejects.toThrow("No exchange rate provider available for XAU");
  expect((await router.getQuotesBatch([{ symbol: "XAU/USD", exchange: "" }]))[0]!.error).toBe("No quote provider available for XAU/USD");
});

test("a plain failure from another provider does not erase the reason one gave", async () => {
  const plain = createTestDataProvider({ id: "plain", priority: 2000, getQuote: () => Promise.reject(new Error("offline")) });
  const router = new AssetDataRouter(null, [createEmptyAnswerProvider(REASON), plain]);
  await expect(router.getQuote("XAU/USD")).rejects.toThrow(REASON);
});

test("a symbol no listing carries is not a ticker, on the quote, financials, batch and history routes", async () => {
  const router = new AssetDataRouter(null, [createNotFoundProvider()]);
  await expect(router.getQuote("APPLE")).rejects.toThrow("Not a ticker: APPLE.");
  await expect(router.getTickerFinancials("APPLE")).rejects.toThrow("Not a ticker: APPLE.");
  await expect(router.getPriceHistory("APPLE", "", "1Y")).rejects.toThrow("Not a ticker: APPLE.");
  expect((await router.getQuotesBatch([{ symbol: "APPLE", exchange: "" }]))[0]!.error).toBe("Not a ticker: APPLE.");
});

test("an outage keeps the outage wording, also when another source says the symbol is not found", async () => {
  const timesOut = createTestDataProvider({
    id: "slow", priority: 200,
    getQuote: () => Promise.reject(new Error("request timed out")),
    getTickerFinancials: () => Promise.reject(new Error("request timed out")),
    getPriceHistory: () => Promise.reject(new Error("request timed out")),
  });
  for (const sources of [[timesOut], [createNotFoundProvider(), timesOut]]) {
    const router = new AssetDataRouter(null, sources);
    await expect(router.getQuote("APPLE")).rejects.toThrow("No quote provider available for APPLE");
    await expect(router.getTickerFinancials("APPLE")).rejects.toThrow("No provider available for APPLE");
    await expect(router.getPriceHistory("APPLE", "", "1Y")).rejects.toThrow("No history provider available for APPLE");
  }
});

test("a service sentence about the symbol outranks the not-a-ticker wording", async () => {
  const router = new AssetDataRouter(null, [createNotFoundProvider({
    getQuote: () => Promise.reject(createProviderMiss("NOT_FOUND", REASON, { notFound: true })),
  })]);
  await expect(router.getQuote("XAU/USD")).rejects.toThrow(REASON);
});
