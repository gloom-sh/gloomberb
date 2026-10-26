import { canonicalExchange, isUsListingExchange } from "../../utils/exchanges";
import {
  activeUsMarketSession,
  isAlwaysOpenExchange,
  isRegularSessionTime,
  latestRegularSessionClose,
  latestRegularSessionOpen,
  nextRegularSessionOpen,
} from "../../market-data/market/freshness";
import { futuresWeekendClosure } from "../../market-data/market/futures-week";
import { currentFxClosureStart, isFxMarketOpen } from "../../utils/fx-market-hours";
import { zonedDateKey } from "../../utils/zoned-date-time";
import type { ReportTime } from "../../utils/utc-time";
import type { QuoteIndexSession } from "../../types/financials";

/** Where the venues behind a quote report stand, as a report says it after the delay. */
type ReportMarketState = "open" | "pre-market" | "after-hours" | "closed";

export interface ReportMarket {
  state: ReportMarketState;
  /** While no venue is in its regular session: the next regular open of the first to open, when its calendar is known. */
  reopensAt?: string;
  /** That open's date at its venue, so a Monday open in Sydney reads Monday. */
  reopensOn?: string;
  /**
   * The reopen is the week's first trade (a futures venue's Sunday evening),
   * not a regular session's open: `reopens 22:00 UTC`, never a session's name.
   */
  firstTrade?: true;
}

/** One dated row of a quote report: the venue it trades on and the session its source reports. */
export interface SessionObservation {
  exchange: string;
  marketState?: string;
  time: ReportTime | null;
  /** The regular sessions an index quote carries, for a publisher the app has no calendar for. */
  calendar?: QuoteIndexSession;
}

interface VenueSession {
  state: ReportMarketState | "always";
  next?: { date: string; open: number; firstTrade?: true };
  /** The latest regular session that has closed: its local date and open. */
  last?: { date: string; open: number | null };
  timeZone?: string;
  /** The sessions are the quote's own, not a calendar of the venue. */
  quoted?: true;
}

const CLOSED_STATES = new Set(["CLOSED", "PREPRE", "POSTPOST"]);
const US_EXCHANGE_TIME_ZONE = "America/New_York";

/**
 * A venue's session now, from its calendar (weekends and published holidays),
 * or from the state its source reports when the app has no calendar for it,
 * such as an index publisher or a futures exchange (whose weekend gap it
 * knows); an index quote that states none is placed on the sessions it
 * carries. Null when none of them says.
 */
function venueSession(exchange: string, marketState: string | undefined, now: number, calendar?: QuoteIndexSession): VenueSession | null {
  if (isAlwaysOpenExchange(exchange)) return { state: "always" };
  // Spot FX trades its week, Sunday 17:00 to Friday 17:00 New York, by the clock as an exchange rate's line has it.
  // A source's own state is not its week: Yahoo stamps a pair CLOSED from that open to London's midnight, which read
  // `markets closed` beside `fx`'s `markets open` for the same pair.
  if (exchange === FX_VENUE) return { state: isFxMarketOpen(now) ? "open" : "closed" };
  const next = nextRegularSessionOpen(exchange, now);
  if (next) {
    const { timeZone } = next;
    const latestClose = latestRegularSessionClose(exchange, now);
    const last = latestClose ? { date: latestClose.date, open: latestRegularSessionOpen(exchange, latestClose.close) } : undefined;
    if (isRegularSessionTime(exchange, now)) return { state: "open", timeZone };
    if (isUsListingExchange(exchange)) {
      const today = zonedDateKey(now, timeZone);
      const session = activeUsMarketSession(now);
      if (session === "PRE" && next.date === today) return { state: "pre-market", next, last, timeZone };
      if (session === "POST" && last?.date === today) return { state: "after-hours", next, last, timeZone };
    }
    return { state: "closed", next, last, timeZone };
  }
  // A futures venue's weekend gap closes every contract, so it outranks the state a quote stamped before the Friday close.
  const weekend = futuresWeekendClosure(exchange, now);
  if (weekend) return { state: "closed", ...(weekend.reopensAt != null && weekend.reopensOn ? { next: { date: weekend.reopensOn, open: weekend.reopensAt, firstTrade: true as const } } : {}) };
  if (marketState === "REGULAR") return { state: "open" };
  const stated = marketState === "PRE" ? "pre-market" : marketState === "POST" ? "after-hours" : marketState && CLOSED_STATES.has(marketState) ? "closed" : null;
  if (!calendar) return stated ? { state: stated } : null;
  const state = stated ?? quotedState(calendar, now);
  return state ? { state, ...quotedSessions(calendar, now) } : null;
}

