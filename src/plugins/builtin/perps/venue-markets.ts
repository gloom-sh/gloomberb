import type { PerpBoardRow } from "../../../api-client/perps";
import { venueName } from "./model";

/**
 * An asset's perpetual markets as DES lists them: one row per venue.
 *
 * A venue often lists one asset several times: Bybit's BTC settles in USDT,
 * in USDC and inversely in BTC, and on Hyperliquid each builder dex (xyz, flx,
 * km...) deploys its own NVDA. Listed contract by contract they read as the
 * same line over and over, so each venue's contracts are one market here: the
 * deepest contract gives the row its mark, funding and premium, and the open
 * interest and volume are the venue's whole. A row reached twice (the same
 * market id in two cases, or answered by two reads) is one contract.
 */
export interface PerpVenueMarket {
  /** `hyperliquid:BTC`: the venue and the asset, whatever the contract. */
  key: string;
  venue: string;
  /** The deepest contract, which a click opens. */
  primary: PerpBoardRow;
  /** Every contract on the venue, deepest first; the primary is the first. */
  contracts: PerpBoardRow[];
  /** Open interest across the contracts, in USD; null when no contract states it. */
  openInterestUsd: number | null;
  volume24hUsd: number | null;
}

const sumOrNull = (values: Array<number | null | undefined>) => {
  const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
};
const depth = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value : -1;
const deeper = (a: { openInterestUsd: number | null; volume24hUsd: number | null }, b: typeof a) =>
  depth(b.openInterestUsd) - depth(a.openInterestUsd) || depth(b.volume24hUsd) - depth(a.volume24hUsd);

/** Rows merged into one row per venue and asset, the deepest first (open interest, then volume). Delisted contracts are left out. */
export function mergeVenueMarkets(rows: readonly PerpBoardRow[]): PerpVenueMarket[] {
  const contracts = new Map<string, PerpBoardRow>();
  for (const row of rows) {
    if (row.delisted) continue;
    const id = row.marketId.toLowerCase();
    const seen = contracts.get(id);
    if (!seen || Date.parse(row.observedAt) > Date.parse(seen.observedAt)) contracts.set(id, row);
  }
  const venues = new Map<string, PerpBoardRow[]>();
  for (const row of contracts.values()) {
    const key = `${row.venue}:${row.baseAsset.toUpperCase()}`;
    venues.set(key, [...venues.get(key) ?? [], row]);
  }
  return [...venues].map(([key, group]): PerpVenueMarket => {
    const sorted = [...group].sort((a, b) => deeper(a, b) || a.marketId.localeCompare(b.marketId));
    return {
      key,
      venue: sorted[0]!.venue,
      primary: sorted[0]!,
      contracts: sorted,
      openInterestUsd: sumOrNull(sorted.map((row) => row.openInterestUsd)),
      volume24hUsd: sumOrNull(sorted.map((row) => row.volume24hUsd)),
    };
  }).sort((a, b) => deeper(a, b) || venueName(a.venue).localeCompare(venueName(b.venue)) || a.key.localeCompare(b.key));
}

/** A market under this share of the asset's open interest is folded behind "more". */
const SMALL_MARKET_SHARE = 0.02;

/**
 * The markets shown and those folded behind "more": a market holding less than
 * `minShare` of the asset's open interest across venues, or past `maxShown`,
 * is folded. The deepest market always shows, and one with no open interest
 * stated shows only while no market states any.
 */
export function foldSmallMarkets(markets: readonly PerpVenueMarket[], { minShare = SMALL_MARKET_SHARE, maxShown = 4 }: { minShare?: number; maxShown?: number } = {}): {
  shown: PerpVenueMarket[]; folded: PerpVenueMarket[];
} {
  const total = sumOrNull(markets.map((market) => market.openInterestUsd));
  const shown: PerpVenueMarket[] = [];
  const folded: PerpVenueMarket[] = [];
  for (const market of markets) {
    const share = total && market.openInterestUsd != null ? market.openInterestUsd / total : total ? 0 : 1;
    if (shown.length === 0 || (shown.length < maxShown && share >= minShare)) shown.push(market);
    else folded.push(market);
  }
  return { shown, folded };
}

/**
 * The contract a venue's row reads from, as the venue settles it (`USDT`, `USD inverse`, a Hyperliquid builder dex
 * such as `xyz`), and how many more it stands for: `USDT +2`.
 */
export function contractText(market: PerpVenueMarket): string {
  const row = market.primary;
  const own = row.venue === "hyperliquid" && row.dex && row.dex !== "default" ? row.dex
    : row.contractType === "inverse" ? `${row.quoteCurrency} inverse` : row.quoteCurrency;
  const others = market.contracts.length - 1;
  return others > 0 ? `${own} +${others}` : own;
}
