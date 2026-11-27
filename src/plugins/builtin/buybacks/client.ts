import { apiClient } from "../../../api-client";
import type { BuybacksPayload } from "../../../api-client/buybacks";
import { isFiniteNumber, isNullableFinite } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";
import { sfcSymbol } from "../short-interest/sfc";

const BUYBACKS_UNAVAILABLE = "Share buybacks are not available yet.";

/** `0700:HKEX` for a Hong Kong listing, null for any other. */
export function buybackSymbol(key: string | undefined, exchange?: string): string | null {
  const code = key ? sfcSymbol(key, exchange) : null;
  return code ? `${code}:HKEX` : null;
}

const day = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

function validateBuybacks(data: BuybacksPayload, symbol?: string): BuybacksPayload {
  const valid = !!data && typeof data.symbol === "string" && ["available", "unavailable"].includes(data.status)
    && ["full", "preview"].includes(data.access) && Array.isArray(data.days) && Array.isArray(data.history)
    && data.history.every((row) => day(row.date) && isFiniteNumber(row.close) && isNullableFinite(row.volume))
    && data.days.every((row) => day(row.date) && isFiniteNumber(row.shares) && isFiniteNumber(row.sharesOnExchange) && isNullableFinite(row.percentOfVolume)
      && Array.isArray(row.venues) && !!row.filing && typeof row.filing.url === "string")
    && !!data.blackout && Array.isArray(data.blackout.windows) && data.blackout.windows.every((window) => day(window.start) && day(window.end))
    && !!data.summary && !!data.summary.last5;
  if (!valid) throw new Error("The server returned unreadable share buybacks");
  if (symbol && data.symbol !== symbol) throw new Error("Share buybacks do not match the requested listing");
  return data;
}

// Partitioned by entitlement, so a preview never stands in for the full history.
const buybacksEndpoint = createCloudEndpoint<{ symbol: string; access?: string }, BuybacksPayload, typeof apiClient>({
  kind: "buybacks", schemaVersion: 1, policy: { staleMs: 60 * 60_000, expireMs: 30 * 86_400_000 },
  key: ({ symbol, access }) => `${symbol}:${access}`,
  defaultClient: apiClient,
  fetch: ({ symbol }, client, signal) => client.getCloudBuybacks(symbol, signal ? { signal } : undefined),
  validate: (data, { symbol }) => validateBuybacks(data, symbol),
  unavailableMessage: BUYBACKS_UNAVAILABLE, unavailableStatuses: [404, 503],
});

export const buybacksCache = buybacksEndpoint.cache;
/** One read of a listing's buybacks, uncached: the pane caches it per account, a chart series reads it as it is now. */
export const fetchBuybacks = (symbol: string, signal?: AbortSignal) => buybacksEndpoint.fetch({ symbol }, { signal });
export const cachedBuybacks = (symbol: string, access: string) => buybacksEndpoint.cached({ symbol, access });
export const loadBuybacks = (symbol: string, access: string, force = false) => buybacksEndpoint.load({ symbol, access }, { force });