/**
 * Where an index quote's own sessions put the market now, for a quote that
 * states no session. Before the open it is pre-market on the day of the open,
 * as the venue calendars have it, and closed on any earlier day (a weekend, a holiday).
 */
function quotedState({ timeZone, current, regular }: QuoteIndexSession, now: number): ReportMarketState | null {
  if (now >= current.end) return "closed";
  if (now >= current.start) return "open";
  // A regular session still running is not today's: the sessions disagree, so say nothing.
  if (regular.some((window) => window.end > now)) return null;
  return zonedDateKey(now, timeZone) === zonedDateKey(current.start, timeZone) ? "pre-market" : "closed";
}

/**
 * An index publisher's sessions (SNP, DJI, NASDAQ GIDS) as its quote dates
 * them, read like a venue's calendar: the open still to come, and the latest
 * regular session that has closed.
 */
function quotedSessions({ timeZone, current, regular }: QuoteIndexSession, now: number): Pick<VenueSession, "next" | "last" | "timeZone" | "quoted"> {
  const closed = [...regular, current].filter((window) => window.end <= now).sort((left, right) => right.end - left.end)[0];
  return {
    timeZone,
    quoted: true,
    ...(current.start > now ? { next: { date: zonedDateKey(current.start, timeZone), open: current.start } } : {}),
    ...(closed ? { last: { date: zonedDateKey(closed.start, timeZone), open: closed.start } } : {}),
  };
}

/** The venue spot FX pairs trade on. It has no session calendar here; its week is in `fx-market-hours`. */
const FX_VENUE = "CCY";
const DAY_MS = 24 * 60 * 60_000;

/**
 * The newest observation is its venue's latest close: the venue has not
 * opened since, and the print is from that session's day, after its open (an
 * after-hours print of that day counts). Returns that session's local date.
 */
function closeDateOf(observation: SessionObservation, session: VenueSession, now: number): string | null {
  const time = observation.time;
  if (!time || time.dateOnly) return null;
  // FX closes once a week, Friday 17:00 New York time, and its trading day turns
  // at 17:00: a print from that last day, after Thursday's 17:00 close through
  // Friday's, is that Friday's close. A tick after it, over the weekend, is no
  // price of the week and keeps its own time.
  const weekClose = canonicalExchange(observation.exchange) === FX_VENUE ? currentFxClosureStart(now) : null;
  if (weekClose != null) {
    return time.time > weekClose - DAY_MS && time.time <= weekClose ? zonedDateKey(weekClose - 1, "America/New_York") : null;
  }
  if (session.last && session.timeZone) {
    if (session.last.open != null && time.time < session.last.open) return null;
    return zonedDateKey(time.time, session.timeZone) === session.last.date ? session.last.date : null;
  }
  // No calendar: the source says the session is over, and the print is dated in UTC.
  return session.state === "closed" && !session.last ? new Date(time.time).toISOString().slice(0, 10) : null;
}

/**
 * Whose trading day a close on this venue is: `US` for the US listing venues,
 * which share one calendar, `FX` for currency pairs, whose day turns in New
 * York, the venue's code elsewhere. Null when no calendar dates it and the
 * close is only a UTC date.
 */
function closeMarketOf(exchange: string, session: VenueSession): string | null {
  if (exchange === FX_VENUE) return "FX";
  if (!session.last || !session.timeZone) return null;
  // An index publisher's name is no market: a session dated in New York is the US's, any other is a bare date.
  if (session.quoted) return session.timeZone === US_EXCHANGE_TIME_ZONE ? "US" : null;
  return isUsListingExchange(exchange) ? "US" : exchange;
}

