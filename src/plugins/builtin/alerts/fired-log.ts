import type { PluginResumeState } from "../../../types/plugin";
import type { QuoteDataSource } from "../../../types/financials";
import { ALERTS_PLUGIN_ID } from "./constants";

/**
 * The alerts this device's app fired, kept on the device (plugin resume
 * state, never synced): `fn ALRT --tab history` and the History tab read it
 * signed out, and merge Gloom Cloud's deliveries in when signed in. Beside
 * them it keeps when a rule was created, re-armed or deleted here, from the
 * app or `gloom alerts` (`action`).
 */
export const FIRED_LOG_KEY = "firedLog";
/** The newest fired alerts kept; older ones fall off as new ones are added. */
export const MAX_FIRED_ALERTS = 1000;
/**
 * The newest rule changes (created, re-armed, deleted) kept, apart from the
 * fired alerts: a change never counts against them, so no number of changes
 * pushes an alert that went off out of the log.
 */
export const MAX_ALERT_CHANGES = 200;

export interface FiredAlert {
  id: string;
  /** When the app fired it, ISO. */
  firedAt: string;
  /** The rule's kind: `price`, `iv_level`, `earnings_date`, `macro_event`, `live_scan`. */
  kind: string;
  ruleId: string;
  /** The rule as it read when it went off: `BTC above 85000`, `IBIT · 30d ATM IV above 50%`. */
  rule: string;
  /** The figure that set it off, in `unit`; null for a dated event. */
  value: number | null;
  /** `value`'s unit: the quote's currency, `%`, `vol pts`. */
  unit?: string;
  /** What the notification said beside the figure, such as an earnings line. */
  detail?: string;
  /** When the quote behind `value` was observed, ISO. */
  quoteAt: string | null;
  /** How current that quote was: `real-time`, `15 min delayed`. */
  source: string | null;
  symbol?: string;
  exchange?: string;
  /** A change to the rule rather than the alert going off: created, re-armed or deleted. */
  action?: AlertLogAction;
}

export type FiredAlertInput = Omit<FiredAlert, "id" | "firedAt"> & { firedAt: number };

const ALERT_LOG_ACTIONS = ["created", "rearmed", "deleted"] as const;
export type AlertLogAction = (typeof ALERT_LOG_ACTIONS)[number];
/** What History says of a change, in its Value column. */
const ALERT_LOG_ACTION_TEXT: Record<AlertLogAction, string> = { created: "Created", rearmed: "Re-armed", deleted: "Deleted" };

/** A change to a rule as the log keeps it: when, what was done, and the rule as it read. */
export function alertChangeEntry(
  action: AlertLogAction,
  rule: { kind: string; ruleId: string; rule: string; symbol?: string; exchange?: string },
  at = Date.now(),
): FiredAlertInput {
  return {
    kind: rule.kind, ruleId: rule.ruleId, rule: rule.rule, firedAt: at, value: null, quoteAt: null, source: null, action,
    detail: ALERT_LOG_ACTION_TEXT[action],
    ...(rule.symbol ? { symbol: rule.symbol } : {}), ...(rule.exchange ? { exchange: rule.exchange } : {}),
  };
}

/** How current a quote was, in the words reports use. */
export function quoteSourceWords(source: QuoteDataSource | undefined): string | null {
  return source === "live" ? "real-time" : source === "delayed" ? "delayed" : source === "snapshot" ? "snapshot" : null;
}

/** A millisecond time as the log keeps it, ISO; null for none. */
export function firedAlertTime(value: number | null | undefined): string | null {
  return value != null && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

const isText = (value: unknown): value is string => typeof value === "string";
const optionalText = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";

/** Entries that read, oldest first; anything else in the store is dropped rather than shown wrong. */
export function readFiredAlerts(value: unknown): FiredAlert[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is FiredAlert => !!entry && typeof entry === "object"
    && isText(entry.id) && isText(entry.kind) && isText(entry.ruleId) && isText(entry.rule)
    && isText(entry.firedAt) && Number.isFinite(Date.parse(entry.firedAt))
    && (entry.value === null || Number.isFinite(entry.value))
    && (entry.quoteAt === null || isText(entry.quoteAt)) && (entry.source === null || isText(entry.source))
    && optionalText(entry.unit) && optionalText(entry.detail) && optionalText(entry.symbol) && optionalText(entry.exchange)
    && (entry.action === undefined || ALERT_LOG_ACTIONS.includes(entry.action)));
}

