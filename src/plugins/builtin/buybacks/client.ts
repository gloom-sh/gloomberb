import { apiClient } from "../../../api-client";
import type { BuybacksPayload } from "../../../api-client/buybacks";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import { sfcSymbol } from "../short-interest/sfc";

const BUYBACKS_UNAVAILABLE = "Share buybacks are not available yet.";
export const buybacksCache = createPluginCache<BuybacksPayload>({ kind: "buybacks", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60 * 60_000, expireMs: 30 * 86_400_000 } });

/** `0700:HKEX` for a Hong Kong listing, null for any other. */
export function buybackSymbol(key: string | undefined, exchange?: string): string | null {
  const code = key ? sfcSymbol(key, exchange) : null;
  return code ? `${code}:HKEX` : null;
}

const day = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const nullableFinite = (value: unknown) => value === null || finite(value);

function validateBuybacks(data: BuybacksPayload): BuybacksPayload {
  const valid = !!data && typeof data.symbol === "string" && ["available", "unavailable"].includes(data.status)
    && ["full", "preview"].includes(data.access) && Array.isArray(data.days) && Array.isArray(data.history)
    && data.history.every((row) => day(row.date) && finite(row.close) && nullableFinite(row.volume))
    && data.days.every((row) => day(row.date) && finite(row.shares) && finite(row.sharesOnExchange) && nullableFinite(row.percentOfVolume)
      && Array.isArray(row.venues) && !!row.filing && typeof row.filing.url === "string")
    && !!data.blackout && Array.isArray(data.blackout.windows) && data.blackout.windows.every((window) => day(window.start) && day(window.end))
    && !!data.summary && !!data.summary.last5;
  if (!valid) throw new Error("The server returned unreadable share buybacks");
  return data;
}

/** One read of a listing's buybacks, uncached: the pane caches it per account, a chart series reads it as it is now. */
export async function fetchBuybacks(symbol: string, signal?: AbortSignal): Promise<BuybacksPayload> {
  try {
    const data = validateBuybacks(await apiClient.getCloudBuybacks(symbol, signal ? { signal } : undefined));
    if (data.symbol !== symbol) throw new Error("Share buybacks do not match the requested listing");
    return data;
  } catch (error) {
    throw unavailableOnServer(error, BUYBACKS_UNAVAILABLE, [404, 503]);
  }
}

// Partitioned by entitlement, so a preview never stands in for the full history.
const cacheKey = (symbol: string, access: string) => `${symbol}:${access}`;
export const cachedBuybacks = (symbol: string, access: string) => cachedCloudResource(buybacksCache, cacheKey(symbol, access), validateBuybacks);
export const loadBuybacks = (symbol: string, access: string, force = false) =>
  loadCloudResource(buybacksCache, cacheKey(symbol, access), () => fetchBuybacks(symbol), { force, validate: validateBuybacks });
