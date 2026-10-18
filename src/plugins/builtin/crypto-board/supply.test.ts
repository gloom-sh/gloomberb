import { expect, test } from "bun:test";
import { buildCryptoRows, withCryptoSupply } from "./model";
import { stackedSupply, supplyByCode } from "./supply";
import { CRYPTO_FIXTURE_NOW, cryptoFixture, stablecoinSupplyFixture } from "./test-fixture";

test("the stack is the charted coins, then Other: the total less them, never below zero", () => {
  const stacked = stackedSupply(stablecoinSupplyFixture(), "ALL")!;
  expect(stacked.dates.map((date) => date.toISOString().slice(0, 10))).toEqual([
    "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23",
  ]);
  expect(stacked.layers.map((layer) => layer.id)).toEqual(["USDT", "USDC", "other"]);
  // A coin not yet issued adds nothing; a day without a total has no Other; a coin read above the total leaves Other at 0.
  expect(stacked.layers[2]!.values).toEqual([118e9, 48e9, null, 47e9, 0]);
});

test("a range counts back from the newest day with a total", () => {
  const payload = stablecoinSupplyFixture();
  const days = 400;
  payload.history = {
    start: "2025-08-01",
    // The newest day has not been read yet.
    total: [...Array.from({ length: days - 1 }, (_, index) => 1e9 + index), null],
    coins: [],
  };
  const span = (range: "1M" | "1Y" | "ALL") => {
    const dates = stackedSupply(payload, range)!.dates;
    return [dates.length, dates.at(-1)!.toISOString().slice(0, 10)];
  };
  expect(span("1M")).toEqual([31, "2026-09-03"]);
  expect(span("1Y")).toEqual([366, "2026-09-03"]);
  expect(span("ALL")).toEqual([399, "2026-09-03"]);
});

test("a stablecoin row takes the largest coin of its code, whatever its case, and keeps its identity across renders", () => {
  const payload = stablecoinSupplyFixture();
  payload.coins[0]!.symbol = "Usdt";
  payload.coins.push({ ...payload.coins[1]!, symbol: "USDT", name: "A smaller USDT", supply: 1e6 });
  const rows = buildCryptoRows(cryptoFixture().assets, "stablecoin", new Map(), CRYPTO_FIXTURE_NOW);
  const [usdt] = withCryptoSupply(rows, supplyByCode(payload));
  expect(usdt).toMatchObject({ code: "USDT", supply: 180e9, supply7dPercent: -0.33, supplyShare: 60, pegType: "peggedUSD", price: 0.9998 });
  expect(withCryptoSupply(rows, supplyByCode(payload))[0]).toBe(usdt);
});
