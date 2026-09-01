import type { AppState } from "../../../../state/app/context";
import type {
  CommandDef,
  PaneTemplateCreateOptions,
  PaneTemplateDef,
} from "../../../../types/plugin";
import type { TickerRecord } from "../../../../types/ticker";
import { fuzzyFilter } from "../../../../utils/fuzzy-search";
import {
  buildAssistResultItems,
  shouldShowAssistRow,
  type AssistRowHandlers,
} from "../../assist/model";
import { matchPrefix, type Command } from "../../commands/registry";
import { isCollectionCommand } from "../../helpers";
import { dedupeById } from "../../view-model";
import type { ResultItem } from "../../list/model";
import type { parseRootShortcutIntent } from "./shortcuts";
import type { CommandBarRoute } from "../../workflow/types";
import { createRootCommandItemBuilder } from "./command-items";
import { buildRootShortcutItem } from "./shortcut-items";

type RootShortcutIntent = ReturnType<typeof parseRootShortcutIntent>;

/** The ART plugin command claims the prefix, so article rows must still be shown. */
export function isArticleLookupShortcut(intent: RootShortcutIntent): boolean {
  return intent.kind !== "none"
    && intent.source === "plugin-command"
    && intent.command.id === "open-news-article";
}

interface PaneTemplateItemOptions {
  category?: string;
  createOptions?: PaneTemplateCreateOptions;
  showShortcut?: boolean;
  shortcutExecution?: boolean;
}

interface PaneShortcutItemsOptions {
  filterQuery?: string;
  createOptions?: PaneTemplateCreateOptions;
  includePromptableTickerTemplates?: boolean;
}

export interface RootResultModel {
  items: ResultItem[];
  initialIdx: number;
}

export interface RootResultModelOptions {
  activeCollectionId: string | null;
  activeTickerData: TickerRecord | null | undefined;
  activeTickerSymbol: string | null;
  /** Natural-language fallback rows; omit to build the list without an AI section. */
  assist?: AssistRowHandlers | null;
  availableCommands: Command[];
  buildLayoutItems: (query: string, options?: { confirmDangerousActions?: boolean }) => ResultItem[];
  buildPaneSettingItems: (paneId: string | null, query: string) => ResultItem[];
  buildWindowModeItems: (arg: string) => ResultItem[];
  createPaneTemplateItem: (template: PaneTemplateDef, options?: PaneTemplateItemOptions) => ResultItem;
  createPluginCommandItem: (command: CommandDef, options?: { shortcutArg?: string }) => ResultItem;
  currentRoute: CommandBarRoute | null;
  executeCollectionCommand: (
    commandId: "add-watchlist" | "add-portfolio" | "remove-watchlist" | "remove-portfolio",
    rawInput?: string,
  ) => void | Promise<void>;
  getAvailablePaneShortcutTemplates: (query: string) => PaneTemplateDef[];
  hasPaneSettings: (paneId: string) => boolean;
  localTickerSearchResultItems: (query?: string, options?: { category?: string; limit?: number }) => ResultItem[];
  nonShortcutPaneTemplateItems: (filterQuery?: string) => ResultItem[];
  openModeRoute: (screen: "ticker-search" | "layout", initialQuery?: string) => void;
  paneShortcutItems: (options?: PaneShortcutItemsOptions) => ResultItem[];
  pluginCommandItems: () => ResultItem[];
  pluginCommandResultItems: (command: CommandDef, shortcutArg: string) => ResultItem[];
  rootQuery: string;
  rootShortcutIntent: RootShortcutIntent;
  articleResultItems?: ResultItem[];
  /**
   * Rows from plugin search providers, already ordered by provider priority.
   * Appended after the local matches so a late answer never moves the row the
   * user is aiming at, and only ever adds to what the bar already resolved.
   */
  providerResultItems?: ResultItem[];
  runDirectCommand: (command: Command, arg: string) => void;
  runSecurityDescriptionShortcut: (query?: string) => void | Promise<void>;
  state: AppState;
  tickerActionItems: () => ResultItem[];
}

/** An in-flight or answered request keeps its rows even if the heuristic lapses. */
function isAssistSectionVisible(
  assist: AssistRowHandlers,
  query: string,
  resultCount: number,
  hasShortcutIntent: boolean,
): boolean {
  if (!query.trim()) return false;
  if (assist.state.status !== "idle" && assist.state.query === query.trim()) return true;
  // A resolved shortcut is the user speaking the command language, so nothing is
  // asked of the AI, and a sign-up offer must not outrank that exact match.
  if (hasShortcutIntent) return false;
  // Signed out there is nothing to wait for, so the older heuristic still picks
  // the queries worth offering a sign-up row for.
  if (!assist.enabled) return shouldShowAssistRow({ query, resultCount });
  return assist.auto;
}

