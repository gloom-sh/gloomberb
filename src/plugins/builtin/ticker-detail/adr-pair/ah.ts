import { useCallback } from "react";
import { useAsyncResource } from "../../../../react/async-resource";
import { useFxRateObservations, useQuoteEntry } from "../../../../market-data/hooks";
import { resolveEntryData } from "../../../../market-data/selectors";
import { pairPriceInput } from "../../../../market-data/depositary-pair";
import {
  ahListingKey, ahPairOf, ahPairSide, ahSpotFromUsdValues, compareAhPair, type AhComparison, type AhPair,
} from "../../../../market-data/ah-pair";
import type { Quote } from "../../../../types/financials";
import { canonicalExchange, parsePublicTickerKey } from "../../../../utils/exchanges";
import { useAssetData } from "../../../runtime";

/** Venues an A+H company's lines trade on. */
const AH_VENUES = new Set(["HKEX", "SSE", "SZSE"]);

/** Whether a listing is on a venue an A+H company's line trades on, so its company's lines are worth reading. */
export function mayBeAhLine(symbol: string | null | undefined, exchange?: string | null): boolean {
  if (!symbol) return false;
  const venue = parsePublicTickerKey(ahListingKey(symbol, exchange)).exchange;
  return AH_VENUES.has(canonicalExchange(venue ?? ""));
}

/** The listing's A+H pair and how its two prices compare, as the ADR tab and DES read it. */
export interface AhPairState {
  pair: AhPair;
  /** Which line the listing is. */
  side: "h" | "a";
  quotes: { h: Quote | null; a: Quote | null };
  /** Null while a price is missing. */
  comparison: AhComparison | null;
  /** The other line's price is still being read. */
  loading: boolean;
}

/**
 * The A+H pair of the listing `symbol` (on `exchange`), from the company's
 * lines Gloom Cloud holds (`getIssuerListings`), with the other line's price
 * read through the quote path, both dollar rates, and the comparison. Null for
 * a listing off those venues or of a company that is no A+H pair. `ownQuote`
 * is the listing's own price as the pane already shows it.
 */
export function useAhPair(symbol: string | null | undefined, exchange: string | null | undefined, ownQuote: Quote | null | undefined): AhPairState | null {
  const dataProvider = useAssetData();
  const reads = mayBeAhLine(symbol, exchange) && !!dataProvider?.getIssuerListings;
  const loader = useCallback(
    () => dataProvider!.getIssuerListings!(symbol!, exchange ?? undefined),
    [dataProvider, exchange, symbol],
  );
  const issuer = useAsyncResource(reads ? loader : null);
  const pair = reads ? ahPairOf(issuer.data) : null;
  const side = pair && symbol ? ahPairSide(pair, symbol, exchange) : null;
  const other = pair && side ? (side === "h" ? pair.a : pair.h) : null;
  const otherEntry = useQuoteEntry(other, null);
  const rates = useFxRateObservations(other ? ["CNY", "HKD"] : []);
  if (!pair || !side) return null;
  const otherQuote = resolveEntryData(otherEntry) ?? null;
  const quotes = side === "h" ? { h: ownQuote ?? null, a: otherQuote } : { h: otherQuote, a: ownQuote ?? null };
  const spot = ahSpotFromUsdValues(rates.get("CNY") ?? null, rates.get("HKD") ?? null);
  const comparison = compareAhPair(pairPriceInput(pair.h, quotes.h), pairPriceInput(pair.a, quotes.a), spot);
  const loading = !otherQuote && (!otherEntry || otherEntry.phase === "loading" || otherEntry.phase === "idle");
  return { pair, side, quotes, comparison, loading };
}
