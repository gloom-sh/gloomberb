import { expect, test } from "bun:test";
import { perpFreshness } from "./freshness";
import { freshnessLine } from "./status-line";
import { contractText, foldSmallMarkets, mergeVenueMarkets, venueMarketReadAt, venueMarketsFreshness, withPrimaryReading } from "./venue-markets";
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
  // A row names the contract it reads from, as the venue writes it, and how many more it stands for; a delisted one is gone.
  expect(markets.map(contractText)).toEqual(["BTCUSDT +2", "BTC", "BTC-USDT-SWAP +1", "BTC-PERPETUAL", "BTC-USD"]);
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
  expect(contractText(markets[0]!)).toBe("xyz:NVDA +2");
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

test("a venue's row is dated by its oldest figure, and the line under the rows never dates a venue newer than its row", () => {
  const at = (minute: string) => `2026-11-23T06:${minute}.000Z`;
  const interest = (url: string, observedAt: string) => ({ url, observedAt, asOf: observedAt, usdBasis: "mark" as const, usdParity: "USDT" });
  const markets = mergeVenueMarkets([
    // Binance's mark streams; its open interest is the last poll's, read from another endpoint.
    venueRow("binance", { observedAt: at("16:30"), openInterestUsd: 5_690e6, openInterestSource: interest("https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT", at("10:02")) }),
    // Bybit's inverse contract, read earlier in the pass, is counted in the venue's open interest.
    venueRow("bybit", { observedAt: at("16:05"), openInterestUsd: 4_190e6 }),
    venueRow("bybit", { marketId: "bybit:BTCUSD", symbol: "BTCUSD", observedAt: at("12:40"), openInterestUsd: 558e6 }),
    perpRow({ venue: "hyperliquid", observedAt: at("16:20"), openInterestUsd: 2_310e6 }),
  ]);
  expect(markets.map((market) => [market.venue, venueMarketReadAt(market)])).toEqual([
    ["binance", at("10:02")], ["bybit", at("12:40")], ["hyperliquid", at("16:20")]]);
  for (const market of markets) for (const contract of market.contracts) expect(Date.parse(venueMarketReadAt(market))).toBeLessThanOrEqual(Date.parse(contract.observedAt));

  const now = Date.parse(at("17:00"));
  const line = (streaming: readonly string[], list = markets) => freshnessLine(venueMarketsFreshness(list, { now, streaming: new Set(streaming) }), now).variants[0];
  expect(line([])).toBe("Binance 06:10 · Bybit 06:12 · Hyperliquid 06:16 UTC · oldest 6 min");
  // Live only while every figure on screen streams: Bybit's other contract is the last read, and Binance's streamed
  // mark sits beside the open interest its last poll read.
  const streamingAll = markets.map((market) => market.primary.marketId);
  expect(line(streamingAll)).not.toContain("live");
  expect(line(streamingAll, [markets[0]!, markets[2]!])).toBe("Binance 06:10 · Hyperliquid 06:16 UTC · oldest 6 min");
  expect(perpFreshness([markets[0]!.primary], { now, live: true }).status).toBeUndefined();
  // Hyperliquid's socket carries both: no open interest source, or one read with the mark, a few ms apart, is live.
  const hyperliquid = markets[2]!;
  const together = withPrimaryReading(hyperliquid, { ...hyperliquid.primary, openInterestSource: interest("https://api.hyperliquid.xyz/info", "2026-11-23T06:16:19.700Z") });
  for (const market of [hyperliquid, together]) {
    expect(line(streamingAll, [market])).toEndWith(" · live");
    expect(perpFreshness([market.primary], { now, live: true }).status).toBe("live");
  }
  // A streamed reading laid over the deepest contract moves the venue's open interest with it, and its read dates the row.
  const streamed = withPrimaryReading(markets[2]!, { ...markets[2]!.primary, observedAt: at("16:58"), openInterestUsd: 2_400e6 });
  expect([streamed.openInterestUsd, venueMarketReadAt(streamed)]).toEqual([2_400e6, at("16:58")]);
});
