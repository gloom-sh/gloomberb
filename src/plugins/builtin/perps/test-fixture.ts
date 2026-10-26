import captured from "./markets.fixture.json";
import type { PerpBoardPayload, PerpBoardRow, PerpDepthPayload, PerpDepthRow, PerpEquitiesPayload, PerpLiquidationsPayload, PerpEquityListing, PerpHistoryPayload, PerpLongShortPoint, PerpLongShortRatio,
  PerpRankingsPayload } from "../../../api-client/perps";
/** Public API capture: 2026-10-03, prices and interval units kept verbatim. */
export const perpRow = (patch: Partial<PerpBoardRow> = {}): PerpBoardRow => ({ ...captured[0] as PerpBoardRow, ...patch });
export const perpBoard = (patch: Partial<PerpBoardPayload> = {}): PerpBoardPayload => ({ status: "ok", asOf: captured[0]!.observedAt, rows: captured as PerpBoardRow[], total: captured.length, locked: 0, access: "pro", ...patch });
export const perpHistory = (patch: Partial<PerpHistoryPayload> = {}): PerpHistoryPayload => ({ status: "collecting", marketId: perpRow().marketId, rows: [], funding: [], candles: [], locked: false, access: "pro", asOf: perpRow().observedAt, ...patch });

/** Controlled identity envelope; the legacy capture above has no listing proof. */
export function equityBoard(listing: PerpEquityListing, patch: Partial<PerpBoardPayload> = {}): PerpBoardPayload {
  return perpBoard({ listing, total: 1, rows: [perpRow({ marketId: `hyperliquid:xyz:${listing.symbol}`, dex: "xyz",
    symbol: listing.symbol, baseAsset: listing.symbol, assetClass: "stocks", underlyingSymbol: listing.symbol,
    equityMatch: { listing, underlying: listing, basis: "listing" } })], ...patch });
}

/** A list's batch answer: each listing's contract (as `equityBoard` builds it) where `hasPerp` says so, none elsewhere. */
export function equitiesPayload(listings: readonly PerpEquityListing[], hasPerp: (listing: PerpEquityListing) => boolean,
  market: Partial<PerpBoardRow> = {}): PerpEquitiesPayload {
  return { status: "ok", asOf: perpRow().observedAt, access: "pro", locked: 0, results: listings.map((listing) => ({ listing,
    market: hasPerp(listing) ? { ...equityBoard(listing).rows[0]!, ...market } : null })) };
}

/** The captured BTC contract as another venue lists it: same base asset, the venue's own identity and symbol. */
export const venueRow = (venue: PerpBoardRow["venue"], patch: Partial<PerpBoardRow> = {}): PerpBoardRow =>
  perpRow({ venue, dex: "", marketId: `${venue}:${patch.symbol ?? "BTCUSDT"}`, symbol: "BTCUSDT", quoteCurrency: "USDT", marginCurrency: "USDT", fundingIntervalHours: 8, ...patch });
export const perpRankings = (patch: Partial<PerpRankingsPayload> = {}): PerpRankingsPayload => ({ status: "ok", asOf: perpRow().observedAt, access: "pro", locked: false,
  fundingPositive: [], fundingNegative: [], oiSurges: [], premiumDislocations: [], closedMarketDislocations: [], ...patch });

/** The long/short contract's example readings (2026-10-09 11:26Z collection): Binance publishes shares, OKX only the ratio. */
export const longShort = (patch: Partial<PerpLongShortRatio> = {}): PerpLongShortRatio => ({ venue: "binance", definition: "accounts_all",
  definitionText: "Share of all accounts on this contract that are net long vs net short", period: "1h", longShare: 0.6183, shortShare: 0.3817, ratio: 1.6199,
  derived: false, bucketAt: "2026-10-09T11:00:00.000Z", observedAt: "2026-10-09T11:26:35.480Z", stale: false, ...patch });
export const okxLongShort = longShort({ venue: "okx", longShare: 0.6797877802498716, shortShare: 0.32021221975012837, ratio: 2.1229289150187065, derived: true,
  observedAt: "2026-10-09T11:26:30.897Z" });
export const longShortPoint = (time: string, longShare: number, patch: Partial<PerpLongShortPoint> = {}): PerpLongShortPoint => ({ time, definition: "accounts_all",
  longShare, shortShare: 1 - longShare, ratio: longShare / (1 - longShare), derived: false, observedAt: time, ...patch });

