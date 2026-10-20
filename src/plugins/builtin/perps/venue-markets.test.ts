import { expect, test } from "bun:test";
import { contractText, foldSmallMarkets, mergeVenueMarkets } from "./venue-markets";
import { perpRow, venueRow } from "./test-fixture";

// BTC across venues as the collectors read them (2026-10-19): Bybit and OKX each list it in several settlements.
const btc = [
  venueRow("bybit", { marketId: "bybit:BTCPERP", symbol: "BTCPERP", quoteCurrency: "USDC", openInterestUsd: 112e6, volume24hUsd: 36e6 }),
  venueRow("bybit", { marketId: "bybit:BTCUSDT", symbol: "BTCUSDT", openInterestUsd: 4_826e6, volume24hUsd: 3_841e6 }),
  venueRow("bybit", { marketId: "bybit:BTCUSD", symbol: "BTCUSD", quoteCurrency: "USD", contractType: "inverse", openInterestUsd: 558e6, volume24hUsd: 190e6 }),
  perpRow({ marketId: "hyperliquid:default:BTC", venue: "hyperliquid", dex: "default", openInterestUsd: 3_228e6, volume24hUsd: 1_892e6 }),
  venueRow("okx", { marketId: "okx:BTC-USDT-SWAP", symbol: "BTC-USDT-SWAP", openInterestUsd: 2_434e6, volume24hUsd: 5_259e6 }),
  venueRow("okx", { marketId: "okx:BTC-USD-SWAP", symbol: "BTC-USD-SWAP", quoteCurrency: "USD", contractType: "inverse", openInterestUsd: 598e6, volume24hUsd: 522e6 }),
  venueRow("deribit", { marketId: "deribit:BTC-PERPETUAL", symbol: "BTC-PERPETUAL", quoteCurrency: "USD", openInterestUsd: 40e6, volume24hUsd: 9e6 }),
  venueRow("dydx", { marketId: "dydx:BTC-USD", symbol: "BTC-USD", quoteCurrency: "USD", openInterestUsd: null, volume24hUsd: null }),
  venueRow("binance", { marketId: "binance:BTCUSDT", openInterestUsd: 9e6, volume24hUsd: 2e6, delisted: true }),
];

test("an asset's contracts merge into one row per venue, the deepest first, its open interest and volume the venue's whole", () => {
  const markets = mergeVenueMarkets(btc);
  expect(markets.map((market) => [market.venue, market.primary.marketId, market.contracts.length, market.openInterestUsd])).toEqual([
    ["bybit", "bybit:BTCUSDT", 3, 5_496e6],
    ["hyperliquid", "hyperliquid:default:BTC", 1, 3_228e6],
    ["okx", "okx:BTC-USDT-SWAP", 2, 3_032e6],
    ["deribit", "deribit:BTC-PERPETUAL", 1, 40e6],
    // No open interest stated: last, and its total stays unknown rather than zero.
    ["dydx", "dydx:BTC-USD", 1, null],
  ]);
  // A row names the contract it reads from and how many more it stands for; a delisted one is gone.
  expect(markets.map(contractText)).toEqual(["USDT +2", "USDC", "USDT +1", "USD", "USD"]);
});

test("Hyperliquid's builder dexes listing one stock are one Hyperliquid row, and a market read twice is one contract", () => {
  const nvda = (dex: string, openInterestUsd: number, patch = {}) => perpRow({ marketId: `hyperliquid:${dex}:NVDA`, venue: "hyperliquid", dex, symbol: `${dex}:NVDA`,
    baseAsset: "NVDA", openInterestUsd, volume24hUsd: openInterestUsd, ...patch });
  const markets = mergeVenueMarkets([
    nvda("xyz", 110e6),
    nvda("km", 2e6),
    nvda("flx", 1e6),
    // The same market again, answered in another case and read later: the later reading stands.
    nvda("FLX", 1.5e6, { marketId: "hyperliquid:FLX:NVDA", observedAt: "2099-01-01T00:00:00.000Z" }),
    venueRow("bybit", { marketId: "bybit:NVDAUSDT", symbol: "NVDAUSDT", baseAsset: "NVDA", openInterestUsd: 17e6, volume24hUsd: 15e6 }),
  ]);
  expect(markets.map((market) => [market.venue, market.primary.marketId, market.contracts.map((row) => row.marketId)])).toEqual([
    ["hyperliquid", "hyperliquid:xyz:NVDA", ["hyperliquid:xyz:NVDA", "hyperliquid:km:NVDA", "hyperliquid:FLX:NVDA"]],
    ["bybit", "bybit:NVDAUSDT", ["bybit:NVDAUSDT"]],
  ]);
  expect(markets[0]!.openInterestUsd).toBe(113.5e6);
  expect(contractText(markets[0]!)).toBe("xyz +2");
});

test("markets with a small share of the open interest fold behind more, and the deepest always shows", () => {
  const markets = mergeVenueMarkets(btc);
  const { shown, folded } = foldSmallMarkets(markets);
  // Deribit holds under 1% of BTC's open interest across venues; dYdX states none.
  expect(shown.map((market) => market.venue)).toEqual(["bybit", "hyperliquid", "okx"]);
  expect(folded.map((market) => market.venue)).toEqual(["deribit", "dydx"]);
  expect(foldSmallMarkets(markets, { maxShown: 2 }).shown.map((market) => market.venue)).toEqual(["bybit", "hyperliquid"]);
  // One tiny market is still the asset's market.
  const lone = mergeVenueMarkets([venueRow("deribit", { marketId: "deribit:BTC-PERPETUAL", openInterestUsd: 1_000 })]);
  expect(foldSmallMarkets(lone).shown).toHaveLength(1);
  // When no venue states open interest, nothing is small: volume orders them and the first four show.
  const unknown = mergeVenueMarkets(btc.map((row) => ({ ...row, openInterestUsd: null })));
  expect(foldSmallMarkets(unknown).shown.map((market) => market.venue)).toEqual(["okx", "bybit", "hyperliquid", "deribit"]);
});
