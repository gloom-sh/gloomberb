import type { EarningsEvent } from "../types/data-provider";
import { isUsListingExchange } from "../utils/exchanges";
import { listingChoiceNote, loadListingQuote, sameCompany, usLineOfListing, type CliListing, type ListingDeps, type ListingVenue } from "./listing-arg";

const DAY_MS = 86_400_000;

/** How firm a report date is: "reported" once there is an actual, else "est" or "confirmed" as the calendar flags it. */
export function earningsDateLabel(event: Pick<EarningsEvent, "isDateEstimate" | "epsActual">): string {
  if (event.epsActual != null) return "reported";
  return event.isDateEstimate === true ? "est" : event.isDateEstimate === false ? "confirmed" : "";
}

/** Whether the listing trades abroad, where the calendar is the listing's own exchange's rather than the US one. */
export function isListingAbroad(listing: Pick<CliListing, "exchange">): boolean {
  return !!listing.exchange && !isUsListingExchange(listing.exchange);
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * "SAN:MCE: no calendar for this listing; ADR date 2026-11-04 (estimate)" for
 * a listing abroad the calendar has no date for. The same company's line in
 * the US, under the same symbol, lends its date as an estimate; a US line that
 * is another company (SAN:EPA is Sanofi, SAN in New York is Banco Santander)
 * lends nothing.
 */
export async function noListingCalendarNote(
  listing: Pick<CliListing, "symbol" | "exchange" | "key" | "request" | "saved">,
  deps: ListingDeps,
  now = Date.now(),
): Promise<string> {
  const lead = `${listing.key}: no calendar for this listing`;
  const quote = await loadListingQuote(deps.dataProvider, listing);
  const company = quote?.name?.trim() || listing.saved?.metadata.name?.trim() || null;
  const usLine = await usLineOfListing(listing, company, deps);
  if (!usLine || !deps.dataProvider.getEarningsCalendar) return lead;
  const events = await deps.dataProvider.getEarningsCalendar([listing.symbol]).catch(() => []);
  const event = events.find((entry) => entry.symbol.toUpperCase() === listing.symbol.toUpperCase());
  if (!event || event.earningsDate.getTime() < now - DAY_MS) return lead;
  return `${lead}; ADR date ${isoDate(event.earningsDate)} (estimate)`;
}

/**
 * "SAN = Banco Santander, NYSE (also EPA, LSE)" for a bare symbol whose
 * calendar date is its US line's, when several companies list the symbol:
 * the event names the company the date is for.
 */
export function earningsChoiceNote(
  listing: Pick<CliListing, "symbol">,
  event: Pick<EarningsEvent, "name"> | undefined,
  venues: readonly ListingVenue[],
): string | null {
  const chosen = event && venues.find((venue) => isUsListingExchange(venue.exchange) && sameCompany(venue.name, event.name));
  return chosen ? listingChoiceNote(listing.symbol, { exchange: chosen.exchange, name: event.name }, venues) : null;
}

const REASON_CODE = /^[A-Z][A-Z_]+$/;

/**
 * What to say when the data service refused the calendar with a reason code
 * (UPSTREAM_ERROR) rather than words: which listings, and that the source
 * failed. Null for any other error, whose own message stands.
 */
export function earningsCalendarFailure(error: unknown, keys: readonly string[]): string | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!REASON_CODE.test(message.trim())) return null;
  const what = `Earnings dates for ${keys.join(", ")}`;
  if (message === "TIMEOUT") return `${what} did not load: the calendar source timed out. Try again in a few minutes.`;
  return `${what} did not load: the calendar source failed. Try again in a few minutes.`;
}
