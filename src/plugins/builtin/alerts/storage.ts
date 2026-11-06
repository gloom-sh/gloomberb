import { METRIC_ALERTS_KEY, RELATIVE_ALERTS_KEY, metricAlertsKey } from "./metric-model";
import type { AppConfig } from "../../../types/config";
import type { GloomPluginContext } from "../../../types/plugin";
import {
  deserializeAlerts,
  readAlertsStoreError,
  serializeAlerts,
} from "./alert-engine";
import { ALERTS_KEY, ALERTS_PLUGIN_ID } from "./constants";
import { readEventAlertStores } from "./events";
import { MOVE_ALERTS_KEY } from "./move";
import type { AlertRule } from "./types";

export function loadAlerts(ctx: GloomPluginContext): AlertRule[] {
  const result = readLevelAlertStores((key) => ctx.configState.get<unknown>(key));
  return result.alerts;
}

export async function saveAlerts(
  ctx: GloomPluginContext,
  alerts: AlertRule[],
  scope: "all" | "price" | "metric" = "all",
): Promise<void> {
  const stores = readLevelAlertStores((key) => ctx.configState.get<unknown>(key));
  // An unreadable list is never written over; one that has nothing to write does not hold up the others.
  // Prices and moves are judged on quotes; valuation, technical and relative strength rules on their own readings.
  const quoted = (key: string) => key === ALERTS_KEY || key === MOVE_ALERTS_KEY;
  const entries = Object.entries(writeLevelAlertStores(alerts)).filter(([key, value]) => (scope === "all"
    || (scope === "price" ? quoted(key) : !quoted(key))) && !(stores.errors[key] && value === "[]"));
  for (const [key] of entries) if (stores.errors[key]) throw new Error(stores.errors[key]!);
  for (const [key, value] of entries) {
    const current = ctx.configState.get<unknown>(key);
    // A list never written that stays empty (moves, on a profile without them) is left unwritten.
    if (current !== value && !(current == null && value === "[]")) await ctx.configState.set(key, value);
  }
}

/** Both alert stores as the saved config holds them, for the CLI and the reports, which have no plugin context. */
export function readAlertStores(config: AppConfig) {
  const pluginState = config.pluginConfig[ALERTS_PLUGIN_ID] ?? {};
  const levels = readLevelAlertStores((key) => pluginState[key]);
  return {
    pluginState,
    alerts: levels.alerts,
    alertsError: levels.error,
    levelErrors: levels.errors,
    // The event alerts, and the IV levels kept apart from them.
    events: readEventAlertStores((key) => pluginState[key]),
  };
}

export function readLevelAlertStores(get: (key: string) => unknown): { alerts: AlertRule[]; error: string | null; errors: Record<string, string | null> } {
  const alerts: AlertRule[] = [];
  const errors: Record<string, string | null> = {};
  for (const key of LEVEL_ALERT_KEYS) {
    const raw = get(key);
    let error = readAlertsStoreError(raw);
    const rows = error ? [] : deserializeAlerts(raw);
    if (rows.some(a => levelAlertStoreKey(a) !== key)) error = "Saved alerts contain a rule in the wrong list. Original data has been kept.";
    errors[key] = key === METRIC_ALERTS_KEY ? error?.replaceAll("price alerts", "valuation and technical alerts") ?? null
      : key === RELATIVE_ALERTS_KEY ? error?.replaceAll("price alerts", "relative strength alerts") ?? null
      : key === MOVE_ALERTS_KEY ? error?.replaceAll("price alerts", "move alerts") ?? null : error;
    if (!error) alerts.push(...rows);
  }
  return { alerts, errors, error: Object.values(errors).filter(Boolean).join(" ") || null };
}
export function writeLevelAlertStores(alerts: AlertRule[]): Record<string, string> {
  return Object.fromEntries(LEVEL_ALERT_KEYS.map(key => [key, serializeAlerts(alerts.filter(a => levelAlertStoreKey(a) === key))]));
}
/** Price, valuation/technical, relative strength and move rules each keep their own synced list. */
const LEVEL_ALERT_KEYS = [ALERTS_KEY, METRIC_ALERTS_KEY, RELATIVE_ALERTS_KEY, MOVE_ALERTS_KEY] as const;
export const levelAlertStoreKey = (alert: Pick<AlertRule, "metric" | "move">): string =>
  alert.metric ? metricAlertsKey(alert.metric) : alert.move ? MOVE_ALERTS_KEY : ALERTS_KEY;