export const cascadeAsOf = "2026-10-26T07:20:00.000Z";
const liquidationMarket = (venue: string, symbol: string, patch: Partial<PerpLiquidationsPayload["markets"][number]> = {}) => ({ marketId: `${venue}:${symbol}`, venue, symbol, dex: venue === "hyperliquid" ? "default" : "",
  quoteCurrency: "USDT", long24h: 0, short24h: 0, long7d: 0, short7d: 0, count24h: 0, count7d: 0, lastEventAt: null, ...patch });
export const liquidationPrint = (patch: Partial<PerpLiquidationsPayload["largest"][number]> = {}) => ({ marketId: "binance:ETHUSDC", venue: "binance", symbol: "ETHUSDC", dex: "", side: "short" as const,
  priceKind: "fill" as const, price: 2321.94, quantity: 13.774, notionalUsd: 31_982.4, eventAt: "2026-10-26T07:00:49.159Z", receivedAt: "2026-10-26T07:00:50.295Z", ...patch });
/** Liquidations of ETH as the smoke API served them on 2026-10-26, trimmed. */
export const liquidationsPayload = (patch: Partial<PerpLiquidationsPayload> = {}): PerpLiquidationsPayload => ({
  status: "ok", baseAsset: "ETH", asOf: cascadeAsOf, from: "2026-10-19T07:20:00.000Z", collectingSince: "2026-10-26T06:52:41.387Z",
  markets: [liquidationMarket("binance", "ETHUSDT", { long24h: 3_100, short24h: 29_200, long7d: 3_100, short7d: 29_200, count24h: 10, count7d: 10, lastEventAt: "2026-10-26T07:10:00.000Z" }),
    liquidationMarket("okx", "ETH-USDT-SWAP", { long24h: 81.09, long7d: 81.09, count24h: 1, count7d: 1, lastEventAt: "2026-10-26T06:55:00.000Z" }), liquidationMarket("hyperliquid", "ETH", { quoteCurrency: "USDC" })],
  totals: { long24h: 3_181.09, short24h: 29_200, long7d: 3_181.09, short7d: 29_200, count24h: 11, count7d: 11 },
  hourly: [], largest: [liquidationPrint()],
  streams: [{ venue: "binance", state: "live", lastOkAt: cascadeAsOf, error: null }, { venue: "okx", state: "down", lastOkAt: "2026-10-26T07:01:00.000Z", error: "socket closed" }],
  notes: ["Binance sends at most one liquidation per contract each second (the latest), so a burst on one contract is undercounted."],
  locked: true, access: "preview", ...patch,
});
export const depthRow = (patch: Partial<PerpDepthRow> = {}): PerpDepthRow => ({ marketId: "binance:ETHUSDT", venue: "binance", symbol: "ETHUSDT", dex: "", quoteCurrency: "USDT",
  bucket: "2026-10-26T06:00:00.000Z", observedAt: "2026-10-26T06:52:25.285Z", sourceAsOf: "2026-10-26T06:52:25.134Z", mid: 2318.375,
  bid05: 57_576_999.5, ask05: 66_745_130.3, bid1: 57_576_999.5, ask1: 66_745_130.3, bid2: 57_576_999.5, ask2: 66_745_130.3,
  bidReach: 0.0047, askReach: 0.0048, levels: 1000, grouping: null, stale: false, ...patch });
/** Order book depth of ETH as read on 2026-10-26, trimmed. */
export const depthPayload = (patch: Partial<PerpDepthPayload> = {}): PerpDepthPayload => ({ status: "ok", baseAsset: "ETH", asOf: cascadeAsOf,
  rows: [depthRow(), depthRow({ marketId: "okx:ETH-USDT-SWAP", venue: "okx", symbol: "ETH-USDT-SWAP", observedAt: "2026-10-26T06:54:16.000Z",
    bid05: 33_920_000, ask05: 35_420_000, bid1: 45_610_000, ask1: 47_940_000, bid2: 98_650_000, ask2: 70_640_000, bidReach: 0.0223, askReach: 0.0224 })],
  history: [], sources: [{ venue: "binance", lastOkAt: cascadeAsOf, error: null }], notes: ["Binance and Bybit return the nearest 1,000 price levels a side and OKX 5,000."],
  locked: true, access: "preview", ...patch });
