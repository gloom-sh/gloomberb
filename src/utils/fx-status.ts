import type { QueryEntry } from "../market-data/result-types";

export interface FxRateStatus {
  loading: number;
  unavailable: number;
  stale: number;
  unknownTime: number;
  oldestAsOf: number | null;
  latestFetchedAt: number | null;
  /** The pairs counted as unavailable and as stale (`TRY/USD`), so a label names them. */
  unavailablePairs?: string[];
  stalePairs?: string[];
  /** The pair whose rate is the oldest (`oldestAsOf`). */
  oldestPair?: string | null;
}

/** A currency's rate as the pair it is read as: every rate is against the US dollar. */
const usdPair = (currency: string) => `${currency}/USD`;

/** Up to this many pairs are named; more are counted. */
const NAMED_PAIRS = 3;

/** A rate whose last load failed, or whose observation is past its stale time. */
export function isFxRateStale(entry: QueryEntry<number> | null | undefined, now = Date.now()): boolean {
  return Boolean(entry?.error || (entry?.staleAt != null && entry.staleAt <= now));
}

/** A fetched timestamp never stands in for a source observation timestamp. */
export function summarizeFxRates(
  currencies: readonly string[],
  rates: ReadonlyMap<string, number>,
  read: (currency: string) => QueryEntry<number> | null | undefined,
  now = Date.now(),
): FxRateStatus {
  const status: FxRateStatus = { loading: 0, unavailable: 0, stale: 0, unknownTime: 0, oldestAsOf: null, latestFetchedAt: null,
    unavailablePairs: [], stalePairs: [], oldestPair: null };
  for (const currency of new Set(currencies.map((value) => value.trim().toUpperCase()))) {
    if (currency === "USD") continue;
    const entry = read(currency);
    if (entry?.phase === "loading" || entry?.phase === "refreshing") status.loading++;
    const rate = rates.get(currency);
    if (rate == null || !Number.isFinite(rate) || rate <= 0) { status.unavailable++; status.unavailablePairs!.push(usdPair(currency)); continue; }
    // A legacy persisted numeric rate may be present without a dated query.
    if (!entry || entry.asOf == null || !Number.isFinite(entry.asOf)) status.unknownTime++;
    else if (status.oldestAsOf == null || entry.asOf < status.oldestAsOf) {
      status.oldestAsOf = entry.asOf;
      status.oldestPair = usdPair(currency);
    }
    if (isFxRateStale(entry, now)) { status.stale++; status.stalePairs!.push(usdPair(currency)); }
    if (entry?.fetchedAt != null) status.latestFetchedAt = Math.max(status.latestFetchedAt ?? 0, entry.fetchedAt);
  }
  return status;
}

/** `TRY/USD` or `TRY/USD, EGP/USD` when few enough are named, else their count. */
function pairsText(count: number, pairs: readonly string[] | undefined): string {
  return pairs && pairs.length === count && count <= NAMED_PAIRS ? pairs.join(", ") : String(count);
}

/** `TRY/USD stale · oldest rate TRY/USD 2026-11-12 03:49 UTC`: each pair named, as a footer has room for, else counted. */
export function fxStatusLabel(status: FxRateStatus): string {
  const parts: string[] = [];
  if (status.unavailable) parts.push(`${pairsText(status.unavailable, status.unavailablePairs)} unavailable`);
  if (status.stale) parts.push(`${pairsText(status.stale, status.stalePairs)} stale`);
  if (status.unknownTime) parts.push(`${status.unknownTime} rate ${status.unknownTime === 1 ? "time" : "times"} unknown`);
  if (status.oldestAsOf != null) {
    parts.push(`oldest rate ${status.oldestPair ? `${status.oldestPair} ` : ""}${new Date(status.oldestAsOf).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  }
  return parts.join(" · ");
}
