import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { fetchCryptoMarkets, validateCryptoMarkets } from "./client";
import { cryptoFixture } from "./test-fixture";

test("the Cloud boundary accepts missing history and rejects malformed assets", () => {
  const data = cryptoFixture();
  data.assets[0]!.history!.closes[3] = null;
  expect(validateCryptoMarkets(data).assets[0]!.history!.closes[3]).toBeNull();
  const mutations = [
    (copy: typeof data) => {
      copy.assets[0]!.price = 0;
    },
    (copy: typeof data) => {
      copy.assets[0]!.symbol = "BTC/USD";
    },
    (copy: typeof data) => {
      (copy.assets[0] as { kind: string }).kind = "token";
    },
    (copy: typeof data) => {
      copy.assets[0]!.history!.start = "2026-02-30";
    },
    (copy: typeof data) => {
      copy.assets[0]!.history!.closes[0] = -1;
    },
    (copy: typeof data) => {
      copy.assets[1]!.symbol = copy.assets[0]!.symbol;
    },
    (copy: typeof data) => {
      (copy as { version: number }).version = 2;
    },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(data);
    mutate(copy);
    expect(() => validateCryptoMarkets(copy)).toThrow();
  }
});

test("an absent or failing endpoint has a concise error", async () => {
  await expect(fetchCryptoMarkets({
    getCloudCryptoMarkets: async () => {
      throw new ApiRequestError("Not found", 404);
    },
  })).rejects.toThrow("not available");
  await expect(fetchCryptoMarkets({
    getCloudCryptoMarkets: async () => {
      throw new ApiRequestError("Unavailable", 503);
    },
  })).rejects.toThrow("temporarily unavailable");
});
