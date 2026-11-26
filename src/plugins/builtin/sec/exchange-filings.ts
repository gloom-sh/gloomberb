import type { ExchangeAnnouncementsPayload } from "../../../api-client/exchange-announcements";
import type { HeadlessPaneRow } from "../../../types/plugin";
import { exchangeAnnouncementsPublisher, exchangeAnnouncementsVenue, isRoutineReturn } from "../../../utils/exchange-announcements";
import { nonUsSecListingVenue } from "../../../utils/sec";

// JPX sends a bounded issuer archive in one response. The pane reveals its rows as the user scrolls.
export const JPX_FILING_HISTORY_LIMIT = 200;

export function localFilingListing(symbol: string, exchange?: string) {
  const venue = exchangeAnnouncementsVenue(nonUsSecListingVenue(symbol, exchange)
    ?? (!exchange && /^[A-Z]{4}\.JK$/i.test(symbol) ? "JAKARTA" : null));
  const publisher = exchangeAnnouncementsPublisher(venue);
  return venue && publisher ? { symbol, exchange: venue, publisher } : null;
}

export function localFilingRows(payload: ExchangeAnnouncementsPayload, all: boolean) {
  return payload.announcements.filter(item => all || !isRoutineReturn(item)).map(item => ({
    filedAt: item.date, filing: item.headline, form: item.types.join(", ") || "Announcement",
    companyName: payload.name, url: item.url, source: item.publisher ?? exchangeAnnouncementsPublisher(payload.exchange) ?? payload.exchange,
    documentKey: item.documentKey,
    ...(item.dateBasis ? { dateBasis: item.dateBasis } : {}),
  }));
}

export function latestFilingRows(sec: HeadlessPaneRow[], local: ReturnType<typeof localFilingRows>, limit: number): HeadlessPaneRow[] {
  return [...sec.map(row => ({ ...row, source: "SEC EDGAR" })), ...local]
    .sort((left: HeadlessPaneRow, right: HeadlessPaneRow) => String(right.filedAt).localeCompare(String(left.filedAt)))
    .slice(0, limit);
}
