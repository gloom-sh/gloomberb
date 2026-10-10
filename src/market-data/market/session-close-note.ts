import { canonicalExchange } from "../../utils/exchanges";
import { futuresListingVenue } from "../../utils/futures-generic";
import { regularSessionCloseUtcMinute } from "./freshness";

interface SessionLeg {
  symbol: string;
  /** The listing's exchange; without one the close is unknown and no note is made. */
  exchange?: string;
  /** What the reader typed, when it differs from the symbol. */
  label?: string;
}

const MINUTES_PER_DAY = 1440;
/** Crypto and FX carry no regular session. */
const ALWAYS_OPEN_EXCHANGES = new Set(["CCC", "CCY"]);

const clock = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

function offsetText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} h` : "", rest ? `${rest} min` : ""].filter(Boolean).join(" ");
}

/**
 * Where a daily bar of the listing falls on its date. A venue with a listed
 * regular close closes at that UTC time. Crypto, FX and futures carry a bar
 * dated 00:00 UTC, which closes when the next UTC day starts. A venue with
 * neither is unknown.
 */
function dailyBarClose(leg: SessionLeg, time: number): { minute: number; text: string } | null {
  const label = leg.label ?? leg.symbol;
  const minute = regularSessionCloseUtcMinute(leg.exchange, time);
  if (minute !== null) return { minute, text: `${label} closes ${clock(minute)} UTC` };
  const exchange = canonicalExchange(leg.exchange);
  return exchange && (ALWAYS_OPEN_EXCHANGES.has(exchange) || futuresListingVenue(leg.symbol, exchange))
    ? { minute: MINUTES_PER_DAY, text: `${label} bar is ${clock(0)} UTC` }
    : null;
}

/**
 * One line for a daily pair whose two sides close at different times, such as
 * a US equity against crypto, or null when they close together (two US
 * equities) or a close is not known. Daily closes pair by UTC date, so a
 * reader of a correlation or ratio should know the two prices are not taken
 * at the same moment. `dateKey` is the date the pair is read on, which
 * settles daylight time.
 */
export function mixedSessionCloseNote(left: SessionLeg, right: SessionLeg, dateKey?: string | null): string | null {
  const parsed = dateKey ? Date.parse(`${dateKey}T23:59:59Z`) : Number.NaN;
  const time = Number.isFinite(parsed) ? parsed : Date.now();
  const a = dailyBarClose(left, time);
  const b = dailyBarClose(right, time);
  if (!a || !b) return null;
  const offset = Math.abs(a.minute - b.minute);
  return offset === 0 ? null : `${a.text}; ${b.text} (${offsetText(offset)} offset). Daily pairs are matched by date.`;
}
