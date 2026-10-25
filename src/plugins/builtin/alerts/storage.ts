import { METRIC_ALERTS_KEY } from "./metric-model";
import type { AppConfig } from "../../../types/config";
import type { GloomPluginContext } from "../../../types/plugin";
import {
  deserializeAlerts,
  readAlertsStoreError,
  serializeAlerts,
} from "./alert-engine";
import { ALERTS_KEY, ALERTS_PLUGIN_ID } from "./constants";
import { readEventAlertStores } from "./events";
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
  const entries = Object.entries(writeLevelAlertStores(alerts)).filter(([key]) => scope === "all"
    || key === (scope === "price" ? ALERTS_KEY : METRIC_ALERTS_KEY));
  for (const [key] of entries) if (stores.errors[key]) throw new Error(stores.errors[key]!);
  for (const [key, value] of entries) {
    if (ctx.configState.get<unknown>(key) !== value) await ctx.configState.set(key, value);
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
  for (const key of [ALERTS_KEY, METRIC_ALERTS_KEY]) {
    const raw = get(key);
    let error = readAlertsStoreError(raw);
    const rows = error ? [] : deserializeAlerts(raw);
    if (rows.some(a => Boolean(a.metric) !== (key === METRIC_ALERTS_KEY))) error = "Saved alerts contain a rule in the wrong list. Original data has been kept.";
    errors[key] = key === METRIC_ALERTS_KEY ? error?.replaceAll("price alerts", "valuation and technical alerts") ?? null : error;
    if (!error) alerts.push(...rows);
  }
  return { alerts, errors, error: Object.values(errors).filter(Boolean).join(" ") || null };
}
export function writeLevelAlertStores(alerts: AlertRule[]): Record<string, string> {
  return { [ALERTS_KEY]: serializeAlerts(alerts.filter(a => !a.metric)),
    [METRIC_ALERTS_KEY]: serializeAlerts(alerts.filter(a => a.metric)) };
}
