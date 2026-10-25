import type { PluginResumeState } from "../../../types/plugin";
import type { QuoteDataSource } from "../../../types/financials";
import { ALERTS_PLUGIN_ID } from "./constants";

/**
 * The alerts this device's app fired, kept on the device (plugin resume
 * state, never synced): `fn ALRT --tab history` and the History tab read it
 * signed out, and merge Gloom Cloud's deliveries in when signed in.
 */
export const FIRED_LOG_KEY = "firedLog";
/** The newest entries kept; older ones fall off as new ones are added. */
export const MAX_FIRED_ALERTS = 1000;

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
}

export type FiredAlertInput = Omit<FiredAlert, "id" | "firedAt"> & { firedAt: number };

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
    && optionalText(entry.unit) && optionalText(entry.detail) && optionalText(entry.symbol) && optionalText(entry.exchange));
}

function firedAlertEntry(input: FiredAlertInput, id: string = crypto.randomUUID()): FiredAlert {
  const { firedAt, ...rest } = input;
  return { id, firedAt: firedAlertTime(firedAt) ?? new Date().toISOString(), ...rest };
}

/** `entries` with one more at the end, the oldest dropped past the cap. */
export function appendFiredAlert(entries: readonly FiredAlert[], input: FiredAlertInput, id: string = crypto.randomUUID()): FiredAlert[] {
  return [...entries, firedAlertEntry(input, id)].slice(-MAX_FIRED_ALERTS);
}

/** `entries` keeping only the newest `max` of each kind in `kinds`; other kinds are untouched. */
function capFiredAlertKinds(entries: readonly FiredAlert[], kinds: ReadonlySet<string>, max: number): FiredAlert[] {
  const over = new Map<string, number>();
  for (const entry of entries) if (kinds.has(entry.kind)) over.set(entry.kind, (over.get(entry.kind) ?? 0) + 1);
  for (const [kind, count] of over) over.set(kind, count - max);
  // Oldest first: the first entries of a kind over its cap are the ones to drop.
  return entries.filter((entry) => {
    const extra = over.get(entry.kind) ?? 0;
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
    runtime.setResumeState(ALERTS_PLUGIN_ID, FIRED_LOG_KEY, entries.slice(-MAX_FIRED_ALERTS));
  } catch (error) {
    onError(error);
  }
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
