/**
 * The worldwide IPO calendar: deals merged from each venue's own listings,
 * as `GET /cloud/ipo/calendar` serves them. Public, so it works signed out.
 */

/** Where a deal is in its life. A deal moves forward, except to postponed or withdrawn. */
export type IpoStatus = "filed" | "upcoming" | "priced" | "listed" | "postponed" | "withdrawn";

export type IpoListingType = "ipo" | "spac" | "direct" | "reit" | "introduction" | "dual" | "other";

/** How sure the listing date is: a target, a date the venue has set, or the day it traded. */
export type IpoDateKind = "expected" | "confirmed" | "actual";

export type IpoRegion = "us" | "apac" | "europe" | "other";

/**
 * ISO 10383 MIC of a listing venue, such as `XNAS`, `XHKG` or `XTKS`. The
 * server adds venues over time, so any code may arrive.
 */
export type IpoMic = string;

export interface IpoFirstDay {
  /** The first session's venue-local date. */
  session: string;
  open: number | null;
  close: number;
  /** close / offerPrice - 1, as a fraction; null without an offer price. */
  returnPct: number | null;
}

export interface IpoDeal {
  /** Assigned when the deal is first seen and never changed. */
  id: string;
  company: string;
  /** The name in the local script when it differs from `company`. */
  companyLocal: string | null;
  /** The code as the venue prints it (`3750`, `7203`, `ARM`), null before one is assigned. */
  symbol: string | null;
  mic: IpoMic;
  /** The exchange code ticker keys use (`HKEX`, `JPX`, `NASDAQ`), null when unmapped. */
  exchange: string | null;
  /** Short venue name for a column: `Nasdaq`, `HKEX`, `Tokyo`, `LSE`, `Shanghai`. */
  venue: string;
  segment: string | null;
  /** ISO 3166 alpha-2 of the venue. */
  country: string;
  region: IpoRegion;
  /** IANA zone of the venue. */
  timezone: string;
  /** Venue-local calendar date, YYYY-MM-DD. */
  listingDate: string | null;
  dateKind: IpoDateKind | null;
  subscriptionOpen: string | null;
  subscriptionClose: string | null;
  /** ISO 4217 code of every price and size. Pence are `GBX`, not GBP. */
  currency: string | null;
  priceLow: number | null;
  priceHigh: number | null;
  offerPrice: number | null;
  sharesOffered: number | null;
  /** Money raised or to be raised, in `currency`. */
  offerSize: number | null;
  /** offerSize at the exchange rate of the day it was priced (or seen), then frozen. */
  offerSizeUsd: number | null;
  status: IpoStatus;
  listingType: IpoListingType;
  filedDate: string | null;
  firstDay: IpoFirstDay | null;
  updatedAt: string;
}

export interface IpoSourceHealth {
  id: string;
  /** Venues the source covers, so a client can say which markets are behind without naming the source. */
  mics: readonly IpoMic[];
  ok: boolean;
  /** Last successful fetch. */
  asOf: string | null;
}

export interface IpoCalendarPayload {
  asOf: string;
  deals: IpoDeal[];
  sources: IpoSourceHealth[];
}

/**
 * Narrows or moves the window. Without any, the server sends its default:
 * 90 days back to 180 ahead, filed and withdrawn deals left out, 500 at most.
 */
export interface IpoCalendarParams {
  region?: IpoRegion;
  status?: IpoStatus;
  /** First listing date, YYYY-MM-DD. */
  from?: string;
  /** Last listing date, YYYY-MM-DD. */
  to?: string;
  limit?: number;
}
