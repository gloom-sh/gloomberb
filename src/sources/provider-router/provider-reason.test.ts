import { expect, test } from "bun:test";
import { createEmptyAnswerProvider, createTestDataProvider } from "../../test-support/data-provider";
import { providerMissReason } from "../provider-errors";
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
