import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import type { PluginPersistence } from "../../../types/plugin";
import { AUCTION_HISTORY_DAYS, fetchTreasuryAuctions } from "./client";
import type { TreasuryAuction } from "./types";

const CACHE_KIND = "treasury-auctions";
const CACHE_SOURCE = "treasury-fiscal-data";
/** 2: rows carry a CUSIP, so reopenings no longer share an id with the original. */
const CACHE_SCHEMA_VERSION = 2;
export const TREASURY_FISCAL_DATA_CONNECTION_ID = "treasury-fiscal-data";
/**
 * Auctions settle a few times a week and results never change once published,
 * so an hour of freshness is plenty; the week-long expiry is what keeps an
 * offline start usable.
 */
const CACHE_POLICY = {
  staleMs: 60 * 60 * 1000,
  expireMs: 7 * 24 * 60 * 60 * 1000,
} as const;

export interface TreasuryAuctionsResult {
  auctions: TreasuryAuction[];
  fetchedAt: number;
  /** True when the network failed and expired cache was served instead. */
  stale: boolean;
}

let persistence: PluginPersistence | null = null;
let connectionHealth: ConnectionHealthRegistry | null = null;
const activeFetches = new Map<number, Promise<TreasuryAuctionsResult>>();

function cacheKey(sinceDays: number): string {
  return `recent:${sinceDays}`;
}

export function attachTreasuryAuctionsPersistence(
  next: PluginPersistence,
  health?: ConnectionHealthRegistry,
): void {
  persistence = next;
  connectionHealth = health ?? null;
}

export function resetTreasuryAuctionsPersistence(): void {
  persistence = null;
  connectionHealth = null;
  activeFetches.clear();
}

function readCache(sinceDays: number, options?: { allowExpired?: boolean }): TreasuryAuctionsResult | null {
  const record = persistence?.getResource<TreasuryAuction[]>(CACHE_KIND, cacheKey(sinceDays), {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    allowExpired: options?.allowExpired,
  });
  if (!record || !Array.isArray(record.value)) return null;
  return { auctions: record.value, fetchedAt: record.fetchedAt, stale: !!record.stale };
}

/**
 * Serves fresh cache without a request, shares one in-flight fetch across
 * panes, and falls back to whatever is cached (expired included) when the
 * Treasury endpoint is unreachable.
 */
export async function loadTreasuryAuctions(
  force = false,
  loader: (sinceDays: number) => Promise<TreasuryAuction[]> = fetchTreasuryAuctions,
  sinceDays: number = AUCTION_HISTORY_DAYS,
): Promise<TreasuryAuctionsResult> {
  const cached = readCache(sinceDays);
  if (!force && cached && !cached.stale) return cached;
  const inFlight = activeFetches.get(sinceDays);
  if (inFlight) return inFlight;

  const fallback = cached ?? readCache(sinceDays, { allowExpired: true });
  const request = () => loader(sinceDays);
  const fetchPromise = (connectionHealth?.hasSource(TREASURY_FISCAL_DATA_CONNECTION_ID)
    ? connectionHealth.track(TREASURY_FISCAL_DATA_CONNECTION_ID, "fetchAuctions", request)
    : request())
    .then((auctions) => {
      // Treasury auctions several times a week, so an empty window is a bad
      // response, never the truth. It is never cached: persisting [] would
      // serve the bad response back for an hour.
      if (auctions.length === 0) {
        if (fallback) return { ...fallback, stale: true };
        throw new Error("Treasury Fiscal Data returned no auctions");
      }
      persistence?.setResource(CACHE_KIND, cacheKey(sinceDays), auctions, {
        sourceKey: CACHE_SOURCE,
        schemaVersion: CACHE_SCHEMA_VERSION,
        cachePolicy: CACHE_POLICY,
      });
      return { auctions, fetchedAt: Date.now(), stale: false };
    })
    .catch((error: unknown) => {
      if (fallback) return { ...fallback, stale: true };
      throw error;
    })
    .finally(() => {
      if (activeFetches.get(sinceDays) === fetchPromise) activeFetches.delete(sinceDays);
    });
  activeFetches.set(sinceDays, fetchPromise);
  return fetchPromise;
}
