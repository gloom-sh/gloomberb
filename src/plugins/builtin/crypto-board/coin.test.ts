import { expect, test } from "bun:test";
import { createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { createTestTicker } from "../../../test-support/ticker";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { cryptoFixture } from "./test-fixture";
import { coinIdentityOf, findCoinAsset } from "./coin";

function context(symbol: string, exchange?: string, instrumentType?: string): { ticker: TickerRecord; financials: TickerFinancials | null } {
  return {
    ticker: createTestTicker(symbol, symbol, exchange ? { exchange } : {}),
    financials: instrumentType ? createTestFinancials({ quote: createTestQuote({ instrumentType }) }) : null,
  };
}

test("a coin pair names its coin, and a share shaped like a pair does not", () => {
  expect(coinIdentityOf(context("BTC-USD", "CCC"))).toEqual({ code: "BTC" });
  expect(coinIdentityOf(context("BTC-GBP", "CCC"))).toEqual({ code: "BTC" });
  // A pair the venue quotes no coin in belongs to no coin page.
  expect(coinIdentityOf(context("BTC-USDT", "BINANCE"))).toBeNull();
  // A slash pair on the crypto venue, as search offers it.
  expect(coinIdentityOf(context("ETH/USD", "CCC"))).toEqual({ code: "ETH" });
  // A bare ticker of a listed company stays that company: SOL is a stale Emeren Group.
  expect(coinIdentityOf(context("SOL", "NASDAQ"))).toBeNull();
  // A share class is a share, whatever its venue says.
  expect(coinIdentityOf(context("BRK-B", "NYSE"))).toBeNull();
});

test("the board row is found by code first, then by the name the board prints", () => {
  const assets = cryptoFixture().assets;
  const btc = assets.find((asset) => asset.code === "BTC")!;
  expect(findCoinAsset(assets, "BTC")).toBe(btc);
  // A coin whose listing name carries its quote currency still matches on the code.
  expect(findCoinAsset(assets, "USDT")?.code).toBe("USDT");
  // No code and no name on the board: nothing to read, never another coin's row.
  expect(findCoinAsset(assets, "NOPE")).toBeNull();
});
