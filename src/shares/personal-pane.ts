import type { PluginRegistry } from "../plugins/registry";
import type { PaneDef, PanePersonalData, PanePersonalDataContext } from "../types/plugin";
import { resolvePanePersonalData } from "./pane-image";

interface PersonalPaneSource {
  registry: Pick<PluginRegistry, "brokers" | "getPanePluginId" | "getBrokerPluginId">;
  /** The pane's definition as the shell resolved it: a pane from a plugin this terminal lacks has a placeholder one. */
  def: Pick<PaneDef, "personalData"> | undefined;
  /** What the instance shows now. */
  context: PanePersonalDataContext;
}

/** Whether the plugin that owns a pane also connects a broker. */
function ownerConnectsBroker({ brokers, getPanePluginId, getBrokerPluginId }: PersonalPaneSource["registry"], paneType: string): boolean {
  const owner = getPanePluginId(paneType);
  return !!owner && [...brokers.keys()].some((brokerType) => getBrokerPluginId(brokerType) === owner);
}

/**
 * The personal data a pane shows now, read from its `personalData`
 * declaration alone. Posting the pane's picture and asking Ask Gloom about it
 * both go through here, so there is no second list of panes to keep up to date.
 */
export function panePersonalData({ registry, def, context }: PersonalPaneSource): PanePersonalData | null {
  return resolvePanePersonalData(def, context, {
    ownerConnectsBroker: ownerConnectsBroker(registry, context.paneType),
  });
}

/** Whether a pane shows holdings, account data or private messages, so Ask Gloom asks before its contents leave the device. */
export function paneShowsPersonalData(source: PersonalPaneSource): boolean {
  return panePersonalData(source) !== null;
}
