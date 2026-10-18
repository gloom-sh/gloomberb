import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { fetchCryptoMarkets, validateCryptoMarkets, validateStablecoinSupply } from "./client";
import { cryptoFixture, stablecoinSupplyFixture } from "./test-fixture";

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

test("a malformed peg or 24h range is dropped from its coin alone, never the board", () => {
  const data = cryptoFixture();
  const usdt = data.assets.findIndex((asset) => asset.peg);
  const broken = structuredClone(data);
  (broken.assets[usdt]!.peg as { currency: string }).currency = "dollars";
  broken.assets[usdt]!.range24h!.lowAt = "not a time";
  const read = validateCryptoMarkets(broken);
  expect(read.assets).toHaveLength(data.assets.length);
  expect(read.assets[usdt]!.peg).toBeNull();
  expect(read.assets[usdt]!.range24h).toBeNull();
  expect(read.assets[usdt]!.price).toBe(data.assets[usdt]!.price);
  // The cached payload it came from is not changed.
  expect(broken.assets[usdt]!.range24h).not.toBeNull();
  const onlyRange = structuredClone(data);
  onlyRange.assets[usdt]!.range24h!.low = -1;
  expect(validateCryptoMarkets(onlyRange).assets[usdt]!.peg).toEqual(data.assets[usdt]!.peg);
  expect(validateCryptoMarkets(data)).toBe(data);
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

test("supply history must line every charted coin up with the total's days", () => {
  expect(validateStablecoinSupply(stablecoinSupplyFixture()).history!.total[2]).toBeNull();
  const mutations = [
    (copy: ReturnType<typeof stablecoinSupplyFixture>) => {
      copy.history!.coins[0]!.values.pop();
    },
    (copy: ReturnType<typeof stablecoinSupplyFixture>) => {
      copy.history!.total[0] = -1;
    },
    (copy: ReturnType<typeof stablecoinSupplyFixture>) => {
      (copy.coins[0] as { pegType: unknown }).pegType = null;
    },
  ];
  for (const mutate of mutations) {
    const copy = stablecoinSupplyFixture();
    mutate(copy);
    expect(() => validateStablecoinSupply(copy)).toThrow();
  }
});
