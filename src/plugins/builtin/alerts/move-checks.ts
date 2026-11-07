// What this device read of each move rule, kept apart from the rules. The
// synced `moveAlerts` list holds the rules and the latest session each went off
// in (`moveDay`, for Gloom Cloud), so it changes only when a rule does or goes
// off; every check and every re-arm for the next session stay in plugin resume
// state, as IV levels' readings do.
import type { QuoteChangeBasis } from "../../../market-data/market/change-basis";
import type { QuoteDataSource } from "../../../types/financials";
import type { AlertRule } from "./types";

/** The device's last reading of each move rule, by rule id, in plugin resume state: never synced. */
export const MOVE_CHECKS_KEY = "moveChecks";

/** One device's last reading of a move rule, and the session it last went off in. */
export interface MoveCheck {
  /** The arming the reading is of (the rule's `armedAt`, else `createdAt`): an edit starts afresh. */
  armedAt: number;
  checkedAt: number;
  /** The move read, in percent. */
  percent?: number;
  basis?: QuoteChangeBasis;
  quoteAt?: number;
  source?: QuoteDataSource;
  currency?: string;
  exchange?: string;
  pence?: true;
  /** Why the last check had no quote. */
  error?: string;
  /** It went off, and waits for a later session to arm it again. */
  fired?: true;
  firedAt?: number;
  /** The session (a date) it last went off in. */
  session?: string;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 300;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const BASIS_KINDS = new Set(["close", "settle", "previous close", "utc day", "24h"]);
const SOURCES = new Set<QuoteDataSource>(["live", "delayed", "snapshot"]);

function readBasis(value: unknown): QuoteChangeBasis | undefined {
  if (!value || typeof value !== "object") return undefined;
  const basis = value as Record<string, unknown>;
  if (!BASIS_KINDS.has(String(basis.kind))) return undefined;
  if ((basis.kind === "close" || basis.kind === "settle") && !isText(basis.date)) return undefined;
  return value as QuoteChangeBasis;
}

/** The saved readings that read; anything else is dropped, and the next check writes it again. */
export function readMoveChecks(value: unknown): Record<string, MoveCheck> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const checks: Record<string, MoveCheck> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const check = raw as Record<string, unknown>;
    if (!isNumber(check.armedAt) || !isNumber(check.checkedAt)) continue;
    const basis = readBasis(check.basis);
    checks[id] = {
      armedAt: check.armedAt,
      checkedAt: check.checkedAt,
      ...isNumber(check.percent) ? { percent: check.percent } : {},
      ...basis ? { basis } : {},
      ...isNumber(check.quoteAt) ? { quoteAt: check.quoteAt } : {},
      ...SOURCES.has(check.source as QuoteDataSource) ? { source: check.source as QuoteDataSource } : {},
      ...isText(check.currency) ? { currency: check.currency } : {},
      ...isText(check.exchange) ? { exchange: check.exchange } : {},
      ...check.pence === true ? { pence: true as const } : {},
      ...isText(check.error) ? { error: check.error } : {},
      ...check.fired === true ? { fired: true as const } : {},
      ...isNumber(check.firedAt) ? { firedAt: check.firedAt } : {},
      ...isText(check.session) ? { session: check.session } : {},
    };
  }
  return checks;
}

const armingOf = (alert: Pick<AlertRule, "armedAt" | "createdAt">) => alert.armedAt ?? alert.createdAt;

