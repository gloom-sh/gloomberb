import { createPluginCache } from "../../../data/plugin-cache";
import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import type { PluginPersistence } from "../../../types/plugin";
import { AUCTION_HISTORY_DAYS, fetchTreasuryAuctions } from "./client";
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

export interface TreasuryAuctionsResult {
  auctions: TreasuryAuction[];
  fetchedAt: number;
  /** True when the network failed and expired cache was served instead. */
  stale: boolean;
  refreshError?: string;
}

const cache = createPluginCache<TreasuryAuction[]>({
  kind: CACHE_KIND, source: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION, policy: CACHE_POLICY,
  decode: (auctions) => {
    if (!Array.isArray(auctions)) throw new Error("Invalid cached auctions");
    return auctions;
  },
});
let connectionHealth: ConnectionHealthRegistry | null = null;

export function attachTreasuryAuctionsPersistence(next: PluginPersistence, health?: ConnectionHealthRegistry): void {
  cache.attach(next);
  connectionHealth = health ?? null;
}

export function resetTreasuryAuctionsPersistence(): void {
  cache.reset();
  connectionHealth = null;
}

export async function loadTreasuryAuctions(
  force = false,
  loader: (sinceDays: number) => Promise<TreasuryAuction[]> = fetchTreasuryAuctions,
  sinceDays: number = AUCTION_HISTORY_DAYS,
): Promise<TreasuryAuctionsResult> {
  const result = await cache.load(`recent:${sinceDays}`, async () => {
    const request = () => loader(sinceDays);
    const auctions = await (connectionHealth?.hasSource(TREASURY_FISCAL_DATA_CONNECTION_ID)
      ? connectionHealth.track(TREASURY_FISCAL_DATA_CONNECTION_ID, "fetchAuctions", request)
      : request());
    // An empty response is invalid, so it must never replace the last good board.
    if (auctions.length === 0) throw new Error("Treasury Fiscal Data returned no auctions");
    return auctions;
  }, { force });
  return {
    auctions: result.data, fetchedAt: result.fetchedAt, stale: result.stale,
    ...(result.refreshError ? { refreshError: result.refreshError } : {}),
  };
}
