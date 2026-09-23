import type { PluginRegistry } from "../../../plugins/registry";
import type {
  PaneTemplateContext,
  PaneTemplateCreateOptions,
  PaneTemplateDef,
} from "../../../types/plugin";
import { fuzzyFilter } from "../../../utils/fuzzy-search";
import { summarizeError } from "../helpers";
import type { ResultItem } from "../list/model";

type LogErrorFn = (message: string, details: Record<string, unknown>) => void;

/** The primary shortcut prefix and its aliases, in that order. */
export function paneTemplateShortcutPrefixes(template: Pick<PaneTemplateDef, "shortcut">): string[] {
  if (!template.shortcut?.prefix) return [];
  return [template.shortcut.prefix, ...(template.shortcut.aliases ?? [])].filter((prefix) => prefix.trim().length > 0);
}

export function getPaneTemplateDisplayLabel(template: Pick<PaneTemplateDef, "label">): string {
  let label = template.label.trim();
  if (label.startsWith("New ")) label = label.slice(4);
  if (label.endsWith(" Pane")) label = label.slice(0, -5);
  return label;
}

export function getPaneTemplateArgKind(template: PaneTemplateDef): string | undefined {
  return template.shortcut?.argKind ?? template.shortcut?.argPlaceholder;
}

export function canPromptForPaneTemplateArg(template: PaneTemplateDef): boolean {
  const argKind = getPaneTemplateArgKind(template);
  return argKind === "ticker"
    || argKind === "ticker-list"
    || argKind === "tickers"
    || argKind === "text"
    || argKind === "query";
}

export function buildPaneTemplateContext(options: {
  config: PaneTemplateContext["config"];
  focusedPaneId: string | null;
  activeTicker: string | null;
  activeCollectionId: string | null;
}): PaneTemplateContext {
  return {
    config: options.config,
    layout: options.config.layout,
    focusedPaneId: options.focusedPaneId,
    activeTicker: options.activeTicker,
    activeCollectionId: options.activeCollectionId,
  };
}

export function getAvailablePaneTemplatesForState(options: {
  pluginRegistry: PluginRegistry;
  disabledPlugins: readonly string[];
  context: PaneTemplateContext;
  createOptions?: PaneTemplateCreateOptions;
  includePromptableTickerTemplates?: boolean;
  logError?: LogErrorFn;
}): PaneTemplateDef[] {
  const disabledPluginIds = new Set(options.disabledPlugins);
  return [...options.pluginRegistry.paneTemplates.values()]
    .filter((template) => {
      const pluginId = options.pluginRegistry.getPaneTemplatePluginId(template.id);
      if (pluginId && disabledPluginIds.has(pluginId)) return false;
      if (!template.canCreate) return true;
      try {
        const canCreate = template.canCreate(options.context, options.createOptions);
        if (canCreate) return true;
        return !!options.includePromptableTickerTemplates
          && !options.createOptions?.arg
          && !options.context.activeTicker
          && canPromptForPaneTemplateArg(template);
      } catch (error) {
        options.logError?.("Pane template canCreate failed", {
          templateId: template.id,
          pluginId,
          options: options.createOptions,
          error: summarizeError(error),
        });
        return false;
      }
    });
}

export function getAvailablePaneShortcutTemplatesForQuery(options: {
  pluginRegistry: PluginRegistry;
  disabledPlugins: readonly string[];
  context: PaneTemplateContext;
  query: string;
  logError?: LogErrorFn;
}): PaneTemplateDef[] {
  const trimmed = options.query.trim();
  const upper = trimmed.toUpperCase();
  const disabledPluginIds = new Set(options.disabledPlugins);
  return [...options.pluginRegistry.paneTemplates.values()].filter((template) => {
    const pluginId = options.pluginRegistry.getPaneTemplatePluginId(template.id);
    if (pluginId && disabledPluginIds.has(pluginId)) return false;
    const argKind = getPaneTemplateArgKind(template);
    // The longest matching mnemonic wins, so an alias sharing a stem cannot shadow the typed one.
    const prefix = paneTemplateShortcutPrefixes(template).map((value) => value.toUpperCase())
      .filter((value) => upper === value || (!!argKind && upper.startsWith(`${value} `)))
      .sort((a, b) => b.length - a.length)[0];
    if (!prefix) return false;
    const arg = trimmed.slice(prefix.length).trim();
    if (!template.canCreate) return true;
    try {
      const canCreate = template.canCreate(options.context, arg ? { arg } : undefined);
      if (canCreate) return true;
      if (!arg && !options.context.activeTicker && canPromptForPaneTemplateArg(template)) {
        return true;
      }
      return false;
    } catch (error) {
      options.logError?.("Pane shortcut canCreate failed", {
        templateId: template.id,
        query: options.query,
        error: summarizeError(error),
      });
      return false;
    }
  });
}

