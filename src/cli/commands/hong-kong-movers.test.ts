import { expect, test } from "bun:test";
import type { KeptListing } from "../../tickers/search/listing-index";
import { hongKongMoverUniverse, inHongKongUniverse, rankHongKongMovers } from "./hong-kong-movers";

test("movers hk ranks the large HKEX stocks the app lists by the session's move, each its own way, and nothing else", () => {
  const listing = (symbol: string, exchange: string, type: string) => [symbol, `${symbol} Ltd`, exchange, type, "HKD", exchange, 1, null] as unknown as KeptListing;
  // Funds, other venues and a code search answered twice are not in the universe.
  expect(hongKongMoverUniverse([listing("0700", "HKEX", "Common Stock"), listing("2800", "HKEX", "ETF"), listing("7203", "JPX", "Common Stock"),
    listing("0700", "HKEX", "Common Stock"), listing("3690", "HKEX", "Common Stock")]).map((entry) => entry.code)).toEqual(["0700", "3690"]);
  // A penny stock search brought along, a stale or suspended quote, or one in another currency has no place in it.
  expect(inHongKongUniverse({ currency: "HKD", marketCap: 469e9 }, false)).toBe(true);
  expect(inHongKongUniverse({ currency: "HKD", marketCap: 29e6 }, false)).toBe(false);
  expect(inHongKongUniverse({ currency: "HKD", marketCap: 469e9 }, true)).toBe(false);
  expect(inHongKongUniverse({ currency: "USD", marketCap: 469e9 }, false)).toBe(false);
  const rows = [{ symbol: "3690", changePercent: -5.47 }, { symbol: "1171", changePercent: 4.76 }, { symbol: "0700", changePercent: 0 },
    { symbol: "2269", changePercent: 3.49 }, { symbol: "0005", changePercent: null }, { symbol: "0960", changePercent: -3.05 }];
  expect(rankHongKongMovers(rows, "gainers", 25).map((row) => row.symbol)).toEqual(["1171", "2269"]);
  expect(rankHongKongMovers(rows, "losers", 1).map((row) => row.symbol)).toEqual(["3690"]);
});
