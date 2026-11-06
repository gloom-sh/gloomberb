import { createPluginCache, savedCopyForTransientFailure, type PluginCacheResult } from "../../../data/plugin-cache";
import { servedFromSavedCopy } from "../../../data/saved-copies";
import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import type { PluginPersistence } from "../../../types/plugin";
import {
  AUCTION_ARCHIVE_PAGE_SIZE, AUCTION_HISTORY_ALL, AUCTION_HISTORY_DAYS, AUCTION_HISTORY_START, auctionArchiveBoundary,
  auctionWindowQuery, fetchTreasuryAuctions, type AuctionHistoryWindow, type AuctionQuery,
} from "./client";
import { mergeAuctionSources } from "./model";
import { DIRECT_LOOKBACK_DAYS, fetchDirectAuctions } from "./treasury-direct";
import type { TreasuryAuction } from "./types";

const CACHE_KIND = "treasury-auctions";
const CACHE_SOURCE = "treasury-fiscal-data";
const DIRECT_CACHE_SOURCE = "treasury-direct";
/**
 * 3: every reported page was validated before this board was cached.
 * 4: boards carry direct takedown and bill discount rates, which a v3 board lacks.
 */
const CACHE_SCHEMA_VERSION = 4;
export const TREASURY_FISCAL_DATA_CONNECTION_ID = "treasury-fiscal-data";
export const TREASURY_DIRECT_CONNECTION_ID = "treasury-direct";
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
/** TreasuryDirect's last weeks and announcements, refreshed as often as the board they are merged into. */
const directCache = createPluginCache<TreasuryAuction[]>({
  kind: CACHE_KIND, source: DIRECT_CACHE_SOURCE, schemaVersion: 1, policy: CACHE_POLICY, decode,
});
let connectionHealth: ConnectionHealthRegistry | null = null;

export function attachTreasuryAuctionsPersistence(next: PluginPersistence, health?: ConnectionHealthRegistry): void {
  cache.attach(next);
  archiveCache.attach(next);
  directCache.attach(next);
  connectionHealth = health ?? null;
}

export function resetTreasuryAuctionsPersistence(): void {
  cache.reset();
  archiveCache.reset();
  directCache.reset();
  connectionHealth = null;
}

type AuctionLoader = (query: AuctionQuery) => Promise<TreasuryAuction[]>;
/** The auctions of the last `days` days and the announced ones, from TreasuryDirect. */
type DirectLoader = (days: number) => Promise<TreasuryAuction[]>;

/** One walk, reported through Connections; an empty one is invalid and must never replace the last good board. */
function walk(source: { id: string; name: string }, load: () => Promise<TreasuryAuction[]>) {
  return async () => {
    const auctions = await (connectionHealth?.hasSource(source.id)
      ? connectionHealth.track(source.id, "fetchAuctions", load)
      : load());
    if (auctions.length === 0) throw new Error(`${source.name} returned no auctions`);
    return auctions;
  };
}

const FISCAL_DATA = { id: TREASURY_FISCAL_DATA_CONNECTION_ID, name: "Treasury Fiscal Data" };
const TREASURY_DIRECT = { id: TREASURY_DIRECT_CONNECTION_ID, name: "TreasuryDirect" };

/** One source's answer, or why it gave none: the other source's board stands in for it. */
type Answer = { read: PluginCacheResult<TreasuryAuction[]> } | { failed: unknown };

async function answer(read: Promise<PluginCacheResult<TreasuryAuction[]>>): Promise<Answer> {
  try {
    return { read: savedCopyForTransientFailure(await read) };
  } catch (failed) {
    return { failed };
  }
}

const failureMessage = (failed: unknown) => failed instanceof Error ? failed.message : String(failed);

/**
 * The recent auctions from both sources: Fiscal Data's walk of `fiscalKey`
 * and TreasuryDirect's last weeks and announcements, each cached and refreshed
 * on its own, then merged (`mergeAuctionSources`). One source that gives
 * nothing, for lack of an answer and a saved copy or for a refusal, leaves the
 * board to the other and says so as a refresh error; both failing is Fiscal
 * Data's failure, as before TreasuryDirect was read. With no `direct` loader
 * (a test's stand-in for the whole board) only the first is read.
 */
