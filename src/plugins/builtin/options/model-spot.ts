import { getPublishedUsEquitySession } from "../../../market-data/published-us-sessions";
import type { OptionsChain, Quote } from "../../../types/financials";
import { zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";
import { optionQuoteValuationTime } from "../vol-surface/model";

/**
 * The underlying price and instant a chain's IV and Greeks are valued at
 * (docs/research-data.md#greeks-spot-and-time). The chain's quotes and the
 * spot belong to one moment:
 *
 * - when the quote carries the official close of the regular session the
 *   chain's quotes were taken in (a chain from the close, read before the next
 *   open or early in it), that close, at the chain's time;
 * - otherwise the underlying's latest price, at the chain's time once its
 *   quotes are over an hour old (outside the session) and now while they are
 *   current.
 *
 * So a pre-market print never moves the delta of a chain still quoting the
 * last close.
 */
export interface OptionModelSpot {
  price: number;
  /** When the price was observed: the session's close, or the quote's own time. */
  observedAt: number;
  /** The instant time to expiry is measured from. */
  valuationTime: number;
  /** `close`: the regular session's official close; `last`: the latest price. */
  basis: "close" | "last";
  /** The session the latest price is from, when it is not the regular one. */
  session: "pre-market" | "after hours" | "overnight" | null;
}

const newYorkDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function regularCloseTime(exchange: string | undefined, date: string): number {
  const session = getPublishedUsEquitySession(exchange || "NYSE", date);
  if (session?.kind === "session" && Number.isFinite(session.close)) return session.close;
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return zonedWallClockToUtcMs("America/New_York", year, month, day, 16, 0, 0);
}

/** The session a quote's price is from when it is not the regular one; null in the regular session or when nothing traded outside it. */
export function extendedSession(quote: Quote): OptionModelSpot["session"] {
  if (quote.overnightPrice != null && quote.price === quote.overnightPrice) return "overnight";
  if (quote.extendedSessionPrint === false) return null;
  if (quote.marketState === "PRE" || quote.marketState === "PREPRE") return "pre-market";
  if (quote.marketState === "POST" || quote.marketState === "POSTPOST") return "after hours";
  return null;
}

/** The spot the chain is valued at; null without a current underlying price. */
export function optionModelSpot(
  quote: Quote | null | undefined,
  chain: Pick<OptionsChain, "asOf"> | null | undefined,
  now: number,
  exchange?: string,
): OptionModelSpot | null {
  if (!quote || quote.stale === true || !positive(quote.price)) return null;
  const chainTime = chain?.asOf ? Date.parse(chain.asOf) : Number.NaN;
  const chainDate = Number.isFinite(chainTime) ? newYorkDate.format(chainTime) : null;
  if (chainDate && positive(quote.regularClose) && quote.regularCloseSessionDate === chainDate && chainTime <= now) {
    return { price: quote.regularClose, observedAt: regularCloseTime(exchange, chainDate), valuationTime: chainTime,
      basis: "close", session: null };
  }
  return { price: quote.price, observedAt: positive(quote.lastUpdated) ? quote.lastUpdated : now,
    valuationTime: optionQuoteValuationTime(chain ?? {}, now), basis: "last", session: extendedSession(quote) };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Fri 9 Oct` for a calendar date, YYYY-MM-DD. */
export function formatCalendarDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
}

/** `Mon 12 Oct 20:00 UTC`. */
export function formatSpotTime(time: number): string {
  const date = new Date(time);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.toISOString().slice(11, 16)} UTC`;
}

/** How a footer names the spot: `close Mon 12 Oct 20:00 UTC`, `pre-market Tue 13 Oct 12:21 UTC`, `last Tue 13 Oct 14:05 UTC`. */
export function modelSpotLabel(spot: Pick<OptionModelSpot, "basis" | "session" | "observedAt">): string {
  const word = spot.basis === "close" ? "close" : spot.session ?? "last";
  return `${word} ${formatSpotTime(spot.observedAt)}`;
}

/** A price to the cent, or to the tick it was quoted at below a dollar. */
export function formatModelSpotPrice(price: number): string {
  return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: price < 1 ? 4 : 2, useGrouping: false });
}
