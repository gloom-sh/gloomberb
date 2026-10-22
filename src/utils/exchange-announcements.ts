import { listingSuffixExchange } from "../sources/listing-symbols";
import { canonicalExchange, parsePublicTickerKey } from "./exchanges";

/** Where a listing's company announcements are published: the venue's page for the company, or its disclosure search. */
export interface ExchangeAnnouncementsPage {
  /** "ASX announcements", "SEDAR+ filings": what the page is, for a reader. */
  name: string;
  url: string;
}

const EURONEXT = { name: "Euronext company news", url: "https://live.euronext.com/en/products/equities/company-news" };
const SEDAR = { name: "SEDAR+ filings", url: "https://www.sedarplus.ca/landingpage/" };
const NASDAQ_NORDIC = { name: "Nasdaq Nordic company news", url: "https://www.nasdaqomxnordic.com/news/companynews" };

/**
 * The page each venue abroad publishes its listed companies' announcements
 * on. A venue whose site has a page per company gets the company's page
 * (ASX, NZX); the others their regulator's or exchange's disclosure search,
 * where the company is found by name or code.
 */
const PAGES: Readonly<Record<string, (code: string) => ExchangeAnnouncementsPage>> = {
  ASX: (code) => ({ name: "ASX announcements", url: `https://www.asx.com.au/markets/trade-our-cash-market/announcements.${code.toLowerCase()}` }),
  // Cboe Australia trades ASX companies under their ASX codes.
  CXA: (code) => PAGES.ASX!(code),
  NZX: (code) => ({ name: "NZX announcements", url: `https://www.nzx.com/companies/${encodeURIComponent(code)}/announcements` }),
  TSX: () => SEDAR, TSXV: () => SEDAR, CSE: () => SEDAR, NEO: () => SEDAR,
  LSE: () => ({ name: "London Stock Exchange RNS", url: "https://www.londonstockexchange.com/news?tab=news-explorer" }),
  EPA: () => EURONEXT, AMS: () => EURONEXT, BRU: () => EURONEXT, LIS: () => EURONEXT, ISE: () => EURONEXT, OSL: () => EURONEXT, BIT: () => EURONEXT,
  SFB: () => NASDAQ_NORDIC, HEL: () => NASDAQ_NORDIC, CPH: () => NASDAQ_NORDIC, ICEX: () => NASDAQ_NORDIC,
  XETRA: () => ({ name: "Unternehmensregister", url: "https://www.unternehmensregister.de/" }),
  FWB2: () => PAGES.XETRA!(""),
  JPX: () => ({ name: "TDnet timely disclosures", url: "https://www.release.tdnet.info/inbs/I_main_00.html" }),
  HKEX: () => ({ name: "HKEXnews", url: "https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=en" }),
  KRX: () => ({ name: "DART filings", url: "https://dart.fss.or.kr/" }),
  KOSDAQ: () => PAGES.KRX!(""),
  TWSE: () => ({ name: "MOPS filings", url: "https://mops.twse.com.tw/mops/web/index" }),
  TPEX: () => PAGES.TWSE!(""),
  NSE: () => ({ name: "NSE corporate announcements", url: "https://www.nseindia.com/companies-listing/corporate-filings-announcements" }),
  BSE: () => ({ name: "BSE corporate announcements", url: "https://www.bseindia.com/corporates/ann.html" }),
  SGX: () => ({ name: "SGX company announcements", url: "https://www.sgx.com/securities/company-announcements" }),
  SET: () => ({ name: "SET company news", url: "https://www.set.or.th/en/market/news-and-alert/news" }),
};

/**
 * The announcements page for a listing on a venue abroad (GLO-1176): NST on
 * ASX is ASX's announcements page for NST, a TSX listing SEDAR+. Null for a
 * US venue and for a venue Gloom knows no page for.
 */
export function exchangeAnnouncementsPage(symbol: string, exchange: string | null | undefined): ExchangeAnnouncementsPage | null {
  const page = PAGES[canonicalExchange(exchange ?? "")];
  const code = symbol.trim().toUpperCase();
  return page && code ? page(code) : null;
}

/** Whether Gloom Cloud lists the company's announcements on this venue (ASX). */
export function listsExchangeAnnouncements(exchange: string | null | undefined): boolean {
  const venue = canonicalExchange(exchange ?? "");
  return venue === "ASX" || venue === "CXA";
}

/**
 * `exchangeAnnouncementsPage` for a listing as a pane or command names it:
 * NST:ASX, NST.AX, or NST with the venue beside it.
 */
export function listingAnnouncementsPage(key: string, exchange?: string | null): ExchangeAnnouncementsPage | null {
  const parsed = parsePublicTickerKey(key.trim());
  const suffixed = parsed.exchange ? null : listingSuffixExchange(parsed.symbol);
  const venue = parsed.exchange || suffixed || exchange;
  const symbol = suffixed ? parsed.symbol.replace(/\.[A-Z]+$/i, "") : parsed.symbol;
  return venue ? exchangeAnnouncementsPage(symbol, venue) : null;
}
