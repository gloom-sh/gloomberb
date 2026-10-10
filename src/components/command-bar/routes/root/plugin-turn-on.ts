import { useMemo } from "react";
import type { DisabledPluginOwner, PluginRegistry } from "../../../../plugins/registry";
import { getPaneTemplateDisplayLabel, paneTemplateShortcutPrefixes } from "../../pane-templates/items";
import type { ResultItem } from "../../list/model";
import { PLUGIN_INSTALL_CATEGORY } from "../../view-model";

/** A typed code whose function belongs to a plugin that is switched off. */
interface PluginTurnOnOffer {
  owner: DisabledPluginOwner;
  code: string;
  /** The function's name, as its row reads when the plugin is on. */
  label: string;
}

type TurnOnRegistry = Pick<
  PluginRegistry,
  "allPlugins" | "commands" | "getCommandPluginId" | "getDisabledPaneTemplateOwner" | "paneTemplates"
>;

/**
 * Matches the code alone or as the first word, case-insensitively, against
 * the functions of switched-off plugins. Only plugins the user can switch
 * back on are offered.
 */
function matchPluginTurnOnOffer({
  query,
  pluginRegistry,
  disabledPlugins,
}: {
  query: string;
  pluginRegistry: TurnOnRegistry;
  disabledPlugins: readonly string[];
}): PluginTurnOnOffer | null {
  const code = (query.trim().split(/\s+/, 1)[0] ?? "").toUpperCase();
  if (!code || disabledPlugins.length === 0) return null;
  const canTurnOn = (owner: DisabledPluginOwner | null): owner is DisabledPluginOwner => (
    !!owner && pluginRegistry.allPlugins.get(owner.id)?.toggleable === true
  );

  for (const template of pluginRegistry.paneTemplates.values()) {
    if (!paneTemplateShortcutPrefixes(template).some((prefix) => prefix.trim().toUpperCase() === code)) continue;
    const owner = pluginRegistry.getDisabledPaneTemplateOwner(template.id, disabledPlugins);
    if (canTurnOn(owner)) return { owner, code, label: getPaneTemplateDisplayLabel(template) };
  }
  for (const [commandId, command] of pluginRegistry.commands) {
    if (command.shortcut?.trim().toUpperCase() !== code) continue;
    const pluginId = pluginRegistry.getCommandPluginId(commandId);
    const plugin = pluginId ? pluginRegistry.allPlugins.get(pluginId) : undefined;
    const owner = plugin && disabledPlugins.includes(plugin.id) ? { id: plugin.id, name: plugin.name } : null;
    if (canTurnOn(owner)) return { owner, code, label: command.label };
  }
  return null;
}

/**
 * The row for a code whose plugin is off, or null. Enter turns the plugin on,
 * then runs the typed text again, argument and all, as if just entered.
 * `enabled` is false whenever something else claimed the query.
 */
export function useRootPluginTurnOnItem({
  enabled,
  query,
  pluginRegistry,
  disabledPlugins,
  rerunQuery,
}: {
  enabled: boolean;
  query: string;
  pluginRegistry: PluginRegistry;
  disabledPlugins: readonly string[];
  rerunQuery: (query: string) => void;
}): ResultItem | null {
  return useMemo(() => {
    const offer = enabled ? matchPluginTurnOnOffer({ query, pluginRegistry, disabledPlugins }) : null;
    if (!offer) return null;
    const actionLine = `Turn on ${offer.owner.name}`;
    return {
      id: `plugin-turn-on:${offer.owner.id}:${offer.code}`,
      label: offer.label,
      detail: actionLine,
      category: PLUGIN_INSTALL_CATEGORY,
      kind: "action",
      right: offer.code,
      searchText: [offer.code, offer.label, offer.owner.name].join(" "),
      lines: [{ segments: [{ text: actionLine, emphasis: "match" }] }],
      action: () => {
        pluginRegistry.setPluginEnabled(offer.owner.id, true);
        rerunQuery(query);
      },
    };
  }, [disabledPlugins, enabled, pluginRegistry, query, rerunQuery]);
}
