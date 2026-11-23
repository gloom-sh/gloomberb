import type { Quote } from "../../types/financials";
import { futuresListingVenue } from "../../utils/futures-generic";
import { zonedDateTimeParts } from "../../utils/zoned-date-time";
import { hasPublishedFuturesCalendar, isPublishedFuturesClosure } from "../published-futures-sessions";
import { getPublishedUsEquitySession } from "../published-us-sessions";

const MS_PER_DAY = 86_400_000;
const CHICAGO = "America/Chicago";
const NEW_YORK = "America/New_York";

/**
 * One stretch of a trade date's trading, in minutes after local midnight. An
 * evening stretch opens the calendar day before its trade date (Sunday
 * evening's is Monday's) and runs to `close` on the trade date.
 */
interface TradingStretch {
  open: number;
  close: number;
  evening?: true;
}

/** A product's hours: the venue whose calendar dates its trade dates, the zone its hours are kept in, and its stretches. */
interface ProductHours {
  venue: string;
  timeZone: string;
  stretches: readonly TradingStretch[];
}

const hm = (hours: number, minutes = 0) => hours * 60 + minutes;
const dayOnly = (venue: string, timeZone: string, open: number, close: number): ProductHours =>
  ({ venue, timeZone, stretches: [{ open, close }] });

/**
 * CBOT grains and oilseeds: 19:00 to 07:45 Central from Sunday evening, a
 * pause, then 08:30 to 13:20, Monday to Friday.
 */
const GRAINS: ProductHours = {
  venue: "CBT",
  timeZone: CHICAGO,
  stretches: [{ open: hm(19), close: hm(7, 45), evening: true }, { open: hm(8, 30), close: hm(13, 20) }],
};
/** CME livestock: 08:30 to 13:05 Central, Monday to Friday. */
const LIVESTOCK = dayOnly("CME", CHICAGO, hm(8, 30), hm(13, 5));

/**
 * Contracts whose regular hours are shorter than CME Globex's whole day (17:00
 * to 16:00 Central), by root, as CME Group (cmegroup.com/trading-hours) and
 * ICE Futures U.S. (ice.com, softs; trading-sessions.ts keeps their opens)
 * publish them. Each trades nothing outside these hours, whatever state its
 * venue's quote carries.
 */
const PRODUCT_HOURS: Readonly<Record<string, ProductHours>> = {
  ZC: GRAINS, ZS: GRAINS, ZW: GRAINS, ZM: GRAINS, ZL: GRAINS, KE: GRAINS, ZO: GRAINS, ZR: GRAINS,
  LE: LIVESTOCK, GF: LIVESTOCK, HE: LIVESTOCK,
  LBR: dayOnly("CME", CHICAGO, hm(9), hm(15, 5)),
  KC: dayOnly("NYB", NEW_YORK, hm(4, 15), hm(13, 30)),
  SB: dayOnly("NYB", NEW_YORK, hm(3, 30), hm(13)),
  CC: dayOnly("NYB", NEW_YORK, hm(4, 45), hm(13, 30)),
  OJ: dayOnly("NYB", NEW_YORK, hm(8), hm(14)),
  CT: { venue: "NYB", timeZone: NEW_YORK, stretches: [{ open: hm(21), close: hm(14, 20), evening: true }] },
};

const isoDay = (day: number) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
const isWeekend = (day: number) => new Date(day * MS_PER_DAY).getUTCDay() % 6 === 0;

/** The trade date, as days since the epoch, whose stretch holds the local `day` and `minutes`; null between them. */
function tradeDayAt(hours: ProductHours, day: number, minutes: number): number | null {
  for (const stretch of hours.stretches) {
    const tradeDay = stretch.evening
      ? minutes >= stretch.open ? day + 1 : minutes < stretch.close ? day : null
      : minutes >= stretch.open && minutes < stretch.close ? day : null;
    if (tradeDay != null && !isWeekend(tradeDay)) return tradeDay;
  }
  return null;
}

/** A US holiday or early close, whose hours these products shorten or drop by notice. */
function isUsHolidayOrEarlyClose(date: string): boolean | null {
  const session = getPublishedUsEquitySession("NYSE", date);
  if (!session) return null;
  return session.kind === "closed" || zonedDateTimeParts(session.close, NEW_YORK).hour < 16;
}

/**
 * Whether a futures contract with its own shorter hours (grains and oilseeds,
 * livestock, lumber, ICE U.S. softs) is trading at `time`, by its product's
 * clock and not by its quote: CBOT corn reopens at 19:00 Central on Sunday,
 * two hours after CME Globex, coffee at 04:15 New York on Monday, and a quote
 * of either can read REGULAR from Globex's reopen. False outside its hours,
 * in its pauses, on a weekend, and on a trade date its venue's calendar
 * closes. Null for a contract that trades Globex's whole day or whose hours
 * are not known here, and, inside its hours, on a trade date the calendar
 * cannot vouch for (not published, or a US holiday or early close, whose
 * hours vary): the quote's own state says those.
 */
export function futuresProductOpen(symbol: string | undefined, exchange: string | undefined, time: number): boolean | null {
  if (!symbol || !Number.isFinite(time)) return null;
  const root = futuresListingVenue(symbol, exchange)?.root;
  const hours = root ? PRODUCT_HOURS[root] : undefined;
  if (!hours) return null;
  const { year, month, day, hour, minute } = zonedDateTimeParts(time, hours.timeZone);
  const tradeDay = tradeDayAt(hours, Date.UTC(year, month - 1, day) / MS_PER_DAY, hour * 60 + minute);
  if (tradeDay == null) return false;
  const tradeDate = isoDay(tradeDay);
  if (!hasPublishedFuturesCalendar(hours.venue, tradeDate)) return null;
  if (isPublishedFuturesClosure(hours.venue, tradeDate)) return false;
  return isUsHolidayOrEarlyClose(tradeDate) === false ? true : null;
}

/** Whether a quote's contract is shut by its product's own hours now (futuresProductOpen), whatever state the quote reports. */
export function isOutsideFuturesProductHours(quote: Pick<Quote, "symbol" | "listingExchangeName" | "exchangeName">, now: number): boolean {
  return futuresProductOpen(quote.symbol, quote.listingExchangeName || quote.exchangeName, now) === false;
}
