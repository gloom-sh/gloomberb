import { formatCalendarDay } from "../options/model-spot";
import { optionQuoteSession, quotedInSession } from "../shared/volatility/quote-session";
import { surfaceFilterSummary, totalSurfaceFilterCounts, type SurfaceSnapshot } from "./model";

export interface SurfaceQuoteCoverage {
  /** Settled with expiries read and not one clean quote among them. */
  empty: boolean;
  points: number;
  expiries: number;
  contracts: number;
  zeroBid: number;
  /** The cleaning filters that removed quotes, largest first. */
  removed: string | null;
  zeroBidMost: boolean;
  settled: boolean;
  fitted: boolean;
  /** The US session the quotes are from, the oldest loaded expiry's (YYYY-MM-DD). */
  session: string | null;
  /** The oldest quotes were taken in a regular session, so their zero bids are the market's, not the hour's. */
  inSession: boolean;
}

/** Whether a settled live chain produced any clean quote, with the filter counts that explain why not. */
export function surfaceQuoteCoverage(snapshot: SurfaceSnapshot | null | undefined): SurfaceQuoteCoverage {
  const expiries = snapshot?.expiries.filter((entry) => entry.state !== "loading") ?? [];
  const points = expiries.reduce((sum, entry) => sum + entry.points.length, 0);
  const contracts = expiries.reduce((sum, entry) => sum + Object.values(entry.filterCounts).reduce((a, b) => a + b, 0) + entry.points.length, 0);
  const counts = totalSurfaceFilterCounts(expiries);
  const zeroBid = counts["zero-bid"];
  const settled = !!snapshot && snapshot.loaded >= snapshot.requested;
  const asOf = expiries.map((entry) => entry.asOf).filter((value): value is string => !!value).sort()[0];
  return { empty: settled && expiries.length > 0 && points === 0 && contracts > 0, points, expiries: expiries.length, contracts, zeroBid,
    removed: surfaceFilterSummary(counts), zeroBidMost: Object.values(counts).every((count) => count <= zeroBid),
    settled, fitted: expiries.some((entry) => entry.fit), session: optionQuoteSession({ asOf }), inSession: quotedInSession(asOf) };
}

const ZERO_BID_HOURS = "The delayed feed publishes zero bids outside regular hours (09:30 to 16:00 New York).";
const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

/**
 * What a live surface with nothing fitted leads with: its quotes, not the
 * hour. Every expiry's failed the cleaning (`Quotes from Mon 23 Nov did not
 * pass cleaning`), or too few passed it to fit a smile. The cleaning keeps its
 * rules, and the next session's quotes may fail them too, so nothing here
 * promises a surface at the open.
 */
export function uncleanSurfaceTitle(coverage: Pick<SurfaceQuoteCoverage, "points" | "session">): string {
  const from = coverage.session ? ` from ${formatCalendarDay(coverage.session)}` : "";
  return coverage.points === 0 ? `Quotes${from} did not pass cleaning` : `Too few quotes${from} passed cleaning to fit a smile`;
}

/**
 * The counts behind it: `None of the 24 contracts across 1 expiry passes the
 * quote filters: 12 zero bid or ask, 12 wide spread.` Zero bids are put down
 * to the feed's hours only for quotes taken outside them.
 */
export function uncleanSurfaceDetail(coverage: SurfaceQuoteCoverage): string {
  const contracts = plural(coverage.contracts, "contract", "contracts");
  const expiries = plural(coverage.expiries, "expiry", "expiries");
  const hours = coverage.zeroBid && !coverage.inSession ? ` ${ZERO_BID_HOURS}` : "";
  if (coverage.points > 0) {
    return `${coverage.points.toLocaleString("en-US")} of the ${contracts} across ${expiries} pass the quote filters${
      coverage.removed ? `; removed: ${coverage.removed}` : ""}.`;
  }
  if (coverage.zeroBid === coverage.contracts) return `All ${contracts} across ${expiries} have a zero bid or ask.${hours}`;
  return `None of the ${contracts} across ${expiries} passes the quote filters${coverage.removed ? `: ${coverage.removed}` : ""}.${
    coverage.zeroBidMost ? hours : ""}`;
}
