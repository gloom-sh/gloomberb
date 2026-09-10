import type { ExchangeRateSnapshot } from "../types/exchange-rate";

export const MAX_FX_OBSERVATION_AGE_MS = 7 * 24 * 60 * 60_000;
const FX_FRESH_MS = 60 * 60_000;

interface FxRateMetadata {
  fetchedAt?: number;
  asOf?: number;
  staleAt?: number;
  expiresAt?: number;
  source?: string;
}

export function isUsableCachedExchangeRate(rate: number | null, currency: string,
  timing: { asOf?: number; fetchedAt?: number | null }, now = Date.now()): boolean {
  try {
    exchangeRateMetadata({ rate, asOf: timing.asOf === undefined ? undefined : new Date(timing.asOf).toISOString() },
      currency, now, timing.fetchedAt ?? undefined);
    return true;
  } catch { return false; }
}

/** Validate before numeric decoding, including persisted and legacy snapshots. */
export function exchangeRateMetadata(value: unknown, currency: string, now = Date.now(), fallbackFetchedAt?: number): FxRateMetadata {
  const data = typeof value === "number" ? { rate: value } : value as Partial<ExchangeRateSnapshot> | null;
  const fail = () => { throw new Error(`Invalid or expired exchange rate for ${currency}/USD`); };
  if (!data || typeof data !== "object" || !Number.isFinite(data.rate) || data.rate! <= 0
    || (data.fromCurrency !== undefined && data.fromCurrency !== currency)
    || (data.toCurrency !== undefined && data.toCurrency !== "USD")) return fail();
  // The numeraire identity needs no market observation or upstream request.
  if (currency === "USD") {
    if (data.rate !== 1) return fail();
    return { staleAt: Infinity, expiresAt: Infinity, source: "identity" };
  }
  const timestamp = (input: unknown): number | undefined => {
    if (input === undefined) return undefined;
    if (typeof input !== "string" || !Number.isFinite(Date.parse(input))) return fail();
    return Date.parse(input);
  };
  const asOf = timestamp(data.asOf);
  const fetchedAt = timestamp(data.fetchedAt) ?? fallbackFetchedAt;
  const declaredStaleAt = timestamp(data.staleAt);
  const observation = asOf ?? fetchedAt;
  if ([asOf, fetchedAt].some((time) => time !== undefined && (!Number.isFinite(time) || time > now + 60_000))
    || (observation !== undefined && now - observation >= MAX_FX_OBSERVATION_AGE_MS)) return fail();
  const expiresAt = Math.min(fetchedAt === undefined ? Infinity : fetchedAt + MAX_FX_OBSERVATION_AGE_MS,
    asOf === undefined ? Infinity : asOf + MAX_FX_OBSERVATION_AGE_MS);
  if (expiresAt <= now) return fail();
  const delay = typeof data.delayMinutes === "number" && Number.isFinite(data.delayMinutes) && data.delayMinutes >= 0
    ? Math.min(data.delayMinutes, 15) * 60_000 : 0;
  const staleAt = Math.min(declaredStaleAt ?? Infinity,
    fetchedAt === undefined ? Infinity : fetchedAt + FX_FRESH_MS,
    asOf === undefined ? Infinity : asOf + FX_FRESH_MS + delay,
    data.stale === true ? now : Infinity);
  return {
    ...(fetchedAt !== undefined ? { fetchedAt } : {}),
    asOf,
    ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
    ...(Number.isFinite(staleAt) ? { staleAt } : {}),
    ...(typeof data.source === "string" ? { source: data.source } : {}),
  };
}
