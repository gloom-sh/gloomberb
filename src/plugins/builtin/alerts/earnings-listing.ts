import { resolveAlertListing, type AlertListingOptions } from "../../../cli/alert-listing";
import type { ListingDeps } from "../../../cli/listing-arg";
import { canonicalExchange, isUsListingExchange } from "../../../utils/exchanges";

/**
 * The venue of a bare symbol an earnings alert is asked for, read as every
 * alert reads its symbol (`resolveAlertListing`): D05 and "Singtel" are on
 * SGX, which earnings alerts do not follow, so they get the line any listing
 * outside the US gets. A US listing comes back without a venue, as typed.
 * Throws `AlertListingRefusal` for a symbol no alert can follow.
 */
export async function earningsListingVenue(
  typed: string,
  deps: ListingDeps,
  options: AlertListingOptions = {},
): Promise<{ symbol: string; exchange: string | null; notes: string[] }> {
  const { listing, quote, notes } = await resolveAlertListing(typed, null, deps, options);
  const venue = canonicalExchange(listing.exchange || quote.listingExchangeName || quote.exchangeName || "");
  return { symbol: listing.symbol, exchange: venue && !isUsListingExchange(venue) ? venue : null, notes };
}
