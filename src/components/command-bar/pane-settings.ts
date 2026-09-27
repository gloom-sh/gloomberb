import type { PluginRegistry } from "../../plugins/registry";
import { fuzzyFilter } from "../../utils/fuzzy-search";
import type { ResultItem } from "./list/model";
import { summarizePaneSettingValue } from "../pane-settings-dialog/value";

/**
 * The focused pane's settings as root search results. The bar only finds a
 * setting: choosing one opens the pane settings dialog on it, where it is
 * changed the way the pane's `...` menu changes it.
 */
export function buildPaneSettingResultItems(options: {
  paneId: string | null;
  query: string;
  pluginRegistry: PluginRegistry;
  openPaneSettings: (paneId: string, fieldKey: string) => void;
}): ResultItem[] {
  if (!options.paneId) return [];
  const descriptor = options.pluginRegistry.resolvePaneSettings(options.paneId);
  if (!descriptor) return [];

  const category = descriptor.settingsDef.title || "Pane Settings";
  const paneLabel = descriptor.pane.title || descriptor.paneDef.name || descriptor.pane.paneId;
  const items = descriptor.settingsDef.fields.map((field): ResultItem => {
    const currentValue = descriptor.context.settings[field.key];
    const actionSearchText = field.type === "action"
      ? `${field.actionId} ${field.actionLabel ?? ""}`
      : "";
    return {
      id: `pane-setting:${field.key}`,
      label: field.label,
      detail: summarizePaneSettingValue(field, currentValue),
      category,
      kind: "action",
      right: field.type,
      searchText: `${category} ${paneLabel} ${field.label} ${field.description || ""} ${field.type} ${actionSearchText}`,
      disabled: field.type === "action" && field.disabled,
      action: () => options.openPaneSettings(descriptor.paneId, field.key),
    };
  });

  return options.query
    ? fuzzyFilter(items, options.query, (item) => `${item.label} ${item.detail} ${item.right || ""} ${item.searchText || ""}`)
    : items;
}