export function buildPaneTemplateItem(options: {
  template: PaneTemplateDef;
  pluginRegistry: PluginRegistry;
  category?: string;
  createOptions?: PaneTemplateCreateOptions;
  showShortcut?: boolean;
  shortcutExecution?: boolean;
  runPaneTemplateShortcut: (template: PaneTemplateDef, rawArg?: string) => void;
  shouldOpenTemplateConfig: (template: PaneTemplateDef, arg?: string) => boolean;
  openPaneTemplateWorkflow: (template: PaneTemplateDef, options?: { arg?: string }) => void;
  openPaneTemplateDirect: (
    template: PaneTemplateDef,
    createOptions?: PaneTemplateCreateOptions,
  ) => void;
}): ResultItem {
  const pluginId = options.pluginRegistry.getPaneTemplatePluginId(options.template.id);
  const pluginName = pluginId ? options.pluginRegistry.allPlugins.get(pluginId)?.name : null;
  const displayLabel = getPaneTemplateDisplayLabel(options.template);
  const shortcutLabel = options.template.shortcut
    ? [options.template.shortcut.prefix, options.template.shortcut.argPlaceholder && `<${options.template.shortcut.argPlaceholder}>`]
      .filter(Boolean)
      .join(" ")
    : null;
  const arg = options.createOptions?.arg;
  const aliases = options.template.shortcut?.aliases ?? [];
  const searchText = [
    options.template.keywords?.join(" ") || "",
    displayLabel,
    options.template.label,
    options.template.paneId,
    shortcutLabel || "",
    ...aliases,
    pluginName || "",
  ].filter(Boolean).join(" ");

  const action = () => {
    if (
      options.template.shortcut
      && (options.shortcutExecution || getPaneTemplateArgKind(options.template) === "ticker")
    ) {
      options.runPaneTemplateShortcut(options.template, arg);
      return;
    }
    if (options.shouldOpenTemplateConfig(options.template, arg)) {
      options.openPaneTemplateWorkflow(options.template, { arg });
      return;
    }
    options.openPaneTemplateDirect(options.template, options.createOptions);
  };

  return {
    id: `pane-template:${options.template.id}:${arg || ""}`,
    label: displayLabel,
    detail: [options.template.description, shortcutLabel, aliases.length ? `also ${aliases.join(", ")}` : ""].filter(Boolean).join(" · "),
    category: options.category ?? (pluginName ? `${pluginName} Panes` : "Panes"),
    kind: "action",
    right: options.showShortcut ? options.template.shortcut?.prefix : undefined,
    shortcutQuery: options.template.shortcut?.prefix,
    searchText,
    action,
  };
}

export function buildPaneShortcutItems(options: {
  templates: readonly PaneTemplateDef[];
  filterQuery?: string;
  createOptions?: PaneTemplateCreateOptions;
  createItem: (template: PaneTemplateDef, options?: {
    category?: string;
    createOptions?: PaneTemplateCreateOptions;
    showShortcut?: boolean;
  }) => ResultItem;
}): ResultItem[] {
  const items = options.templates
    .filter((template) => template.shortcut)
    .map((template) => options.createItem(template, {
      category: "Panes",
      createOptions: options.createOptions,
      showShortcut: true,
    }));

  return options.filterQuery
    ? fuzzyFilter(items, options.filterQuery, (item) => `${item.label} ${item.searchText || ""} ${item.detail} ${item.right || ""}`)
    : items;
}

export function buildNonShortcutPaneTemplateItems(options: {
  templates: readonly PaneTemplateDef[];
  filterQuery?: string;
  createItem: (template: PaneTemplateDef, options?: { category?: string }) => ResultItem;
}): ResultItem[] {
  const items = options.templates
    .filter((template) => !template.shortcut)
    .map((template) => options.createItem(template, { category: "Panes" }));

  return options.filterQuery
    ? fuzzyFilter(items, options.filterQuery, (item) => `${item.label} ${item.searchText || ""} ${item.detail} ${item.right || ""}`)
    : items;
}
