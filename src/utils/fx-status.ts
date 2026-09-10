import type { QueryEntry } from "../market-data/result-types";

export interface FxRateStatus {
  loading: number;
  unavailable: number;
  stale: number;
  unknownTime: number;
  oldestAsOf: number | null;
  latestFetchedAt: number | null;
  sources: string[];
}

/** A fetched timestamp never stands in for a source observation timestamp. */
export function summarizeFxRates(
  currencies: readonly string[],
  rates: ReadonlyMap<string, number>,
  read: (currency: string) => QueryEntry<number> | null | undefined,
  now = Date.now(),
): FxRateStatus {
  const status: FxRateStatus = { loading: 0, unavailable: 0, stale: 0, unknownTime: 0, oldestAsOf: null, latestFetchedAt: null, sources: [] };
  const sources = new Set<string>();
  for (const currency of new Set(currencies.map((value) => value.trim().toUpperCase()))) {
    if (currency === "USD") continue;
    const entry = read(currency);
    if (entry?.phase === "loading" || entry?.phase === "refreshing") status.loading++;
    const rate = rates.get(currency);
    if (rate == null || !Number.isFinite(rate) || rate <= 0) { status.unavailable++; continue; }
    // A legacy persisted numeric rate may be present without a dated query.
    if (!entry || entry.asOf == null || !Number.isFinite(entry.asOf)) status.unknownTime++;
    else status.oldestAsOf = Math.min(status.oldestAsOf ?? Infinity, entry.asOf);
    if (entry?.error || (entry?.staleAt != null && entry.staleAt <= now)) status.stale++;
    if (entry?.fetchedAt != null) status.latestFetchedAt = Math.max(status.latestFetchedAt ?? 0, entry.fetchedAt);
    if (entry?.source && entry.source !== "static" && entry.source !== "identity") sources.add(entry.source);
  }
  status.sources = [...sources].sort();
  return status;
}

export function fxStatusLabel(status: FxRateStatus): string {
  const parts: string[] = [];
  if (status.unavailable) parts.push(`${status.unavailable} unavailable`);
  if (status.stale) parts.push(`${status.stale} stale`);
  if (status.unknownTime) parts.push(`${status.unknownTime} rate ${status.unknownTime === 1 ? "time" : "times"} unknown`);
  if (status.oldestAsOf != null) parts.push(`oldest rate ${new Date(status.oldestAsOf).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  return parts.join(" · ");
}