async function loadRecentBoard(
  force: boolean,
  fiscalKey: string,
  fiscal: () => Promise<TreasuryAuction[]>,
  direct: { days: number; load: DirectLoader } | null,
  from: () => string,
): Promise<TreasuryAuctionsResult> {
  const [primary, supplement] = await Promise.all([
    answer(cache.load(fiscalKey, walk(FISCAL_DATA, fiscal), { force })),
    direct ? answer(directCache.load(`direct:${direct.days}`, walk(TREASURY_DIRECT, () => direct.load(direct.days)), { force })) : null,
  ]);
  if ("failed" in primary && (!supplement || "failed" in supplement)) throw primary.failed;

  const answers = [primary, supplement].filter((entry): entry is { read: PluginCacheResult<TreasuryAuction[]> } => !!entry && "read" in entry);
  const failed = [primary, supplement].find((entry): entry is { failed: unknown } => !!entry && "failed" in entry);
  const saved = answers.filter(({ read }) => read.source === "stale-fallback");
  const refreshError = answers.find(({ read }) => read.refreshError)?.read.refreshError ?? (failed ? failureMessage(failed.failed) : undefined);
  return {
    auctions: mergeAuctionSources("read" in primary ? primary.read.data : [], supplement && "read" in supplement ? supplement.read.data : [], from()),
    // The oldest part: how old what is shown can be.
    fetchedAt: Math.min(...answers.map(({ read }) => read.fetchedAt)),
    stale: !!failed || answers.some(({ read }) => read.stale),
    ...(saved.length ? { savedAt: Math.min(...saved.map(({ read }) => read.fetchedAt)) } : {}),
    ...(refreshError ? { refreshError } : {}),
  };
}

export async function loadTreasuryAuctions(
  force = false,
  loader: AuctionLoader = fetchTreasuryAuctions,
  window: AuctionHistoryWindow = AUCTION_HISTORY_DAYS,
  // A loader of the caller's own stands for the whole board.
  direct: DirectLoader | null = loader === fetchTreasuryAuctions ? fetchDirectAuctions : null,
): Promise<TreasuryAuctionsResult> {
  if (window === AUCTION_HISTORY_ALL) return loadAllTreasuryAuctions(force, loader, direct);
  // A saved board answers only for a failure asking again may get past; a refusal or an invalid page is the error.
  return answered(await loadRecentBoard(
    force,
    `recent:${window}`,
    () => loader(auctionWindowQuery(window)),
    direct && { days: Math.min(window, DIRECT_LOOKBACK_DAYS), load: direct },
    () => auctionWindowQuery(window).from,
  ));
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
async function loadAllTreasuryAuctions(force: boolean, loader: AuctionLoader, direct: DirectLoader | null): Promise<TreasuryAuctionsResult> {
  const boundary = auctionArchiveBoundary();
  const [recent, archive] = await Promise.all([
    loadRecentBoard(force, `since:${boundary}`, () => loader({ from: boundary }), direct && { days: DIRECT_LOOKBACK_DAYS, load: direct }, () => boundary),
    archiveCache.load(`archive:${boundary}`, walk(FISCAL_DATA, () => loader({
      from: AUCTION_HISTORY_START, before: boundary, pageSize: AUCTION_ARCHIVE_PAGE_SIZE,
    }))).then(savedCopyForTransientFailure),
  ]);
  const seen = new Set<string>();
  const auctions = [...recent.auctions, ...archive.data].filter((auction) => !seen.has(auction.id) && Boolean(seen.add(auction.id)));
  const refreshError = recent.refreshError ?? archive.refreshError;
  const savedAt = Math.min(recent.savedAt ?? Infinity, archive.source === "stale-fallback" ? archive.fetchedAt : Infinity);
  return answered({
    auctions, fetchedAt: recent.fetchedAt, stale: recent.stale || archive.stale,
    ...(Number.isFinite(savedAt) ? { savedAt } : {}),
    ...(refreshError ? { refreshError } : {}),
  });
}