/** A judged move rule's reading, as this device keeps it; null before its first check. */
function moveCheckOf(alert: AlertRule): MoveCheck | null {
  if (!alert.move || alert.lastCheckedAt == null) return null;
  return {
    armedAt: armingOf(alert),
    checkedAt: alert.lastCheckedAt,
    ...alert.lastCheckedPrice != null && Number.isFinite(alert.lastCheckedPrice) ? { percent: alert.lastCheckedPrice } : {},
    ...alert.lastMoveBasis ? { basis: alert.lastMoveBasis } : {},
    ...alert.lastQuoteUpdatedAt != null && Number.isFinite(alert.lastQuoteUpdatedAt) ? { quoteAt: alert.lastQuoteUpdatedAt } : {},
    ...alert.lastQuoteSource ? { source: alert.lastQuoteSource } : {},
    ...alert.lastQuoteCurrency ? { currency: alert.lastQuoteCurrency } : {},
    ...alert.lastQuoteExchange ? { exchange: alert.lastQuoteExchange } : {},
    ...alert.lastQuotePence ? { pence: true as const } : {},
    ...alert.lastCheckError ? { error: alert.lastCheckError } : {},
    ...alert.status === "triggered" ? { fired: true as const, ...alert.triggeredAt ? { firedAt: alert.triggeredAt } : {} } : {},
    ...alert.moveSession ? { session: alert.moveSession } : {},
  };
}

/**
 * A move rule as this device reads it: the rule with its last reading, and
 * triggered while it waits for the next session. A reading of an earlier
 * arming (before an edit or a re-arm) is not its own. Any other rule, and a
 * move rule never read here, is returned as the rule.
 */
function withMoveCheck(alert: AlertRule, check: MoveCheck | undefined): AlertRule {
  if (!alert.move) return alert;
  const rule = moveRuleOnly(alert);
  if (!check || check.armedAt !== armingOf(alert)) return rule;
  return {
    ...rule,
    lastCheckedAt: check.checkedAt,
    ...check.percent != null ? { lastCheckedPrice: check.percent } : {},
    ...check.basis ? { lastMoveBasis: check.basis } : {},
    ...check.quoteAt != null ? { lastQuoteUpdatedAt: check.quoteAt } : {},
    ...check.source ? { lastQuoteSource: check.source } : {},
    ...check.currency ? { lastQuoteCurrency: check.currency } : {},
    ...check.exchange ? { lastQuoteExchange: check.exchange } : {},
    ...check.pence ? { lastQuotePence: true } : {},
    ...check.error ? { lastCheckError: check.error } : {},
    ...check.fired ? { status: "triggered" as const, ...check.firedAt ? { triggeredAt: check.firedAt } : {} } : {},
    ...check.session ? { moveSession: check.session } : {},
  };
}

/** The rules with this device's readings of the move rules among them (`withMoveCheck`). */
export function withMoveChecks(alerts: AlertRule[], checks: Record<string, MoveCheck>): AlertRule[] {
  return alerts.map((alert) => alert.move ? withMoveCheck(alert, checks[alert.id]) : alert);
}

/** The readings to keep for the rules: each move rule's, as judged; a deleted rule's goes. */
export function moveChecksOf(alerts: readonly AlertRule[]): Record<string, MoveCheck> {
  const checks: Record<string, MoveCheck> = {};
  for (const alert of alerts) {
    const check = moveCheckOf(alert);
    if (check) checks[alert.id] = check;
  }
  return checks;
}

/**
 * A move rule as the synced list keeps it: the rule, never a reading, so no
 * check writes the list another device pulls. Always active there: whether
 * it went off this session is this device's to say. The latest session it
 * went off in (`moveDay`) goes with it, so Gloom Cloud never alerts on that
 * session again; it changes at most once a session. `syncsMoveDay` says this
 * app keeps `moveDay`, so Gloom Cloud may judge the rule.
 */
export function moveRuleOnly(alert: AlertRule): AlertRule {
  return {
    id: alert.id,
    symbol: alert.symbol,
    ...alert.exchange ? { exchange: alert.exchange } : {},
    condition: alert.condition,
    targetPrice: alert.targetPrice,
    createdAt: alert.createdAt,
    ...alert.armedAt != null ? { armedAt: alert.armedAt } : {},
    status: "active",
    ...alert.message ? { message: alert.message } : {},
    ...alert.moveDay ? { moveDay: alert.moveDay } : {},
    move: true,
    syncsMoveDay: true,
  };
}