export function buildRootResultModel(options: RootResultModelOptions): RootResultModel {
  const {
    activeCollectionId,
    activeTickerData,
    activeTickerSymbol,
    assist,
    availableCommands,
    buildLayoutItems,
    buildPaneSettingItems,
    buildWindowModeItems,
    createPaneTemplateItem,
    createPluginCommandItem,
    currentRoute,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    hasPaneSettings,
    localTickerSearchResultItems,
    nonShortcutPaneTemplateItems,
    openModeRoute,
    paneShortcutItems,
    pluginCommandItems,
    pluginCommandResultItems,
    rootQuery,
    rootShortcutIntent,
    articleResultItems = [],
    providerResultItems = [],
    runDirectCommand,
    runSecurityDescriptionShortcut,
    state,
    tickerActionItems,
  } = options;

  if (currentRoute) {
    return { items: [], initialIdx: 0 };
  }

  const commandToItem = createRootCommandItemBuilder({
    activeCollectionId,
    activeTickerData,
    activeTickerSymbol,
    hasPaneSettings,
    runDirectCommand,
    state,
  });

  const items: ResultItem[] = [];
  const match = matchPrefix(rootQuery, availableCommands);
  let initialIdx = 0;
  const shortcutItem = buildRootShortcutItem({
    activeCollectionId,
    activeTickerSymbol,
    createPaneTemplateItem,
    createPluginCommandItem,
    executeCollectionCommand,
    rootShortcutIntent,
    runSecurityDescriptionShortcut,
    state,
  });

  if (rootShortcutIntent.kind !== "none" && rootShortcutIntent.source === "pane-template" && shortcutItem) {
    const matchingTemplates = getAvailablePaneShortcutTemplates(rootQuery);
    const templateItems = matchingTemplates.length > 0
      ? matchingTemplates.map((template) => createPaneTemplateItem(template, {
        category: "Panes",
        createOptions: rootShortcutIntent.argText ? { arg: rootShortcutIntent.argText } : undefined,
        showShortcut: true,
        shortcutExecution: true,
      }))
      : [shortcutItem];
    const relatedTemplateItems = rootQuery.trim().toUpperCase() === rootShortcutIntent.prefix
      ? paneShortcutItems({
        filterQuery: rootQuery,
        includePromptableTickerTemplates: true,
      })
      : [];
    items.push(...templateItems, ...relatedTemplateItems);
  } else if (
    rootShortcutIntent.kind !== "none"
    && rootShortcutIntent.source === "plugin-command"
    && shortcutItem
  ) {
    if (isArticleLookupShortcut(rootShortcutIntent)) {
      items.push(shortcutItem);
    } else {
      const dynamicItems = pluginCommandResultItems(rootShortcutIntent.command, rootShortcutIntent.argText);
      items.push(...(dynamicItems.length > 0 ? dynamicItems : [shortcutItem]));
    }
    } else if (match && match.command.id === "layout") {
    items.push(...buildLayoutItems(match.arg, { confirmDangerousActions: true }));
  } else if (match && match.command.id === "window-mode") {
    items.push(...buildWindowModeItems(match.arg));
  } else if (match && match.command.id === "theme") {
    initialIdx = 0;
  } else if (match && match.command.id === "language") {
    const item = commandToItem(match.command, match.arg);
    if (item) items.push(item);
  } else if (match && match.command.id === "security-description") {
    if (shortcutItem) {
      items.push(shortcutItem);
    }
    if (!match.arg && !shortcutItem) {
      items.push({
        id: "search-hint",
        label: "Type a ticker symbol",
        detail: "Open security details after resolving a ticker",
        category: "Search",
        kind: "command",
        action: () => openModeRoute("ticker-search", ""),
      });
    } else if (match.arg) {
      items.push(...localTickerSearchResultItems(match.arg, { limit: 6 }));
    }
  } else if (match && isCollectionCommand(match.command.id)) {
    if (shortcutItem) items.push(shortcutItem);
  } else if (match && !match.command.hasArg) {
    const item = commandToItem(match.command);
    if (item) items.push(item);
  } else if (!rootQuery) {
    items.push(...paneShortcutItems());
    for (const command of availableCommands) {
      const item = commandToItem(command);
      if (item) items.push(item);
    }
    items.push(...tickerActionItems());
    items.push(...pluginCommandItems());
  } else {
    const commandItems = availableCommands
      .map((command) => commandToItem(command))
      .filter((item): item is ResultItem => item !== null);
    const allItems = [
      ...commandItems,
      ...buildLayoutItems("", { confirmDangerousActions: true }),
      ...buildPaneSettingItems(state.focusedPaneId, rootQuery),
      ...paneShortcutItems({ includePromptableTickerTemplates: true }),
      ...nonShortcutPaneTemplateItems(),
      ...tickerActionItems(),
      ...pluginCommandItems(),
    ];
    const matchedItems = fuzzyFilter(
      allItems,
      rootQuery,
      (item) => `${item.label} ${item.searchText || ""} ${item.detail} ${item.right || ""}`,
      (item) => item.label,
    );
    items.push(...matchedItems);
  }

  const shortcutClaimedQuery = rootShortcutIntent.kind !== "none"
    && !isArticleLookupShortcut(rootShortcutIntent);
  if (!shortcutClaimedQuery) {
    items.push(...articleResultItems);
  }
  // Counted before the provider rows: they arrive whenever the network answers,
  // and an assist offer must not appear and vanish as they land.
  const matchCount = items.length;
  // A resolved prefix means the user is speaking the command language, so
  // free-text providers stay out of the way.
  if (!shortcutClaimedQuery) {
    items.push(...providerResultItems);
  }

  // Built from the local matches, then placed above them: the AI turns the
  // typed sentence into commands, so its answer leads the list. Its Thinking
  // placeholder holds the rows from the start, and the root selection effect
  // follows rows by identity when the answer renumbers what sits below.
  const assistItems = assist
    && isAssistSectionVisible(
      assist,
      rootQuery,
      matchCount,
      shortcutClaimedQuery,
    )
    ? buildAssistResultItems({ ...assist, query: rootQuery })
    : [];

  return { items: dedupeById([...assistItems, ...items]), initialIdx };
}
