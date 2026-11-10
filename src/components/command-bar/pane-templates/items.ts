import type { PluginRegistry } from "../../../plugins/registry";
import type {
  PaneTemplateContext,
  PaneTemplateCreateOptions,
  PaneTemplateDef,
  ShortcutArgError,
} from "../../../types/plugin";
import { fuzzyFilter } from "../../../utils/fuzzy-search";
import { discoveryOpening } from "../../../utils/lookup-token";
import { summarizeError } from "../helpers";
import type { ResultItem } from "../list/model";
import { tickerFirstQuery } from "../routes/root/ticker-first";

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

/**
 * The argument a recent pane run keeps: a ticker or ticker list only. Free
 * text (an Ask Gloom question, EXPO weights, a portfolio id, a search) would
 * otherwise land in config.json, its exports and cloud sync.
 */
export function recentPaneTemplateArg(template: PaneTemplateDef, arg: string | undefined): string | undefined {
  const argKind = getPaneTemplateArgKind(template);
  if (argKind !== "ticker" && argKind !== "ticker-list" && argKind !== "tickers") return undefined;
  return arg?.trim().toUpperCase() || undefined;
}

/** Why a typed argument opens nothing for the template (`PF Nope`), or null. */
export function paneTemplateArgError(
  template: PaneTemplateDef,
  arg: string | undefined,
  context: PaneTemplateContext,
): ShortcutArgError | null {
  const trimmed = arg?.trim();
  return trimmed ? template.shortcut?.argError?.(trimmed, context) ?? null : null;
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

/**
 * "ETF flows", "etf flows bitcoin" and "bitcoin etf" spell out ETFF (Crypto
 * ETF Flows), not ETF for a ticker called FLOWS or BITCOIN: a query whose
 * words are all words of one keyword, in any order, of a template whose own
 * code extends the typed one is no ticker argument, and is left to the
 * search, which ranks that template first. "ETF IBIT" stays Fund Facts for
 * IBIT, since no keyword of ETFF holds both words, and "JOBS DAY" stays Jobs
 * for Dayforce, since the template that lists "jobs day" (MDAY) does not
 * extend JOBS.
 */
function spellsOutLongerCode(query: string, code: string, templates: readonly PaneTemplateDef[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return templates.some((template) => {
    const longer = template.shortcut?.prefix?.trim().toUpperCase() ?? "";
    return longer.length > code.length && longer.startsWith(code)
      && !!template.keywords?.some((keyword) => {
        const keywordWords = new Set(keyword.toLowerCase().split(/\s+/));
        return words.every((word) => keywordWords.has(word));
      });
  });
}

export function getAvailablePaneShortcutTemplatesForQuery(options: {
  pluginRegistry: PluginRegistry;
  disabledPlugins: readonly string[];
  context: PaneTemplateContext;
  query: string;
  logError?: LogErrorFn;
}): PaneTemplateDef[] {
  const disabledPluginIds = new Set(options.disabledPlugins);
  const enabled = [...options.pluginRegistry.paneTemplates.values()].filter((template) => {
    const pluginId = options.pluginRegistry.getPaneTemplatePluginId(template.id);
    return !pluginId || !disabledPluginIds.has(pluginId);
  });
  const typed = matchingShortcutTemplates(options, enabled, options.query.trim());
  if (typed.length > 0) return typed;
  // Bloomberg's order, the ticker first (`NFE CDS`), is the code's with that ticker.
  const reordered = tickerFirstQuery(options.query, (code) => enabled.some((template) => {
    const argKind = getPaneTemplateArgKind(template);
    return (argKind === "ticker" || argKind === "ticker-list" || (argKind === "text" && template.shortcut?.focusedIssuer === true))
      && paneTemplateShortcutPrefixes(template).some((prefix) => prefix.toUpperCase() === code);
  }));
  return reordered ? matchingShortcutTemplates(options, enabled, reordered) : [];
}

function matchingShortcutTemplates(
  options: { context: PaneTemplateContext; query: string; logError?: LogErrorFn },
  enabled: readonly PaneTemplateDef[],
  trimmed: string,
): PaneTemplateDef[] {
  const upper = trimmed.toUpperCase();
  return enabled.filter((template) => {
    const argKind = getPaneTemplateArgKind(template);
    // The longest matching mnemonic wins, so an alias sharing a stem cannot shadow the typed one.
    const prefix = paneTemplateShortcutPrefixes(template).map((value) => value.toUpperCase())
      .filter((value) => upper === value || (!!argKind && upper.startsWith(`${value} `)))
      .sort((a, b) => b.length - a.length)[0];
    if (!prefix) return false;
    const arg = trimmed.slice(prefix.length).trim();
    if (argKind === "ticker" && arg && spellsOutLongerCode(trimmed, prefix, enabled)) return false;
    if (!template.canCreate) return true;
    try {
      const canCreate = template.canCreate(options.context, arg ? { arg } : undefined);
      if (canCreate) return true;
      // A code typed with an argument it cannot open (`CMP AAPL` compares two
      // or more) is still that function: its row opens the form or says why,
      // where dropping it would leave the text to search and Ask AI.
      if (arg) return canPromptForPaneTemplateArg(template);
      return !options.context.activeTicker && canPromptForPaneTemplateArg(template);
    } catch (error) {
      options.logError?.("Pane shortcut canCreate failed", {
        templateId: template.id,
        query: trimmed,
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
  /** Why `createOptions.arg` opens nothing; the row then says so instead of opening the pane. */
  argError?: ShortcutArgError | null;
  runPaneTemplateShortcut: (template: PaneTemplateDef, rawArg?: string, preset?: PaneTemplateCreateOptions["preset"]) => void;
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
    ...paneTemplateDiscoveryWords(options.template, options.pluginRegistry),
  ].filter(Boolean).join(" ");

  if (options.argError) {
    return {
      id: `pane-template-arg-error:${options.template.id}:${arg || ""}`,
      label: options.argError.message,
      detail: options.argError.detail ?? "",
      // Under the label, where the bar shows a row's second line: what to type instead.
      ...(options.argError.detail ? { lines: [{ segments: [{ text: options.argError.detail }] }] } : {}),
      category: options.category ?? (pluginName ? `${pluginName} Panes` : "Panes"),
      // The function's own row, disabled: its code sits in the code column as on
      // the row that opens it, where an info row would carry it on the right.
      kind: "action",
      right: options.showShortcut ? options.template.shortcut?.prefix : undefined,
      shortcutQuery: options.template.shortcut?.prefix,
      searchText,
      defaultSelectable: false,
      disabled: true,
      action: () => {},
    };
  }

  const action = () => {
    if (
      options.template.shortcut
      && (options.shortcutExecution || getPaneTemplateArgKind(options.template) === "ticker")
    ) {
      options.runPaneTemplateShortcut(options.template, arg, options.createOptions?.preset);
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

/**
 * The words `gloom catalog` also finds a function by, beyond its keywords and
 * description: its headless discovery aliases, the words it is suggested for,
 * those that open one of its cases (CTM's "vix futures") and its intents. The
 * bar's row carries them, so the same words find the same function.
 */
function paneTemplateDiscoveryWords(template: PaneTemplateDef, registry: Pick<PluginRegistry, "panes">): string[] {
  const discovery = paneTemplateDiscovery(template, registry);
  if (!discovery) return [];
  return [
    ...discovery.aliases ?? [],
    ...discovery.suggestFor ?? [],
    ...discovery.opens?.flatMap((opening) => opening.words) ?? [],
    ...discovery.intents ?? [],
  ];
}

function paneTemplateDiscovery(template: PaneTemplateDef, registry: Pick<PluginRegistry, "panes">) {
  return (template.headless ?? registry.panes?.get(template.paneId)?.headless)?.discovery;
}

export function buildPaneShortcutItems(options: {
  templates: readonly PaneTemplateDef[];
  filterQuery?: string;
  /**
   * A typed query, filtered by the caller: it also finds the functions kept
   * out of the browse list (CTM, a tab of the futures workspace), as the
   * catalog does. A `filterQuery` is one too.
   */
  searchedQuery?: string;
  /** Where a template's headless discovery is found, for a query that names one of its cases. */
  registry?: Pick<PluginRegistry, "panes">;
  createOptions?: PaneTemplateCreateOptions;
  createItem: (template: PaneTemplateDef, options?: {
    category?: string;
    createOptions?: PaneTemplateCreateOptions;
    showShortcut?: boolean;
  }) => ResultItem;
}): ResultItem[] {
  const query = options.searchedQuery?.trim() || options.filterQuery?.trim() || "";
  // An unlisted template (`listed: false`) still opens when its code is typed, which is resolved apart from these rows.
  const items = options.templates
    .filter((template) => template.shortcut && (query || template.shortcut.showInBrowse !== false) && template.listed !== false)
    .map((template) => {
      // A query naming one of the function's cases opens it on that case, as `fn` runs it: `vix futures` is CTM VIX.
      const opening = query && options.registry ? discoveryOpening(paneTemplateDiscovery(template, options.registry), query) : null;
      const item = options.createItem(template, {
        category: "Panes",
        // Its preset options too, as `fn` applies them: `PDUFA` is CATL on PDUFA dates, not every catalyst.
        createOptions: opening
          ? { ...options.createOptions, arg: opening.argument, ...(opening.options ? { preset: opening.options } : {}) }
          : options.createOptions,
        showShortcut: true,
      });
      return opening && opening.argument && !item.disabled ? { ...item, name: opening.argument } : item;
    });

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
    .filter((template) => !template.shortcut && template.listed !== false)
    .map((template) => options.createItem(template, { category: "Panes" }));

  return options.filterQuery
    ? fuzzyFilter(items, options.filterQuery, (item) => `${item.label} ${item.searchText || ""} ${item.detail} ${item.right || ""}`)
    : items;
}
