import { classifyInstrumentType, isCryptoVenuePerpetual } from "../../tickers/instrument-kind";

/**
 * The unit an index level is in, as a chart's axis and series name it. A
 * generic future on an index reads in the same points.
 */
export const INDEX_POINTS_UNIT = "points";

/** How a report line names that unit: `history` heads an index's bars with it, `ticker` its quote. */
export const INDEX_POINTS_LABEL = "Index points";

/** How an export names it, in `currency_or_unit` and a `unit` field. */
export const INDEX_POINTS_EXPORT_UNIT = "index points";

/**
 * An index level is points, not money: ^GSPC at 7,805.45 or ^VIX at 19.99 has
 * no currency to name, wherever it is shown, though its quote names the
 * currency its members trade in.
 */
export function isIndexLevel(instrumentType: string | null | undefined): boolean {
  return classifyInstrumentType(instrumentType) === "index";
}

/** The currency a quote's price is in: none for an index level, nor for a quote that names none. */
export function quotePriceCurrency(quote: { currency?: string | null; instrumentType?: string | null } | null | undefined): string | null {
  if (!quote || isIndexLevel(quote.instrumentType)) return null;
  return quote.currency?.trim() || null;
}

/**
 * What a price chart of the instrument reads in: points for an index level,
 * otherwise its currency, so an axis never puts a dollar sign on ^VIX.
 */
export function priceSeriesUnit(currency: string, instrumentType: string | null | undefined): string {
  return isIndexLevel(instrumentType) ? INDEX_POINTS_UNIT : currency;
}

/**
 * A quote's volume where it counts one. An index and a crypto venue's
 * perpetual price carry 0 for a volume nobody counts, which is not a session
 * without trades: null for those, as for a quote with no volume. A broad
 * index whose source sums its members' volume (^GSPC) keeps it.
 */
export function reportedQuoteVolume(
  quote: { volume?: number | null; instrumentType?: string | null; name?: string | null } | null | undefined,
): number | null {
  const volume = quote?.volume;
  if (volume == null || !Number.isFinite(volume)) return null;
  if (volume === 0 && (isIndexLevel(quote!.instrumentType) || isCryptoVenuePerpetual(quote!.instrumentType, quote!.name))) return null;
  return volume;
}
