import captured from "./markets.fixture.json";
import type { PerpBoardPayload, PerpBoardRow, PerpEquityListing, PerpHistoryPayload, PerpLongShortPoint, PerpLongShortRatio, PerpRankingsPayload } from "../../../api-client/perps";
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
