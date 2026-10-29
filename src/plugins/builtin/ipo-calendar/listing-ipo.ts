import { apiClient } from "../../../api-client";
import type { IpoDeal } from "../../../api-client/ipo";
import type { HeadlessPaneApiClient } from "../../../types/plugin";
import { canonicalExchange } from "../../../utils/exchanges";
import { fetchIpoCalendar } from "./client";
import {
  formatIpoAmount,
  formatIpoPrice,
  formatIpoReturn,
  ipoLockupBasis,
  ipoLockupText,
  ipoReturnSince,
  ipoTickerKey,
  isLockupStory,
} from "./model";

/** How far back a listing's IPO is looked for: the calendar keeps a year, and a lock-up runs about half of one. */
const IPO_LOOKBACK_DAYS = 400;
const LOCKUP_NEWS_LIMIT = 3;

/** A lock-up story filed under a listing: its headline, publisher and day. */
export interface IpoLockupStory {
  title: string;
  source: string;
  publishedAt: string;
  url: string;
}

/** The stories filed under a listing about its lock-up since it listed (an early release, a waiver), newest first. */
export async function loadIpoLockupNews(
  client: Pick<HeadlessPaneApiClient, "searchCloudNews">,
  deal: IpoDeal,
): Promise<IpoLockupStory[]> {
  const key = ipoTickerKey(deal);
  if (!key || !deal.lockup) return [];
  const response = await client.searchCloudNews("lock-up", 20, undefined, { tickers: [key] });
  const since = deal.listingDate ?? deal.firstDay?.session ?? "";
  return response.items
    .map((item) => ({
      title: item.headline,
      source: item.primaryPublisher || item.primarySource,
      publishedAt: item.lastPublishedAt || item.firstPublishedAt,
      url: item.primaryUrl,
    }))
    .filter((story) => isLockupStory(story.title) && story.publishedAt.slice(0, 10) >= since)
    .slice(0, LOCKUP_NEWS_LIMIT);
}

function shiftDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The IPO a listing came to market with in the last year or so, from the
 * IPO calendar: the deal listed under its symbol on its exchange. Null for a
 * listing older than that, one the calendar does not have, or one whose
 * symbol two deals on its exchange share.
 */
export async function loadListingIpo(
  client: Pick<HeadlessPaneApiClient, "getCloudIpoCalendar">,
  listing: { symbol: string; exchange?: string | null },
  { signal, now = new Date() }: { signal?: AbortSignal; now?: Date } = {},
): Promise<IpoDeal | null> {
  const symbol = listing.symbol.trim().toUpperCase();
  if (!symbol) return null;
  const today = now.toISOString().slice(0, 10);
  const payload = await fetchIpoCalendar(client, signal, { q: symbol, from: shiftDays(today, -IPO_LOOKBACK_DAYS), to: today });
  const exchange = listing.exchange ? canonicalExchange(listing.exchange) : "";
  const deals = payload.deals.filter((deal) => (deal.status === "listed" || deal.status === "priced")
    && deal.symbol?.toUpperCase() === symbol
    && (!exchange || (deal.exchange != null && canonicalExchange(deal.exchange) === exchange)));
  return deals.length === 1 ? deals[0]! : null;
}

/**
 * A deal's IPO in rows of a report, label and text:
 * - IPO date  2026-05-07 on NYSE
 * - Offer     $26 (or "direct listing, no offer price")
 * - Since IPO +62.7% ($26 to $42.30)
 * - Lockup    lockup ends ~2026-11-02 (estimate)
 */
export function ipoMetricRows(deal: IpoDeal, price: number | null | undefined, now = new Date()): Array<[string, string]> {
  const day = deal.listingDate ?? deal.firstDay?.session ?? null;
  const rows: Array<[string, string]> = [];
  if (day) rows.push(["IPO date", `${day}${deal.venue ? ` on ${deal.venue}` : ""}`]);
  rows.push(["Offer", formatIpoPrice(deal, { full: true })]);
  const since = ipoReturnSince(deal, price);
  if (since) {
    const from = since.basis === "offer" ? formatIpoAmount(deal, since.from) : `first trade ${formatIpoAmount(deal, since.from)}`;
    rows.push(["Since IPO", `${formatIpoReturn(since.returnPct)} (${from} to ${formatIpoAmount(deal, price!)})`]);
  }
  const lockup = ipoLockupText(deal, now);
  if (lockup) rows.push(["Lockup", lockup.replace(/^lockup /, "")]);
  return rows;
}

