import { apiClient } from "../../../api-client";
import { createPluginCache } from "../../../data/plugin-cache";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { loadCloudResource, type CloudResource } from "../shared/cloud-resource";

/** The coins Deribit publishes a volatility index (DVOL) for. */
export type DvolCurrency = "BTC" | "ETH";

export const DVOL_COINS: Readonly<Record<DvolCurrency, string>> = { BTC: "Bitcoin", ETH: "Ether" };

/**
 * Deribit's DVOL: the 30-day implied volatility its options price, in vol
 * points, a close for each UTC day (today's so far last) and the latest print.
 */
export interface DvolPayload {
  version: 1;
  currency: DvolCurrency;
  observations: Array<{ date: string; value: number }>;
  latest: { value: number; at: string } | null;
  delayed: boolean;
  venue: string;
}

export type DvolApi = Pick<typeof apiClient, "impliedVolatility">;

/**
 * Each coin's last DVOL, kept so OVDV still shows it, saying when it was
 * saved, when the service cannot be reached. Every load asks the service first.
 */
export const dvolCache = createPluginCache<DvolPayload>({
  kind: "deribit-dvol", source: "gloom-cloud", schemaVersion: 1, policy: { staleMs: 0, expireMs: 7 * 86_400_000 },
});

/** A coin's DVOL; the saved copy, with `savedAt`, when the service cannot be reached. */
export function loadDvol(currency: DvolCurrency, options: { signal?: AbortSignal } = {}, api: DvolApi = apiClient): Promise<CloudResource<DvolPayload>> {
  return loadCloudResource(dvolCache, currency,
    () => api.impliedVolatility<DvolPayload>(`dvol?currency=${currency}`, { signal: options.signal }), { signal: options.signal });
}

/** BTC for BTC-USD (bare or on the coin board), ETH for ETH-USD; null for anything else, the funds trading as BTC and ETH included. */
export function dvolCurrency(symbol: string | null | undefined): DvolCurrency | null {
  if (!symbol) return null;
  const parsed = parsePublicTickerKey(symbol.trim().toUpperCase());
  if (parsed.exchange && parsed.exchange !== "CCC") return null;
  return parsed.symbol === "BTC-USD" ? "BTC" : parsed.symbol === "ETH-USD" ? "ETH" : null;
}

/** The series id a coin's DVOL charts as: `volatility:dvol-btc`. */
export const dvolSeriesId = (currency: DvolCurrency) => `volatility:dvol-${currency.toLowerCase()}`;

/**
 * DVOL against the 30-day point of a surface, both in vol points: the gap a
 * reader checks one against the other with. Null without either.
 */
export function dvolGap(dvol: number | null | undefined, impliedPoints: number | null | undefined): number | null {
  return dvol == null || impliedPoints == null || !Number.isFinite(dvol) || !Number.isFinite(impliedPoints) ? null
    : Number((impliedPoints - dvol).toFixed(2));
}
