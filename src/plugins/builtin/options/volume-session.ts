import { getPublishedUsEquitySession } from "../../../market-data/published-us-sessions";
import type { OptionsChain } from "../../../types/financials";
import { zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";
import { formatCalendarDay } from "./model-spot";

const newYorkDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** A day's regular open, from the published calendar, else a weekday's 09:30 New York; null on a closed day. */
function sessionOpen(exchange: string, date: string): number | null {
  const session = getPublishedUsEquitySession(exchange, date);
  if (session) return session.kind === "session" ? session.open : null;
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6 ? null : zonedWallClockToUtcMs("America/New_York", year, month, day, 9, 30, 0);
}

function previousDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/**
 * The US session a listed chain's volume counts, YYYY-MM-DD: the latest one
 * open by the time of its quotes. Read before the open (Tuesday premarket),
 * Monday's last quotes carry Monday's volume, not a Tuesday count. A venue
 * that trades around the clock (Deribit) has no such session: null.
 */
export function chainVolumeSession(chain: Pick<OptionsChain, "asOf" | "venue">, exchange = "NYSE"): string | null {
  if (chain.venue) return null;
  const time = chain.asOf ? Date.parse(chain.asOf) : Number.NaN;
  if (!Number.isFinite(time)) return null;
  let date = newYorkDate.format(time);
  // A long holiday weekend is the furthest a quote sits from its session.
  for (let step = 0; step < 7; step += 1) {
    const open = sessionOpen(exchange, date);
    if (open != null && open <= time) return date;
    date = previousDate(date);
  }
  return null;
}

/** `Volume for Mon 23 Nov`, beside the open interest's `OI as of Fri 20 Nov`. */
export function volumeSessionLabel(date: string): string {
  return `Volume for ${formatCalendarDay(date)}`;
}