/** The lines under those rows: what the lock-up estimate counts from, then the lock-up stories. */
export function ipoDetailNotes(deal: IpoDeal, news: readonly IpoLockupStory[]): string[] {
  const basis = ipoLockupBasis(deal);
  return [
    ...basis ? [`Lockup estimate: ${basis}; underwriters can release shares early.`] : [],
    ...news.map((story) => `Lock-up news ${story.publishedAt.slice(0, 10)}: ${story.title} (${story.source})`),
  ];
}

/**
 * A deal's IPO in sentences, for a report's notes:
 * - "HAWK listed 2026-05-07 on NYSE at a $26 offer price; $42.30 now, +62.7% since the IPO."
 * - "GYGY listed 2026-07-30 on Nasdaq: direct listing, no offer price; $30.10 now, +33.8% since the first trade at $22.50."
 * - "HAWK lockup ends ~2026-11-02 (estimate): 180 days from the prospectus dated 2026-05-06; underwriters can release shares early."
 * - "Lock-up news 2026-08-31: HawkEye 360 Confirms Early Lock-up Release for September 2nd (PR Newswire)"
 */
export function ipoDetailSentences(deal: IpoDeal, price: number | null | undefined, news: readonly IpoLockupStory[], now = new Date()): string[] {
  const name = deal.symbol ?? deal.company;
  const day = deal.listingDate ?? deal.firstDay?.session ?? null;
  const listed = deal.status === "listed" ? "listed" : "prices to list";
  const where = `${day ? ` ${day}` : ""}${deal.venue ? ` on ${deal.venue}` : ""}`;
  const offer = deal.offerPrice != null ? ` at a ${formatIpoAmount(deal, deal.offerPrice)} offer price`
    : deal.listingType === "direct" ? `: ${formatIpoPrice(deal, { full: true })}` : "";
  // The table's Return is the first day's; the sentence says which is which.
  const firstDay = deal.firstDay?.returnPct != null && deal.offerPrice != null
    ? `, ${formatIpoReturn(deal.firstDay.returnPct)} on the first day` : "";
  const since = ipoReturnSince(deal, price);
  const priceNow = since ? `; ${formatIpoAmount(deal, price!)} now, ${formatIpoReturn(since.returnPct)} since ${
    since.basis === "offer" ? "the IPO" : `the first trade at ${formatIpoAmount(deal, since.from)}`}` : "";
  const lockup = ipoLockupText(deal, now);
  const basis = ipoLockupBasis(deal);
  return [
    `${name} ${listed}${where}${offer}${firstDay}${priceNow}.`,
    ...lockup ? [`${name} ${lockup}${basis ? `: ${basis}` : ""}; underwriters can release shares early.`] : [],
    ...news.map((story) => `Lock-up news ${story.publishedAt.slice(0, 10)}: ${story.title} (${story.source})`),
  ];
}

/** A listing's recent IPO and its lock-up news, as `ticker` reads them beside the rest. */
export interface TickerIpo {
  deal: IpoDeal;
  news: IpoLockupStory[];
}

/** How long `ticker` waits for the IPO calendar before leaving the section out. */
const TICKER_IPO_WAIT_MS = 6_000;

/**
 * A stock's IPO of the last year or so with its lock-up news, for `ticker`;
 * null for any other listing, and when the calendar does not answer in time.
 */
export async function loadTickerIpo(
  listing: { symbol: string; exchange?: string | null },
  client: Pick<HeadlessPaneApiClient, "getCloudIpoCalendar" | "searchCloudNews"> = apiClient,
): Promise<TickerIpo | null> {
  const signal = AbortSignal.timeout(TICKER_IPO_WAIT_MS);
  const deal = await loadListingIpo(client, listing, { signal });
  if (!deal) return null;
  const news = await loadIpoLockupNews(client, deal).catch(() => {
    // Intentional ignore: the IPO's rows stand without its lock-up news.
    return [];
  });
  return { deal, news };
}
