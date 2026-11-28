import { listingSuffixExchange } from "../sources/listing-symbols";
import { canonicalExchange, parsePublicTickerKey, typedExchangeVenue } from "./exchanges";
import { nonUsSecListingVenue } from "./sec";

/** Where a listing's company announcements are published: the venue's page for the company, or its disclosure search. */
export interface ExchangeAnnouncementsPage {
  /** "ASX announcements", "SEDAR+ filings": what the page is, for a reader. */
  name: string;
  url: string;
}

const EURONEXT = { name: "Euronext company news", url: "https://live.euronext.com/en/products/equities/company-news" };
const SEDAR = { name: "SEDAR+ filings", url: "https://www.sedarplus.ca/landingpage/" };
const NASDAQ_NORDIC = { name: "Nasdaq Nordic company news", url: "https://www.nasdaqomxnordic.com/news/companynews" };
const IDX_ALIASES = new Set(["IDX", "XIDX", "JKT"]);

export function exchangeAnnouncementsVenue(exchange?: string | null): string {
  const venue = typedExchangeVenue(exchange ?? undefined) ?? canonicalExchange(exchange ?? undefined);
  return IDX_ALIASES.has(venue) ? "JAKARTA" : venue;
}

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
  HNX: (code) => ({ name: "Hanoi Stock Exchange issuer disclosures", url: `https://www.hnx.vn/cophieu-etfs/chi-tiet-chung-khoan-ny-${encodeURIComponent(code.toLowerCase())}.html?_des_tab=3` }),
  HOSE: () => ({ name: "Ho Chi Minh Stock Exchange issuer disclosures", url: "https://www.hsx.vn/vi/tin-tuc/tin-to-chuc-niem-yet" }),
  JAKARTA: () => ({ name: "Indonesia Stock Exchange disclosures", url: "https://www.idx.id/en/listed-companies/disclosure" }),
  XPHS: () => ({ name: "Philippine Stock Exchange company announcements", url: "https://edge.pse.com.ph/announcements/form.do" }),
  JPX: () => ({ name: "TDnet timely disclosures", url: "https://www.release.tdnet.info/inbs/I_main_00.html" }),
  HKEX: () => ({ name: "HKEXnews", url: "https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=en" }),
  SWX: () => ({ name: "SIX Swiss Exchange", url: "https://www.six-group.com/en/market-data/news-tools/equity-issuer-news.html" }),
  KRX: () => ({ name: "DART filings", url: "https://dart.fss.or.kr/" }),
  KOSDAQ: () => PAGES.KRX!(""),
  TWSE: () => ({ name: "MOPS filings", url: "https://doc.twse.com.tw/server-java/t57sb01" }),
  TPEX: () => PAGES.TWSE!(""),
  NSE: () => ({ name: "NSE corporate announcements", url: "https://www.nseindia.in/companies-listing/corporate-filings-announcements" }),
  BSE: () => ({ name: "BSE corporate announcements", url: "https://www.bseindia.com/corporates/ann.html" }),
  BURSAMY: () => ({ name: "Bursa Malaysia company announcements", url: "https://www.bursamalaysia.com/market_information/announcements/company_announcement" }),
  SSE: () => ({ name: "CNINFO filings", url: "https://www.cninfo.com.cn/new/index" }),
  SZSE: () => PAGES.SSE!(""),
  SGX: () => ({ name: "SGX company announcements", url: "https://www.sgx.com/securities/company-announcements" }),
  SET: () => ({ name: "SET company news", url: "https://www.set.or.th/en/market/news-and-alert/news" }),
  // The Public Disclosure Platform, where every Borsa Istanbul company files its disclosures.
  BIST: () => ({ name: "KAP disclosures", url: "https://www.kap.org.tr/en/bildirim-sorgu" }),
};

export function issuerFilingSuffixVenue(symbol: string): string | undefined {
  if (/^\d{4}\.KL$/i.test(symbol)) return "BURSAMY";
  if (/^[A-Z]{4}\.JK$/i.test(symbol)) return "JAKARTA";
  if (/^[A-Z0-9][A-Z0-9&-]*\.BK$/i.test(symbol)) return "SET";
  return nonUsSecListingVenue(symbol) ?? undefined;
}

/** The overseas venue's disclosure page, when the listing has one. */
function exchangeAnnouncementsPage(symbol: string, exchange: string | null | undefined): ExchangeAnnouncementsPage | null {
  const page = PAGES[exchangeAnnouncementsVenue(exchange)];
  const code = symbol.trim().toUpperCase();
  return page && code ? page(code) : null;
}

const PUBLISHERS: Readonly<Record<string, string>> = {
  TWSE: "MOPS", TPEX: "MOPS",
  BURSAMY: "Bursa Malaysia",
  JAKARTA: "Indonesia Stock Exchange",
  XPHS: "Philippine Stock Exchange",
  ASX: "ASX", CXA: "ASX", HKEX: "HKEXnews", SWX: "SIX Swiss Exchange", NSE: "NSE", SET: "SET",
  JPX: "TDnet", HNX: "HNX", HOSE: "HOSE", KRX: "DART", KOSDAQ: "DART", SGX: "SGX", SSE: "CNINFO", SZSE: "CNINFO",
};

/**
 * Who publishes the announcements Gloom Cloud lists for a listing on this
 * venue, as a source line names them: "ASX" (and Cboe Australia's, which
 * trade under ASX codes), "HKEXnews". Null for a venue it lists none for.
 */
export function exchangeAnnouncementsPublisher(exchange: string | null | undefined): string | null {
  const venue = exchangeAnnouncementsVenue(exchange);
  return PUBLISHERS[venue] ?? null;
}

/** Whether Gloom Cloud lists the company's announcements on this venue (ASX, HKEX). */
export function listsExchangeAnnouncements(exchange: string | null | undefined): boolean {
  return exchangeAnnouncementsPublisher(exchange) != null;
}

/**
 * HKEXnews' routine returns: a buyback's or a share issue's next day
 * disclosure, and the monthly return of movements in securities. A company
 * buying back shares files one each trading day, so they bury its results
 * and business updates; `filings` leaves them out unless --all.
 */
const ROUTINE_RETURNS = new Set(["Next Day Disclosure Returns", "Monthly Returns"]);

const ISSUER_RESULTS_PAGES: Readonly<Record<string, string>> = {
  "RHM:XETRA": "https://www.rheinmetall.com/en/investor-relations/publications/financial-publications-and-presentations",
};

export function isRoutineReturn(item: { category?: string | null }): boolean {
  return item.category != null && ROUTINE_RETURNS.has(item.category);
}

/**
 * `exchangeAnnouncementsPage` for a listing as a pane or command names it:
 * NST:ASX, NST.AX, or NST with the venue beside it.
 */
export function listingAnnouncementsPage(key: string, exchange?: string | null): ExchangeAnnouncementsPage | null {
  const parsed = parsePublicTickerKey(key.trim());
  const suffixed = parsed.exchange ? null : listingSuffixExchange(parsed.symbol) ?? issuerFilingSuffixVenue(parsed.symbol);
  const venue = parsed.exchange || suffixed || exchange;
  const symbol = suffixed ? parsed.symbol.replace(/\.[A-Z]+$/i, "") : parsed.symbol;
  const issuerPage = !listsExchangeAnnouncements(venue) && ISSUER_RESULTS_PAGES[`${symbol.toUpperCase()}:${canonicalExchange(venue ?? "")}`];
  return issuerPage ? { name: "Company results", url: issuerPage } : venue ? exchangeAnnouncementsPage(symbol, venue) : null;
}
