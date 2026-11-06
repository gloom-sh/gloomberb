import { ApiRequestError } from "../../../api-client/errors";
import { createThrottledFetch } from "../../../utils/throttled-fetch";
import type { TreasuryAuction } from "./types";

/**
 * TreasuryDirect's securities search lists every security announced or
 * auctioned, results included, as soon as Treasury posts them. Fiscal Data's
 * auction dataset is the fuller record but updates in batches and has stopped
 * updating for weeks at a time, so the board reads this beside it for the
 * auctions of the last weeks and the ones announced.
 */
const SEARCH_URL = "https://www.treasurydirect.gov/TA_WS/securities/search";

/**
 * How far back the search is read: wider than the longest stretch Fiscal Data
 * has been seen to lag, small enough to stay one request of about 90 KB
 * compressed (the search sends every field of a security; a year is ten times that).
 */
export const DIRECT_LOOKBACK_DAYS = 60;
/** Announced auctions are listed days to two weeks ahead; a month leaves none out. */
const DIRECT_LOOKAHEAD_DAYS = 30;

const DIRECT_FETCH = createThrottledFetch({
  requestsPerMinute: 20,
  maxRetries: 2,
  timeoutMs: 20_000,
  backoffBaseMs: 800,
  defaultHeaders: { Accept: "application/json" },
});

const isoDate = (time: number): string => new Date(time).toISOString().slice(0, 10);

/**
 * The days a board for `days` days of history reads from TreasuryDirect:
 * that many days back, no further than `DIRECT_LOOKBACK_DAYS`, up to a month
 * ahead. Both ends are inclusive.
 */
export function directSearchRange(days: number, now = Date.now()): { startDate: string; endDate: string } {
  return {
    startDate: isoDate(now - Math.min(days, DIRECT_LOOKBACK_DAYS) * 86_400_000),
    endDate: isoDate(now + DIRECT_LOOKAHEAD_DAYS * 86_400_000),
  };
}

export function buildDirectSearchUrl(days: number, now = Date.now()): string {
  const params = new URLSearchParams({
    ...directSearchRange(days, now),
    dateFieldName: "competitiveAuctionCloseDate",
    format: "json",
  });
  return `${SEARCH_URL}?${params}`;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** TreasuryDirect sends a figure an auction has not published as "" and every number as a string. */
function toNumber(value: unknown): number | null {
  const stated = text(value);
  if (!stated) return null;
  const parsed = Number(stated);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One security of the search as the board's auction, with the figures Fiscal
 * Data carries under the same names: a bill's discount and investment rates,
 * a note's, bond's or TIPS's high and median yield, an FRN's high discount
 * margin, the prices, bid-to-cover and the competitive awards. The id is
 * Fiscal Data's (CUSIP and auction date), so one auction in both feeds is one
 * row. Null for a record without a CUSIP, a type or the day bidding closes.
 */
export function normalizeDirectAuction(raw: unknown): TreasuryAuction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const cusip = text(record.cusip);
  const auctionDate = /^\d{4}-\d{2}-\d{2}/.exec(text(record.competitiveAuctionCloseDate))?.[0];
  // Bill, Note or Bond: Treasury's own `type` splits out CMBs (a bill here, as Fiscal Data has them), FRNs and TIPS.
  const securityType = text(record.securityType);
  if (!cusip || !auctionDate || !securityType) return null;
  const bill = securityType === "Bill";
  return {
    id: `${cusip}|${auctionDate}`,
    cusip,
    secType: text(record.inflationProtected) === "Yes" ? "TIPS" : text(record.floatingRate) === "Yes" ? "FRN" : securityType,
    securityTerm: text(record.securityTerm) || "—",
    auctionDate,
    highInvestmentRate: toNumber(record.investmentRate),
    // A bill's `highRate` is its discount rate; a note or bond states its coupon elsewhere.
    highDiscountRate: bill ? toNumber(record.highRate) : null,
    avgMedDiscountRate: bill ? toNumber(record.medianRate) : null,
    highDiscountMargin: toNumber(record.highDiscountMargin),
    highYield: toNumber(record.highYield),
    avgMedYield: toNumber(record.medianYield),
    highPrice: toNumber(record.highPrice),
    lowPrice: toNumber(record.lowPrice),
    avgMedPrice: toNumber(record.averagePrice),
    bidToCoverRatio: toNumber(record.bidToCoverRatio),
    competitiveAccepted: toNumber(record.subtotalCompetitiveParAwardedInsideOfOfferingAmount),
    indirectAccepted: toNumber(record.indirectBiddersCompetitiveParAwarded),
    directAccepted: toNumber(record.directBiddersCompetitiveParAwarded),
    primaryDealerAccepted: toNumber(record.primaryDealersCompetitiveParAwarded),
    totalAccepted: toNumber(record.grandTotalParAwarded),
    offeringAmount: toNumber(record.offeringAmount),
  };
}

/**
 * The auctions of a search response, each once. A body that is not a list of
 * securities is a failure (an error page, a changed endpoint), never a quiet
 * period; a record it cannot identify is skipped.
 */
export function parseDirectAuctions(body: unknown): TreasuryAuction[] {
  if (!Array.isArray(body)) throw new Error("TreasuryDirect securities search did not return a list of securities");
  const auctions = new Map<string, TreasuryAuction>();
  for (const raw of body) {
    const auction = normalizeDirectAuction(raw);
    if (auction && !auctions.has(auction.id)) auctions.set(auction.id, auction);
  }
  return [...auctions.values()];
}

/** The auctions of the last `days` days (at most `DIRECT_LOOKBACK_DAYS`) and the ones announced. */
export async function fetchDirectAuctions(days: number): Promise<TreasuryAuction[]> {
  const response = await DIRECT_FETCH.fetch(buildDirectSearchUrl(days));
  // The status stays: an overloaded server is a failure a saved board may answer for, a refusal is not.
  if (!response.ok) throw new ApiRequestError(`TreasuryDirect request failed (${response.status})`, response.status);
  return parseDirectAuctions(await response.json());
}