function firedAlertEntry(input: FiredAlertInput, id: string = crypto.randomUUID()): FiredAlert {
  const { firedAt, ...rest } = input;
  return { id, firedAt: firedAlertTime(firedAt) ?? new Date().toISOString(), ...rest };
}

/**
 * The log within its caps, oldest first: the newest MAX_FIRED_ALERTS fired
 * alerts and, counted apart, the newest MAX_ALERT_CHANGES rule changes. Each
 * kind of entry only ever drops its own oldest.
 */
function capAlertLog(entries: readonly FiredAlert[]): FiredAlert[] {
  let changes = entries.reduce((count, entry) => count + (entry.action ? 1 : 0), 0);
  let fired = entries.length - changes;
  changes -= MAX_ALERT_CHANGES;
  fired -= MAX_FIRED_ALERTS;
  if (changes <= 0 && fired <= 0) return [...entries];
  return entries.filter((entry) => {
    if (entry.action ? changes <= 0 : fired <= 0) return true;
    if (entry.action) changes -= 1;
    else fired -= 1;
    return false;
  });
}

/** `entries` with one more at the end, the oldest of its kind (fired alert or rule change) dropped past its cap. */
export function appendFiredAlert(entries: readonly FiredAlert[], input: FiredAlertInput, id: string = crypto.randomUUID()): FiredAlert[] {
  return capAlertLog([...entries, firedAlertEntry(input, id)]);
}

/** `entries` keeping only the newest `max` fired alerts of each kind in `kinds`; other kinds and rule changes are untouched. */
function capFiredAlertKinds(entries: readonly FiredAlert[], kinds: ReadonlySet<string>, max: number): FiredAlert[] {
  const counted = (entry: FiredAlert) => !entry.action && kinds.has(entry.kind);
  const over = new Map<string, number>();
  for (const entry of entries) if (counted(entry)) over.set(entry.kind, (over.get(entry.kind) ?? 0) + 1);
  for (const [kind, count] of over) over.set(kind, count - max);
  // Oldest first: the first entries of a kind over its cap are the ones to drop.
  return entries.filter((entry) => {
    const extra = counted(entry) ? over.get(entry.kind) ?? 0 : 0;
    if (extra <= 0) return true;
    over.set(entry.kind, extra - 1);
    return false;
  });
}

/**
 * Records an alert another plugin fired (a live scan's new matches) in this
 * log, through the runtime's access to the alerts plugin's resume state.
 * `keepAtMost` bounds how many entries of the recorded kinds the shared log
 * keeps, so a busy source cannot push the price and event alerts out.
 */
export function recordFiredAlertFor(
  runtime: { getResumeState(pluginId: string, key: string): unknown; setResumeState(pluginId: string, key: string, value: unknown): void },
  inputs: readonly FiredAlertInput[],
  onError: (error: unknown) => void,
  keepAtMost?: number,
): void {
  if (!inputs.length) return;
  try {
    let entries = [...readFiredAlerts(runtime.getResumeState(ALERTS_PLUGIN_ID, FIRED_LOG_KEY)), ...inputs.map((input) => firedAlertEntry(input))];
    // The source's own oldest entries go first, before the log's cap reaches anyone else's.
    if (keepAtMost != null) entries = capFiredAlertKinds(entries, new Set(inputs.map((input) => input.kind)), keepAtMost);
    runtime.setResumeState(ALERTS_PLUGIN_ID, FIRED_LOG_KEY, capAlertLog(entries));
  } catch (error) {
    onError(error);
  }
}

/**
 * Adds entries to the device's log through the plugin's saved state as the
 * shell reads and writes it (`gloom alerts`), where there is no running
 * plugin to record them.
 */
export function appendAlertLog(
  state: { get(key: string): unknown; set(key: string, value: unknown): void },
  inputs: readonly FiredAlertInput[],
): void {
  if (!inputs.length) return;
  let entries = readFiredAlerts(state.get(FIRED_LOG_KEY));
  for (const input of inputs) entries = appendFiredAlert(entries, input);
  state.set(FIRED_LOG_KEY, entries);
}

/** Records a fired alert in the device's log. A log that cannot be written never stops the alert itself. */
export function createFiredAlertRecorder(resume: Pick<PluginResumeState, "getState" | "setState">, onError: (error: unknown) => void) {
  return (input: FiredAlertInput) => {
    try {
      resume.setState(FIRED_LOG_KEY, appendFiredAlert(readFiredAlerts(resume.getState(FIRED_LOG_KEY)), input));
    } catch (error) {
      onError(error);
    }
  };
}
