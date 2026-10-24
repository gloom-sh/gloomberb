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
}

/** The session a payload belongs to: New York's date when it was taken. */
function liveScanSession(payload: Pick<LiveScanPayload, "asOf" | "takenAt">, now: number): string {
  const at = payload.asOf ?? payload.takenAt ?? now;
  return new Date(at).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export interface TrackStep {
  track: LiveScanTrack;
  /** Matches to alert on: new to the session while alerts are on. */
  alert: LiveScanMatch[];
}

/**
 * Folds one refresh into the track. The first refresh of a scan and session
 * only records what matches: turning alerts on, changing the scan or opening
 * the app mid-session never alerts on a list that was already there. After
 * that a symbol alerts once a session, the first time it matches, so one that
 * flickers across a threshold does not alert on every refresh. Nothing alerts
 * outside the session or before the scanner has data.
 */
export function trackLiveScan(
  previous: LiveScanTrack | null,
  payload: LiveScanPayload,
  scanKey: string,
  { alerts, now }: { alerts: boolean; now: number },
): TrackStep {
  const key = `${scanKey}|${liveScanSession(payload, now)}`;
  const symbols = payload.matches.map((match) => match.symbol);
  if (!previous || previous.key !== key) {
    const seen = new Map(symbols.map((symbol) => [symbol, { since: now, alertedAt: null }]));
    return { track: { key, seen, current: new Set(symbols), fresh: new Set(), takenAt: payload.takenAt }, alert: [] };
  }
  if (payload.takenAt != null && payload.takenAt === previous.takenAt) return { track: previous, alert: [] };
  const alerting = alerts && (payload.status === "live" || payload.status === "degraded");
  const seen = new Map(previous.seen);
  const fresh = new Set<string>();
  const alert: LiveScanMatch[] = [];
  for (const match of payload.matches) {
    if (!previous.current.has(match.symbol)) fresh.add(match.symbol);
    if (seen.has(match.symbol)) continue;
    seen.set(match.symbol, { since: now, alertedAt: alerting ? now : null });
    if (alerting) alert.push(match);
  }
  return { track: { key, seen, current: new Set(symbols), fresh, takenAt: payload.takenAt }, alert };
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
/** The most alerts one refresh writes to the alert history. */
export const MAX_RECORDED_PER_REFRESH = 25;

export interface LiveScanAlertText {
  title: string;
  body: string;
}

/** One notification per refresh, however many symbols it brings. */
export function liveScanAlertText(
  name: string,
  matches: readonly LiveScanMatch[],
  conditions: readonly LiveScanCondition[],
  delayMinutes: number,
): LiveScanAlertText {
  const named = matches.slice(0, NAMED_SYMBOLS).map((match) => match.symbol);
  const more = matches.length - named.length;
  const who = more > 0 ? `${named.join(", ")} and ${more} more` : named.join(", ");
  const what = conditions.length ? conditions.map(conditionText).join("; ") : "the scan's floors";
  const delay = delayMinutes > 0 ? ` (${delayMinutes}m delayed)` : "";
  return { title: name, body: `${who} matched: ${what}${delay}` };
}

/** The alert history's entry for one match, as ALRT's History lists it. */
export function liveScanFiredAlert(
  match: LiveScanMatch,
  { ruleId, rule, conditions, delayMinutes, firedAt }: {
    ruleId: string;
    rule: string;
    conditions: readonly LiveScanCondition[];
    delayMinutes: number;
    firedAt: number;
  },
): FiredAlertInput {
  // The first condition is the one matches rank by; an event's figure is a time, not a value.
  const first = conditions[0];
  const unit = first ? conditionUnit(first) : "percent";
  const figure = first ? matchValue(match, 0) : match.changePercent;
  return {
    kind: "live_scan",
    ruleId,
    // History shows the rule and no symbol column, so the rule names the symbol, as a price alert's does.
    rule: `${match.symbol} · ${rule}`,
    firedAt,
    value: unit === "time" ? match.price : figure,
    unit: unit === "time" ? "USD" : unit === "multiple" ? "x avg volume" : "%",
    detail: conditions.map(conditionText).join("; "),
    quoteAt: match.at != null && match.at > 0 ? new Date(match.at).toISOString() : null,
    source: delayMinutes > 0 ? `${delayMinutes} min delayed` : "real-time",
    symbol: match.symbol,
  };
}
