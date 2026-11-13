import { logFailure } from "../utils/log-failure";
import type { EarningsEvent } from "../types/data-provider";
import type { EarningsDateStatus } from "../types/financials";
import { isUsListingExchange } from "../utils/exchanges";
import { listingChoiceNote, loadListingQuote, usLineOfListing, type CliListing, type ListingDeps, type ListingVenue } from "./listing-arg";
import { sameCompany } from "../tickers/company-name";
import { lastReportOnRecord, listingDay, noNextReportText } from "../plugins/builtin/shared/earnings-calendar";
import { commandWord } from "../utils/shell-word";

const DAY_MS = 86_400_000;

/** How firm a report date is, as resolved (shared/earnings-calendar): reported, confirmed, or est for a projected one. */
export function earningsDateLabel(status: EarningsDateStatus | null): string {
  return status === "projected" ? "est" : status ?? "";
}

/** Whether the listing trades abroad, where the calendar is the listing's own exchange's rather than the US one. */
function isListingAbroad(listing: Pick<CliListing, "exchange">): boolean {
  return !!listing.exchange && !isUsListingExchange(listing.exchange);
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * What a listing the calendar has no date for says, once, under the table:
 * "VOW3:XETRA: no next report date on record; last reported 2026-10-29
 * (quarter ended 2026-09-30). Headlines: gloom news VOW3:XETRA". A listing
 * abroad whose company's US line, under the same symbol, has a date borrows it
 * as an estimate ("BHP:ASX: no next report date on record; ADR date 2026-11-04
 * (estimate)"); a US line that is another company (SAN:EPA is Sanofi, SAN in
 * New York is Banco Santander) lends nothing. With `lookup` false (a long
 * list) nothing is read and the line is the lead alone.
 */
export async function undatedListingNote(
  listing: Pick<CliListing, "symbol" | "exchange" | "key" | "request" | "saved">,
  deps: ListingDeps,
  { now = Date.now(), lookup = true }: { now?: number; lookup?: boolean } = {},
): Promise<string> {
  const lead = `${listing.key}: no next report date on record`;
  if (!lookup) return `${lead}.`;
  if (isListingAbroad(listing)) {
    const borrowed = await usLineDate(listing, deps, now);
    if (borrowed) return `${lead}; ADR date ${borrowed} (estimate)`;
  }
  const last = await lastReportOnRecord(deps.dataProvider, listing.request, listingDay(listing.request.exchange || listing.exchange, now));
  return `${listing.key}: ${noNextReportText(last)}. Headlines: gloom news ${commandWord(listing.key)}`;
}

/** The date of the same company's US line under the same symbol, YYYY-MM-DD, when the calendar has one to come. */
async function usLineDate(
  listing: Pick<CliListing, "symbol" | "exchange" | "key" | "request" | "saved">,
  deps: ListingDeps,
  now: number,
): Promise<string | null> {
  const quote = await loadListingQuote(deps.dataProvider, listing);
  const company = quote?.name?.trim() || listing.saved?.metadata.name?.trim() || null;
  const usLine = await usLineOfListing(listing, company, deps);
  if (!usLine || !deps.dataProvider.getEarningsCalendar) return null;
  const events = await deps.dataProvider.getEarningsCalendar([listing.symbol]).catch(logFailure("cli.earnings-calendar", "Read earnings calendar failed", []));
  const event = events.find((entry) => entry.symbol.toUpperCase() === listing.symbol.toUpperCase());
  if (!event || event.earningsDate.getTime() < now - DAY_MS) return null;
  return isoDate(event.earningsDate);
}

/**
 * "SAN = Banco Santander, NYSE (different companies on EPA, LSE)" for a bare symbol whose
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
