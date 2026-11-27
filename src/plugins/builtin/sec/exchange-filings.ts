import type { ExchangeAnnouncementsPayload, ExchangeAnnouncementsRequest } from "../../../api-client/exchange-announcements";
import type { HeadlessPaneRow } from "../../../types/plugin";
import { exchangeAnnouncementsPublisher, exchangeAnnouncementsVenue, issuerFilingSuffixVenue, isRoutineReturn } from "../../../utils/exchange-announcements";
import { nonUsSecListingVenue } from "../../../utils/sec";

export const HKEX_FILING_HISTORY_LIMIT = 100;
export const PRESENTATIONS_FORM = "presentations";
export const RECENT_EXCHANGE_FILING_LIMIT = 50;

interface ExchangeFilingForm {
  value: string;
  label: string;
  kind: NonNullable<ExchangeAnnouncementsRequest["kind"]>;
}

const presentations: ExchangeFilingForm = { value: PRESENTATIONS_FORM, label: "Presentations", kind: PRESENTATIONS_FORM };
const hkexResults: ExchangeFilingForm = { value: "hkex-results", label: "Results", kind: "results" };

export function exchangeFilingForm(venue: string | undefined): ExchangeFilingForm | undefined {
  if (venue === "TWSE" || venue === "TPEX") return presentations;
  if (venue === "HKEX") return hkexResults;
  if (venue === "JPX" || venue === "SGX") return { value: `${venue.toLowerCase()}-results`, label: "Results & presentations", kind: "results" };
}

// The extended archives are bounded. The pane reveals their rows as the user scrolls.
export function exchangeFilingHistoryLimit(venue: string | undefined, kind?: ExchangeAnnouncementsRequest["kind"]): number {
  if (venue === "HKEX" && kind === "results") return HKEX_FILING_HISTORY_LIMIT;
  return kind || venue === "JPX" || venue === "BURSAMY" || venue === "HNX" || venue === "HOSE"
    ? 200 : RECENT_EXCHANGE_FILING_LIMIT;
}

export function localFilingListing(symbol: string, exchange?: string) {
  const venue = exchangeAnnouncementsVenue(nonUsSecListingVenue(symbol, exchange)
    ?? (!exchange ? issuerFilingSuffixVenue(symbol) : undefined));
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
