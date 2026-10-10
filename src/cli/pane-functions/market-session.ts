import { canonicalExchange, isUsListingExchange } from "../../utils/exchanges";
import {
  activeUsMarketSession,
  isAlwaysOpenExchange,
  isRegularSessionTime,
  latestRegularSessionClose,
  latestRegularSessionOpen,
  nextRegularSessionOpen,
} from "../../market-data/market/freshness";
import { zonedDateKey } from "../../utils/zoned-date-time";
import type { ReportTime } from "../../utils/utc-time";

/** Where the venues behind a quote report stand, as a report says it after the delay. */
type ReportMarketState = "open" | "pre-market" | "after-hours" | "closed";

export interface ReportMarket {
  state: ReportMarketState;
  /** While no venue is in its regular session: the next regular open of the first to open, when its calendar is known. */
  reopensAt?: string;
  /** That open's date at its venue, so a Monday open in Sydney reads Monday. */
  reopensOn?: string;
}

/** One dated row of a quote report: the venue it trades on and the session its source reports. */
export interface SessionObservation {
  exchange: string;
  marketState?: string;
  time: ReportTime | null;
}

interface VenueSession {
  state: ReportMarketState | "always";
  next?: { date: string; open: number };
  /** The latest regular session that has closed: its local date and open. */
  last?: { date: string; open: number | null };
  timeZone?: string;
}

const CLOSED_STATES = new Set(["CLOSED", "PREPRE", "POSTPOST"]);

/**
 * A venue's session now, from its calendar (weekends and published holidays),
 * or from the state its source reports when the app has no calendar for it,
 * such as an index publisher or a futures exchange. Null when neither says.
 */
function venueSession(exchange: string, marketState: string | undefined, now: number): VenueSession | null {
  if (isAlwaysOpenExchange(exchange)) return { state: "always" };
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
  if (marketState === "REGULAR") return { state: "open" };
  if (marketState === "PRE") return { state: "pre-market" };
  if (marketState === "POST") return { state: "after-hours" };
  if (marketState && CLOSED_STATES.has(marketState)) return { state: "closed" };
  return null;
}

/**
 * The newest observation is its venue's latest close: the venue has not
 * opened since, and the print is from that session's day, after its open (an
 * after-hours print of that day counts). Returns that session's local date.
 */
function closeDateOf(observation: SessionObservation, session: VenueSession): string | null {
  const time = observation.time;
  if (!time || time.dateOnly) return null;
  if (session.last && session.timeZone) {
    if (session.last.open != null && time.time < session.last.open) return null;
    return zonedDateKey(time.time, session.timeZone) === session.last.date ? session.last.date : null;
  }
  // No calendar: the source says the session is over, and the print is dated in UTC.
  return session.state === "closed" && !session.last ? new Date(time.time).toISOString().slice(0, 10) : null;
}

/**
 * Where the markets behind a quote report stand now, and whether the newest
 * observation is a close. Null market when the venues disagree (Tokyo open,
 * New York closed), trade around the clock, or none can be placed; a report
 * then says nothing rather than guess.
 */
export function reportMarketSession(
  observations: readonly SessionObservation[],
  now: number,
): { market: ReportMarket | null; closeDate: string | null } {
  const sessions = new Map<string, VenueSession>();
  let newest: { observation: SessionObservation; session: VenueSession } | null = null;
  for (const observation of observations) {
    const exchange = canonicalExchange(observation.exchange);
    if (!exchange) continue;
    const key = `${exchange}:${observation.marketState ?? ""}`;
    const session = sessions.get(key) ?? venueSession(exchange, observation.marketState, now);
    if (!session) continue;
    sessions.set(key, session);
    if (observation.time && (!newest || observation.time.time > (newest.observation.time?.time ?? -Infinity))) {
      newest = { observation, session };
    }
  }
  const states = new Set([...sessions.values()].map((session) => session.state));
  if (states.size !== 1 || states.has("always")) return { market: null, closeDate: null };
  const state = [...states][0] as ReportMarketState;
  const reopen = state === "closed" || state === "pre-market"
    ? [...sessions.values()].reduce<{ date: string; open: number } | null>((first, session) => (
      session.next && (!first || session.next.open < first.open) ? session.next : first
    ), null)
    : null;
  return {
    market: {
      state,
      ...(reopen ? { reopensAt: new Date(reopen.open).toISOString(), reopensOn: reopen.date } : {}),
    },
    closeDate: (state === "closed" || state === "pre-market") && newest ? closeDateOf(newest.observation, newest.session) : null,
  };
}
