import type { QueryEntry } from "../../../market-data/result-types";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";

/** Currencies the market quotes as USD per unit; the rest quote as units per USD. */
const USD_QUOTED = new Set(["EUR", "GBP", "AUD", "NZD"]);

export interface FxLeg {
  currency: string;
  /** The pair as the market quotes it: EURUSD=X, or JPY=X for USD/JPY. */
  symbol: string;
  /** The pair quotes units per USD, so USD per unit is its inverse. */
  inverted: boolean;
}

/** One quoted pair per non-USD currency; every cross in the matrix derives from these legs. */
export function fxLegs(currencies: readonly string[]): FxLeg[] {
  return currencies.flatMap((currency) => {
    if (currency === "USD") return [];
    const inverted = !USD_QUOTED.has(currency);
    return [{ currency, symbol: inverted ? `${currency}=X` : `${currency}USD=X`, inverted }];
  });
}

export function fxLegTargets(legs: readonly FxLeg[], selectedCurrency: string | null): QuoteSubscriptionTarget[] {
  return legs.map((leg) => ({
    symbol: leg.symbol,
    exchange: "",
    surface: "screener",
    visible: true,
    selected: leg.currency === selectedCurrency,
    weight: leg.currency === selectedCurrency ? 100 : 70,
  }));
}

export function fxLegQuoteKey(leg: FxLeg): string {
  return buildQuoteKey({ symbol: leg.symbol, exchange: "" });
}

/**
 * The USD-per-unit rate a live pair quote implies, as an entry in the same
 * shape as the snapshot rates, so status and export read both alike. A quote
 * the connection marked stale, or older than the snapshot, gives way to it.
 */
export function liveFxLegEntry(
  leg: FxLeg,
  entry: QueryEntry<Quote> | undefined,
  snapshot: QueryEntry<number> | null | undefined,
): QueryEntry<number> | null {
  const quote = resolveEntryData(entry);
  if (!quote || quote.stale === true || !Number.isFinite(quote.price) || quote.price <= 0) return null;
  const observedAt = Number.isFinite(quote.lastUpdated) ? quote.lastUpdated : null;
  if (observedAt == null) return null;
  const snapshotAsOf = snapshot?.asOf ?? null;
  if (snapshotAsOf != null && Number.isFinite(snapshotAsOf) && observedAt < snapshotAsOf) return null;
  const rate = leg.inverted ? 1 / quote.price : quote.price;
  return {
    phase: "ready",
    data: rate,
    lastGoodData: rate,
    // What the data is, never where it came from.
    source: quote.dataSource === "live" || quote.dataSource === "delayed" ? quote.dataSource : null,
    fetchedAt: quote.receivedAt ?? observedAt,
    asOf: observedAt,
    staleAt: null,
    error: null,
    attempts: [],
  };
}
