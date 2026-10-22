import type { PluginResumeState } from "../../../types/plugin";
import type { QuoteDataSource } from "../../../types/financials";

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
  /** The rule's kind: `price`, `iv_level`, `earnings_date`, `macro_event`. */
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

/** `entries` with one more at the end, the oldest dropped past the cap. */
export function appendFiredAlert(entries: readonly FiredAlert[], input: FiredAlertInput, id: string = crypto.randomUUID()): FiredAlert[] {
  const { firedAt, ...rest } = input;
  const entry: FiredAlert = { id, firedAt: firedAlertTime(firedAt) ?? new Date().toISOString(), ...rest };
  return [...entries, entry].slice(-MAX_FIRED_ALERTS);
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
