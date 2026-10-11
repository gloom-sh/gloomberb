import { createThrottledFetch } from "../../../utils/throttled-fetch";
import type { TreasuryAuction, TreasuryAuctionRaw } from "./types";

const BASE_URL =
  "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query";

/** The endpoint returns 114 columns per row; ask only for what the pane renders. */
const FIELDS = [
  "cusip",
  "security_type",
  "security_term",
  "auction_date",
  "high_investment_rate",
  "high_yield",
  "avg_med_yield",
  "high_price",
  "low_price",
  "avg_med_price",
  "bid_to_cover_ratio",
  "comp_accepted",
  "indirect_bidder_accepted",
  "direct_bidder_accepted",
  "primary_dealer_accepted",
  "total_accepted",
  "offering_amt",
  "inflation_index_security",
  "floating_rate",
  "high_discnt_margin",
  "high_discnt_rate",
  "avg_med_discnt_rate",
].join(",");

export const AUCTION_HISTORY_DAYS = 120;
/**
 * The feed holds roughly 400 auctions a year, so the default 120 days is one
 * page and the longest window (10 years, ~4,000 auctions) is four. One large
 * page costs about the same as a small one, so fewer, larger pages keep a
 * ten-year walk to a few seconds inside the throttle.
 */
const AUCTION_PAGE_SIZE = 1000;
/** Three times the longest window's pages; the bound only exists so bad metadata cannot loop. */
export const AUCTION_MAX_PAGES = 12;

const TREASURY_FETCH = createThrottledFetch({
  requestsPerMinute: 20,
  maxRetries: 2,
  timeoutMs: 15_000,
  backoffBaseMs: 800,
  defaultHeaders: { Accept: "application/json" },
});

function isoDateDaysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

/** `page[size]` brackets are percent-encoded; the API rejects some proxies otherwise. */
export function buildAuctionsUrl(sinceDays: number, now = Date.now(), page = 1): string {
  const params = [
    `fields=${FIELDS}`,
    `filter=auction_date:gte:${isoDateDaysAgo(sinceDays, now)}`,
    // The CUSIP breaks ties inside a date, so a page boundary that falls in the
    // middle of a day's auctions cannot repeat or skip one on the next page.
    "sort=-auction_date,-cusip",
    `page%5Bsize%5D=${AUCTION_PAGE_SIZE}`,
    `page%5Bnumber%5D=${page}`,
  ];
  return `${BASE_URL}?${params.join("&")}`;
}

/** Fiscal Data reports the page count as `meta["total-pages"]`. */
export function totalPages(body: unknown, page = 1): number {
  const meta = (body as { meta?: Record<string, unknown> } | null)?.meta;
  const value = meta?.["total-pages"];
  const pages = typeof value === "number" || (typeof value === "string" && value.trim())
    ? Number(value) : NaN;
  if (!Number.isSafeInteger(pages) || pages < 1) {
    throw new Error(`Treasury auction page ${page} has an invalid page count`);
  }
  return pages;
}

/** Fiscal Data sends missing metrics as the literal string "null". */
function toNumber(value: string | undefined | null): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeAuction(raw: unknown): TreasuryAuction | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as TreasuryAuctionRaw;
  const secType = (record.security_type ?? "").trim();
  const auctionDate = (record.auction_date ?? "").trim();
  const securityTerm = (record.security_term ?? "").trim();
  const cusip = (record.cusip ?? "").trim();
  if (!secType || !auctionDate) return null;

  return {
    // A reopening reuses its original CUSIP but is auctioned on its own date,
    // so CUSIP plus date is what keeps reopenings from collapsing into one row.
    id: cusip ? `${cusip}|${auctionDate}` : `${secType}|${auctionDate}|${securityTerm}`,
    cusip: cusip || null,
    // TIPS and FRNs are auctioned under the Note/Bond security type; their
    // yields are real yields and discount margins, not nominal yields.
    secType: record.inflation_index_security === "Yes" ? "TIPS" : record.floating_rate === "Yes" ? "FRN" : secType,
    securityTerm: securityTerm || "—",
    auctionDate,
    highInvestmentRate: toNumber(record.high_investment_rate),
    highDiscountRate: toNumber(record.high_discnt_rate),
    avgMedDiscountRate: toNumber(record.avg_med_discnt_rate),
    highDiscountMargin: toNumber(record.high_discnt_margin),
    highYield: toNumber(record.high_yield),
    avgMedYield: toNumber(record.avg_med_yield),
    highPrice: toNumber(record.high_price),
    lowPrice: toNumber(record.low_price),
    avgMedPrice: toNumber(record.avg_med_price),
    bidToCoverRatio: toNumber(record.bid_to_cover_ratio),
    competitiveAccepted: toNumber(record.comp_accepted),
    indirectAccepted: toNumber(record.indirect_bidder_accepted),
    directAccepted: toNumber(record.direct_bidder_accepted),
    primaryDealerAccepted: toNumber(record.primary_dealer_accepted),
    totalAccepted: toNumber(record.total_accepted),
    offeringAmount: toNumber(record.offering_amt),
  };
}

export function parseTreasuryAuctionsPayload(body: unknown): TreasuryAuction[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const auctions: TreasuryAuction[] = [];
  for (const raw of data) {
    const auction = normalizeAuction(raw);
    if (!auction || seen.has(auction.id)) continue;
    seen.add(auction.id);
    auctions.push(auction);
  }
  return auctions;
}

/**
 * Walks pages until the count reported by the first response is exhausted.
 * Pages overlap whenever an auction is announced mid-walk, so ids are deduped
 * across the whole run and not just within a payload.
 */
export async function fetchAuctionPages(
  loadPage: (page: number) => Promise<unknown>,
): Promise<TreasuryAuction[]> {
  const auctions: TreasuryAuction[] = [];
  const seen = new Set<string>();
  let pages = 1;

  for (let page = 1; page <= Math.min(pages, AUCTION_MAX_PAGES); page += 1) {
    const body = await loadPage(page);
    const declaredPages = totalPages(body, page);
    if (page === 1) pages = declaredPages;
    else if (declaredPages !== pages) {
      throw new Error(`Treasury auction page count changed on page ${page}`);
    }
    if (pages > AUCTION_MAX_PAGES) {
      throw new Error(`Treasury auction history exceeds the ${AUCTION_MAX_PAGES}-page limit`);
    }
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      throw new Error(`Treasury auction page ${page} has invalid data`);
    }
    if ((page > 1 || pages > 1) && data.length === 0) {
      throw new Error(`Treasury auction page ${page} is missing`);
    }
    // A declared page must be usable in full before any of the walk can be
    // cached. Missing metrics are valid; missing auction identities are not.
    if (data.some((raw) => !normalizeAuction(raw))) {
      throw new Error(`Treasury auction page ${page} has invalid records`);
    }
    for (const auction of parseTreasuryAuctionsPayload(body)) {
      if (seen.has(auction.id)) continue;
      seen.add(auction.id);
      auctions.push(auction);
    }
  }
  return auctions;
}

export async function fetchTreasuryAuctions(
  sinceDays: number = AUCTION_HISTORY_DAYS,
): Promise<TreasuryAuction[]> {
  const requestedAt = Date.now();
  return fetchAuctionPages(async (page) => {
    const response = await TREASURY_FETCH.fetch(buildAuctionsUrl(sinceDays, requestedAt, page));
    if (!response.ok) {
      throw new Error(`Treasury Fiscal Data request failed (${response.status})`);
    }
    return response.json();
  });
}
