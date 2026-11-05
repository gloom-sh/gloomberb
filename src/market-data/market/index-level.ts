import { classifyInstrumentType, isCryptoVenuePerpetual } from "../../tickers/instrument-kind";
import type { PriceBasis } from "../../types/instrument";

/**
 * The unit an index level is in, as a chart's axis and series name it. A
 * generic future on an index reads in the same points.
 */
export const INDEX_POINTS_UNIT = "points";

/**
 * What a chart calls an index's volume: the combined volume of its members,
 * which no source gives a unit of its own.
 */
export const INDEX_MEMBERS_VOLUME_LABEL = "Members' volume";

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
 * What a price chart reads in: the quote's price basis, points for an index
 * level, otherwise its currency.
 */
export function priceSeriesUnit(currency: string, instrumentType: string | null | undefined, priceBasis?: PriceBasis): string {
  if (priceBasis === "thirty-seconds") return "32nds";
  return priceBasis === "points" || isIndexLevel(instrumentType) ? INDEX_POINTS_UNIT : currency;
}

/**
 * A quote's volume where it counts one. An index and a crypto venue's
 * perpetual price carry 0 for a volume nobody counts, which is not a session
 * without trades: null for those, as for a quote with no volume. A broad
 * index whose source sums its members' volume (^GSPC) keeps it. A currency
 * pair trades over the counter, where no one counts a volume: null whatever
 * its quote carries.
 */
export function reportedQuoteVolume(
  quote: { volume?: number | null; instrumentType?: string | null; name?: string | null } | null | undefined,
): number | null {
  const volume = quote?.volume;
  if (volume == null || !Number.isFinite(volume)) return null;
  if (classifyInstrumentType(quote!.instrumentType) === "currency") return null;
  if (volume === 0 && (isIndexLevel(quote!.instrumentType) || isCryptoVenuePerpetual(quote!.instrumentType, quote!.name))) return null;
  return volume;
}
