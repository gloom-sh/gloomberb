import { t } from "../../../i18n";
import type { PluginRegistry } from "../../registry";
import { resolvePaneInstance } from "../../../types/config";

export const BROKERS_PANE_ID = "brokers";

/**
 * Pane state that asks a Brokers pane to start adding a profile. The pane
 * clears it as it starts, so the add flow itself is never saved with the
 * layout. Pane state reaches the pane in a detached window too.
 */
export const BROKER_ADD_REQUEST_KEY = "brokerAddRequest";

type BrokerAddLauncher = Pick<
  PluginRegistry,
  "panes" | "showPane" | "getLayoutFn" | "updatePaneRuntimeStateFn" | "notify"
>;

/**
 * Add Broker Account from the command bar or the application menu: shows the
 * Brokers pane, a new one when there is none, and starts its add flow.
 */
export function openBrokerAddFlow(registry: BrokerAddLauncher): void {
  if (!registry.panes.has(BROKERS_PANE_ID)) {
    registry.notify({ body: t("Broker plugin is not available."), type: "info" });
    return;
  }
  registry.showPane(BROKERS_PANE_ID);
  // The pane just shown: the layout is current the moment showPane placed it.
  const pane = resolvePaneInstance(registry.getLayoutFn(), BROKERS_PANE_ID);
  if (pane) registry.updatePaneRuntimeStateFn(pane.instanceId, { [BROKER_ADD_REQUEST_KEY]: Date.now() });
}
