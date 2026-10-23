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
  const json = ctx.configState.get<unknown>(ALERTS_KEY);
  // Background evaluation must not notify from a partial store it cannot safely update.
  if (readAlertsStoreError(json)) return [];
  return deserializeAlerts(json);
}

export async function saveAlerts(
  ctx: GloomPluginContext,
  alerts: AlertRule[],
): Promise<void> {
  const error = readAlertsStoreError(ctx.configState.get<unknown>(ALERTS_KEY));
  if (error) throw new Error(error);
  await ctx.configState.set(ALERTS_KEY, serializeAlerts(alerts));
}

/** Both alert stores as the saved config holds them, for the CLI and the reports, which have no plugin context. */
export function readAlertStores(config: AppConfig) {
  const pluginState = config.pluginConfig[ALERTS_PLUGIN_ID] ?? {};
  const rawPrice = pluginState[ALERTS_KEY];
  return {
    pluginState,
    alerts: deserializeAlerts(rawPrice),
    alertsError: readAlertsStoreError(rawPrice),
    // The event alerts, and the IV levels kept apart from them.
    events: readEventAlertStores((key) => pluginState[key]),
  };
}
