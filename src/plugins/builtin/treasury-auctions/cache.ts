import { createPluginCache, savedCopyForTransientFailure } from "../../../data/plugin-cache";
import { servedFromSavedCopy } from "../../../data/saved-copies";
import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import type { PluginPersistence } from "../../../types/plugin";
import {
  AUCTION_ARCHIVE_PAGE_SIZE, AUCTION_HISTORY_ALL, AUCTION_HISTORY_DAYS, AUCTION_HISTORY_START, auctionArchiveBoundary,
  auctionWindowQuery, fetchTreasuryAuctions, type AuctionHistoryWindow, type AuctionQuery,
} from "./client";
import type { TreasuryAuction } from "./types";

const CACHE_KIND = "treasury-auctions";
const CACHE_SOURCE = "treasury-fiscal-data";
/**
 * 3: every reported page was validated before this board was cached.
 * 4: boards carry direct takedown and bill discount rates, which a v3 board lacks.
 */
const CACHE_SCHEMA_VERSION = 4;
export const TREASURY_FISCAL_DATA_CONNECTION_ID = "treasury-fiscal-data";
/**
 * Refresh the auction board hourly; the week-long expiry keeps an offline
 * start usable without treating the cached observations as a current fetch.
 */
const CACHE_POLICY = {
  staleMs: 60 * 60 * 1000,
  expireMs: 7 * 24 * 60 * 60 * 1000,
} as const;
/**
 * ALL's archive (1979 to the end of the year before last) is results that do
 * not change: it is checked monthly and kept a year for an offline start.
 */
const ARCHIVE_CACHE_POLICY = {
  staleMs: 30 * 24 * 60 * 60 * 1000,
  expireMs: 365 * 24 * 60 * 60 * 1000,
} as const;

export interface TreasuryAuctionsResult {
  auctions: TreasuryAuction[];
  fetchedAt: number;
  /** True when the network failed and expired cache was served instead. */
  stale: boolean;
  /** The refresh failed and the copy saved at this time (ms) answered instead. */
  savedAt?: number;
  refreshError?: string;
}

const decode = (auctions: TreasuryAuction[]) => {
  if (!Array.isArray(auctions)) throw new Error("Invalid cached auctions");
  return auctions;
};
const cache = createPluginCache<TreasuryAuction[]>({
  kind: CACHE_KIND, source: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION, policy: CACHE_POLICY, decode,
});
const archiveCache = createPluginCache<TreasuryAuction[]>({
  kind: CACHE_KIND, source: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION, policy: ARCHIVE_CACHE_POLICY, decode,
});
let connectionHealth: ConnectionHealthRegistry | null = null;

export function attachTreasuryAuctionsPersistence(next: PluginPersistence, health?: ConnectionHealthRegistry): void {
  cache.attach(next);
  archiveCache.attach(next);
  connectionHealth = health ?? null;
}

export function resetTreasuryAuctionsPersistence(): void {
  cache.reset();
  archiveCache.reset();
  connectionHealth = null;
}

type AuctionLoader = (query: AuctionQuery) => Promise<TreasuryAuction[]>;

/** One walk, reported through Connections; an empty one is invalid and must never replace the last good board. */
function walk(loader: AuctionLoader, query: () => AuctionQuery) {
  return async () => {
    const request = () => loader(query());
    const auctions = await (connectionHealth?.hasSource(TREASURY_FISCAL_DATA_CONNECTION_ID)
      ? connectionHealth.track(TREASURY_FISCAL_DATA_CONNECTION_ID, "fetchAuctions", request)
      : request());
    if (auctions.length === 0) throw new Error("Treasury Fiscal Data returned no auctions");
    return auctions;
  };
}

export async function loadTreasuryAuctions(
  force = false,
  loader: AuctionLoader = fetchTreasuryAuctions,
  window: AuctionHistoryWindow = AUCTION_HISTORY_DAYS,
): Promise<TreasuryAuctionsResult> {
  if (window === AUCTION_HISTORY_ALL) return loadAllTreasuryAuctions(force, loader);
  // A saved board answers only for a failure asking again may get past; a refusal or an invalid page is the error.
  const result = savedCopyForTransientFailure(await cache.load(`recent:${window}`, walk(loader, () => auctionWindowQuery(window)), { force }));
  return answered({
    auctions: result.data, fetchedAt: result.fetchedAt, stale: result.stale,
    ...(result.source === "stale-fallback" ? { savedAt: result.fetchedAt } : {}),
    ...(result.refreshError ? { refreshError: result.refreshError } : {}),
  });
}

/** A board a saved copy answered: marked as one, so a command ends by saying when it was saved, not with its failure. */
function answered(result: TreasuryAuctionsResult): TreasuryAuctionsResult {
  return result.savedAt != null ? servedFromSavedCopy(result, result.savedAt) : result;
}

/**
 * ALL: the recent auctions since the archive boundary, refreshed hourly, and
 * the archive before it, from 1979-10-31, cached for weeks and never forced:
 * a refresh only refetches what can still change. Both must load; a board
 * missing its archive would pass for the full history.
 */
async function loadAllTreasuryAuctions(force: boolean, loader: AuctionLoader): Promise<TreasuryAuctionsResult> {
  const boundary = auctionArchiveBoundary();
  const [recent, archive] = await Promise.all([
    cache.load(`since:${boundary}`, walk(loader, () => ({ from: boundary })), { force }).then(savedCopyForTransientFailure),
    archiveCache.load(`archive:${boundary}`, walk(loader, () => ({
      from: AUCTION_HISTORY_START, before: boundary, pageSize: AUCTION_ARCHIVE_PAGE_SIZE,
    }))).then(savedCopyForTransientFailure),
  ]);
  const seen = new Set<string>();
  const auctions = [...recent.data, ...archive.data].filter((auction) => !seen.has(auction.id) && Boolean(seen.add(auction.id)));
  const refreshError = recent.refreshError ?? archive.refreshError;
  const savedAt = Math.min(...[recent, archive].map((part) => part.source === "stale-fallback" ? part.fetchedAt : Infinity));
  return answered({
    auctions, fetchedAt: recent.fetchedAt, stale: recent.stale || archive.stale,
    ...(Number.isFinite(savedAt) ? { savedAt } : {}),
    ...(refreshError ? { refreshError } : {}),
  });
}
