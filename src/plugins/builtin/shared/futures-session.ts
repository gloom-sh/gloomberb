const newYorkClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** How often a delayed futures pane refreshes while its contracts trade. */
const FUTURES_SESSION_REFRESH_MS = 60_000;

/**
 * Whether CME Globex is trading: Sunday 18:00 to Friday 17:00 New York time,
 * less the daily 17:00 to 18:00 break. Exchange holidays are not modelled; a
 * holiday only costs a few quiet refreshes.
 */
function isCmeGlobexOpen(now = Date.now()): boolean {
  const parts = newYorkClock.formatToParts(new Date(now));
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  if (weekday === "Sat") return false;
  if (weekday === "Sun") return hour >= 18;
  if (weekday === "Fri") return hour < 17;
  return hour !== 17;
}

/**
 * The refresh cadence for a pane of delayed futures quotes: once a minute
 * while Globex trades, the app's research cadence (null) otherwise. Read at
 * render, so it flips on the pane's next refresh after the open or close.
 */
export function futuresSessionRefreshInterval(now = Date.now()): number | null {
  return isCmeGlobexOpen(now) ? FUTURES_SESSION_REFRESH_MS : null;
}
