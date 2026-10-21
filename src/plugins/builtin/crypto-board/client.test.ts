import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { fetchCryptoMarkets, validateCryptoMarkets, validateStablecoinSupply } from "./client";
import { CRYPTO_FIXTURE_NOW, cryptoFixture, stablecoinSupplyFixture } from "./test-fixture";

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

// Linear: GLO-1089. A board from a server before the coin day basis carried
// the screener's 24-hour change; CRYP and `quote` must both read since 00:00 UTC.
test("a board from before the since-00:00 UTC basis is moved from each coin's previous close, or not at all", () => {
  const legacy = cryptoFixture();
  delete legacy.dayChangeBasis;
  // BTC: closes run to yesterday, so its previous close is the 00:00 UTC price.
  legacy.assets[0]!.changePercent = 1.36;
  const read = validateCryptoMarkets(legacy, CRYPTO_FIXTURE_NOW);
  expect(read.assets[0]!.change).toBe(2);
  expect(read.assets[0]!.changePercent).toBeCloseTo(2.0408, 4);
  // HYPE: no daily closes date its previous close, which may be weeks old.
  expect(read.assets[1]).toMatchObject({ previousClose: null, change: null, changePercent: null });
  // Closes that stop four days back: the reported close is not today's base.
  const stale = cryptoFixture();
  delete stale.dayChangeBasis;
  stale.assets[0]!.history = { start: "2026-08-20", closes: Array.from({ length: 30 }, (_, index) => 70 + index) };
  expect(validateCryptoMarkets(stale, CRYPTO_FIXTURE_NOW).assets[0]!.changePercent).toBeNull();
  // A current server's board is read as sent.
  const current = cryptoFixture();
  expect(validateCryptoMarkets(current, CRYPTO_FIXTURE_NOW)).toBe(current);
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
