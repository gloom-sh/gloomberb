import type { LiveScanCondition, LiveScanMatch, LiveScanPayload } from "../../../api-client/live-scan";
import type { FiredAlertInput } from "../alerts/fired-log";
import { conditionText, conditionUnit, matchValue } from "./live-model";

/**
 * What a pane remembers of a running scan through the session: when each
 * symbol first matched, which ones it alerted on, and which arrived with the
 * latest refresh. Kept per scan and session, so a new scan or a new day starts
 * over, and in memory only: a restart starts over too, without alerting on
 * what already matched.
 */
export interface LiveScanTrack {
  /** The scan and the New York session date it tracks. */
  key: string;
  /** Symbol to when it first matched and when it was alerted, epoch ms. */
  seen: ReadonlyMap<string, { since: number; alertedAt: number | null }>;
  /** The symbols of the latest refresh. */
  current: ReadonlySet<string>;
  /** Symbols that were not in the refresh before it. Empty on the first one. */
  fresh: ReadonlySet<string>;
  /** The refresh the track last read, so a payload read twice changes nothing. */
  takenAt: number | null;
  /** When an alert of this scan last sounded and went to the desktop. */
  loudAt: number | null;
}

/** The session a payload belongs to: New York's date when it was taken. */
function liveScanSession(payload: Pick<LiveScanPayload, "asOf" | "takenAt">, now: number): string {
  const at = payload.asOf ?? payload.takenAt ?? now;
  return new Date(at).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export interface TrackStep {
  /** Null until a refresh of the session has data to start from. */
  track: LiveScanTrack | null;
  /** Matches to alert on: new to the session while alerts are on. */
  alert: LiveScanMatch[];
  /**
   * Whether this refresh's alert sounds and goes to the desktop. A loose scan
   * can bring new symbols on every refresh: they are still told in the app,
   * in one notice per refresh, but sound at most once a minute.
   */
  loud: boolean;
}

/** A scan's alerts sound and reach the desktop at most this often. */
export const LOUD_ALERT_EVERY_MS = 60_000;

/**
 * Folds one refresh into the track. The first refresh of a scan and session
 * with data (live or degraded, from a snapshot) only records what matches:
 * turning alerts on, changing the scan or opening the app mid-session never
 * alerts on a list that was already there. A refresh without data (the
 * scanner starting, the market closed) changes nothing, so the list that comes
 * after it is not taken as new. After that a symbol alerts once a session,
 * the first time it matches, so one that flickers across a threshold does not
 * alert on every refresh.
 */
export function trackLiveScan(
  previous: LiveScanTrack | null,
  payload: LiveScanPayload,
  scanKey: string,
  { alerts, now }: { alerts: boolean; now: number },
): TrackStep {
  const hasData = (payload.status === "live" || payload.status === "degraded") && payload.takenAt != null;
  if (!hasData) return { track: previous, alert: [], loud: false };
  const key = `${scanKey}|${liveScanSession(payload, now)}`;
  const symbols = payload.matches.map((match) => match.symbol);
  if (!previous || previous.key !== key) {
    const seen = new Map(symbols.map((symbol) => [symbol, { since: now, alertedAt: null }]));
    return {
      track: { key, seen, current: new Set(symbols), fresh: new Set(), takenAt: payload.takenAt, loudAt: null },
      alert: [],
      loud: false,
    };
  }
  if (payload.takenAt === previous.takenAt) return { track: previous, alert: [], loud: false };
  const alerting = alerts;
  const seen = new Map(previous.seen);
  const fresh = new Set<string>();
  const alert: LiveScanMatch[] = [];
  for (const match of payload.matches) {
    if (!previous.current.has(match.symbol)) fresh.add(match.symbol);
    if (seen.has(match.symbol)) continue;
    seen.set(match.symbol, { since: now, alertedAt: alerting ? now : null });
    if (alerting) alert.push(match);
  }
  const loud = alert.length > 0 && (previous.loudAt == null || now - previous.loudAt >= LOUD_ALERT_EVERY_MS);
  return {
    track: { key, seen, current: new Set(symbols), fresh, takenAt: payload.takenAt, loudAt: loud ? now : previous.loudAt },
    alert,
    loud,
  };
}

/** What one row says about itself in its status cell; null for nothing to say. */
export type LiveScanRowNote =
  | { kind: "stale"; at: number }
  | { kind: "alerted"; at: number }
  | { kind: "new" };

/** A print this much older than the snapshot during the session reads as stale (a halt, a thin name). */
const STALE_PRINT_MS = 5 * 60_000;

export function liveScanRowNote(
  match: LiveScanMatch,
  payload: Pick<LiveScanPayload, "asOf" | "status">,
  track: LiveScanTrack | null,
): LiveScanRowNote | null {
  if (payload.status === "live" && match.at != null && payload.asOf != null && payload.asOf - match.at > STALE_PRINT_MS) {
    return { kind: "stale", at: match.at };
  }
  const alertedAt = track?.seen.get(match.symbol)?.alertedAt;
  if (alertedAt != null) return { kind: "alerted", at: alertedAt };
  if (track?.fresh.has(match.symbol)) return { kind: "new" };
  return null;
}

/** How many symbols one alert names before it says how many more there are. */
const NAMED_SYMBOLS = 4;
/**
 * The most entries live scans keep in the alert history, all scans together.
 * The history is shared with price and event alerts and keeps 1,000 entries;
 * a busy scan must not push those out.
 */
export const LIVE_SCAN_HISTORY_LIMIT = 100;

export interface LiveScanAlertText {
  title: string;
  body: string;
}

/** The symbols of an alert, the first few by name: `NVDA, AMD and 3 more`. */
function namedSymbols(matches: readonly LiveScanMatch[]): string {
  const named = matches.slice(0, NAMED_SYMBOLS).map((match) => match.symbol);
  const more = matches.length - named.length;
  return more > 0 ? `${named.join(", ")} and ${more} more` : named.join(", ");
}

/** One notification per refresh, however many symbols it brings. */
export function liveScanAlertText(
  name: string,
  matches: readonly LiveScanMatch[],
  conditions: readonly LiveScanCondition[],
  delayMinutes: number,
): LiveScanAlertText {
  const who = namedSymbols(matches);
  const what = conditions.length ? conditions.map(conditionText).join("; ") : "the scan's floors";
  const delay = delayMinutes > 0 ? ` (${delayMinutes}m delayed)` : "";
  return { title: name, body: `${who} matched: ${what}${delay}` };
}

/**
 * The alert history's entry for one refresh's alert, as ALRT's History lists
 * it: one entry however many symbols it brought, with the figure of the first
 * (the strongest, as the scan ranks them).
 */
export function liveScanFiredAlert(
  matches: readonly [LiveScanMatch, ...LiveScanMatch[]],
  { ruleId, rule, conditions, delayMinutes, firedAt }: {
    ruleId: string;
    rule: string;
    conditions: readonly LiveScanCondition[];
    delayMinutes: number;
    firedAt: number;
  },
): FiredAlertInput {
  const match = matches[0];
  // The first condition is the one matches rank by; an event's figure is a time, not a value.
  const first = conditions[0];
  const unit = first ? conditionUnit(first) : "percent";
  const figure = first ? matchValue(match, 0) : match.changePercent;
  return {
    kind: "live_scan",
    ruleId,
    // History shows the rule and no symbol column, so the rule names the symbols, as a price alert's does.
    rule: `${namedSymbols(matches)} · ${rule}`,
    firedAt,
    value: unit === "time" ? match.price : figure,
    unit: unit === "time" ? "USD" : unit === "multiple" ? "x avg volume" : "%",
    detail: conditions.map(conditionText).join("; "),
    quoteAt: match.at != null && match.at > 0 ? new Date(match.at).toISOString() : null,
    source: delayMinutes > 0 ? `${delayMinutes} min delayed` : "real-time",
    symbol: match.symbol,
  };
}
