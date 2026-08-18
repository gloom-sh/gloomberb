import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import type { PluginPersistence } from "../../../types/plugin";
import { fetchTreasuryAuctions } from "./client";
import type { TreasuryAuction } from "./types";

const CACHE_KIND = "treasury-auctions";
const CACHE_KEY = "recent";
const CACHE_SOURCE = "treasury-fiscal-data";
const CACHE_SCHEMA_VERSION = 1;
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
let activeFetch: Promise<TreasuryAuctionsResult> | null = null;

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
  activeFetch = null;
}

function readCache(options?: { allowExpired?: boolean }): TreasuryAuctionsResult | null {
  const record = persistence?.getResource<TreasuryAuction[]>(CACHE_KIND, CACHE_KEY, {
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
  loader: () => Promise<TreasuryAuction[]> = fetchTreasuryAuctions,
): Promise<TreasuryAuctionsResult> {
  const cached = readCache();
  if (!force && cached && !cached.stale) return cached;
  if (activeFetch) return activeFetch;

  const fallback = cached ?? readCache({ allowExpired: true });
  const request = () => loader();
  activeFetch = (connectionHealth?.hasSource(TREASURY_FISCAL_DATA_CONNECTION_ID)
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
      persistence?.setResource(CACHE_KIND, CACHE_KEY, auctions, {
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
      activeFetch = null;
    });
  return activeFetch;
}