/** One market's session behind a report that mixes markets: its local date, and whether that session has closed. */
export interface VenueSessionDate {
  /** `US` for the US listing venues, which share one calendar, the venue's code elsewhere (`XETRA`, `EPA`). */
  market: string;
  /** The session's local date, `YYYY-MM-DD`. */
  date: string;
  /** The newest row on that market is its latest close. */
  close: boolean;
}

/**
 * Each market's session, for a report whose rows trade on more than one
 * (a US line beside Xetra and Paris ones): the newest row of each, dated in
 * its venue's own day, in the order the markets first appear. Empty when the
 * rows share one market, or fewer than two can be placed.
 */
export function reportVenueSessionDates(observations: readonly SessionObservation[], now: number): VenueSessionDate[] {
  const newestByMarket = new Map<string, { observation: SessionObservation & { time: ReportTime }; session: VenueSession }>();
  for (const observation of observations) {
    const exchange = canonicalExchange(observation.exchange);
    const time = observation.time;
    if (!exchange || !time) continue;
    const session = venueSession(exchange, observation.marketState, now);
    if (!session || session.state === "always") continue;
    const market = exchange === FX_VENUE ? "FX" : isUsListingExchange(exchange) ? "US" : exchange;
    const current = newestByMarket.get(market);
    if (!current || time.time > current.observation.time.time) newestByMarket.set(market, { observation: { ...observation, time }, session });
  }
  if (newestByMarket.size < 2) return [];
  return [...newestByMarket].map(([market, { observation, session }]) => {
    // A venue in its session whose newest row is from an earlier day has not printed today: that row is its last close.
    const exchange = canonicalExchange(observation.exchange);
    const latestClose = session.state === "open" && session.timeZone ? latestRegularSessionClose(exchange, now) : null;
    const last = latestClose ? { date: latestClose.date, open: latestRegularSessionOpen(exchange, latestClose.close) } : session.last;
    const closeDate = closeDateOf(observation, { ...session, last }, now);
    const date = closeDate
      ?? (session.timeZone ? zonedDateKey(observation.time.time, session.timeZone) : new Date(observation.time.time).toISOString().slice(0, 10));
    return { market, date, close: closeDate != null };
  });
}

/**
 * Where the markets behind a quote report stand now, and whether the newest
 * observation is a close, and whose. Null market when the venues disagree
 * (Tokyo open, New York closed), trade around the clock, or none can be
 * placed; a report then says nothing rather than guess.
 */
export function reportMarketSession(
  observations: readonly SessionObservation[],
  now: number,
): { market: ReportMarket | null; closeDate: string | null; closeMarket: string | null } {
  const sessions = new Map<string, VenueSession>();
  let newest: { observation: SessionObservation; session: VenueSession; exchange: string } | null = null;
  for (const observation of observations) {
    const exchange = canonicalExchange(observation.exchange);
    if (!exchange) continue;
    const key = `${exchange}:${observation.marketState ?? ""}`;
    const session = sessions.get(key) ?? venueSession(exchange, observation.marketState, now, observation.calendar);
    if (!session) continue;
    sessions.set(key, session);
    if (observation.time && (!newest || observation.time.time > (newest.observation.time?.time ?? -Infinity))) {
      newest = { observation, session, exchange };
    }
  }
  const states = new Set([...sessions.values()].map((session) => session.state));
  if (states.size !== 1 || states.has("always")) return { market: null, closeDate: null, closeMarket: null };
  const state = [...states][0] as ReportMarketState;
  const reopen = state === "closed" || state === "pre-market"
    ? [...sessions.values()].reduce<NonNullable<VenueSession["next"]> | null>((first, session) => (
      session.next && (!first || session.next.open < first.open) ? session.next : first
    ), null)
    : null;
  const closeDate = (state === "closed" || state === "pre-market") && newest ? closeDateOf(newest.observation, newest.session, now) : null;
  return {
    market: {
      state,
      ...(reopen ? { reopensAt: new Date(reopen.open).toISOString(), reopensOn: reopen.date, ...(reopen.firstTrade ? { firstTrade: true as const } : {}) } : {}),
    },
    closeDate,
    closeMarket: closeDate && newest ? closeMarketOf(newest.exchange, newest.session) : null,
  };
}
