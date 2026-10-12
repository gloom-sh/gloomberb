import type { AppNotificationRequest } from "../types/plugin";
import type { DisabledPluginOwner } from "./registry";

/**
 * Opening something whose plugin is switched off. A pane added for it would
 * stay hidden, so the open is refused and the user is offered the switch.
 */
export class PluginOffError extends Error {
  constructor(readonly plugin: DisabledPluginOwner, what: string) {
    super(`Turn on ${plugin.name} to open ${what}.`);
    this.name = "PluginOffError";
  }
}

interface PluginOffNotifier {
  notify(notification: AppNotificationRequest): unknown;
  setPluginEnabled(pluginId: string, enabled: boolean): void;
}

/**
 * Says which plugin to turn on, with a button that turns it on and, when
 * given, opens what was asked for.
 */
export function notifyPluginOff(host: PluginOffNotifier, error: PluginOffError, reopen?: () => void): void {
  host.notify({
    body: error.message,
    type: "info",
    action: {
      label: "Turn on",
      onClick: () => {
        host.setPluginEnabled(error.plugin.id, true);
        reopen?.();
      },
    },
  });
}
