import captured from "./markets.fixture.json";
import type { PerpBoardPayload, PerpBoardRow, PerpEquityListing, PerpHistoryPayload } from "../../../api-client/perps";
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
