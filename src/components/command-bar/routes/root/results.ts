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
  isQuestionLike,
  shouldShowAssistRow,
  type AssistRowHandlers,
} from "../../assist/model";
import { matchPrefix, type Command } from "../../commands/registry";
import { pastedRootList } from "../../commands/collection-list";
import { isCollectionCommand, SECURITY_DESCRIPTION_SEARCH } from "../../helpers";
import { recentPaneTemplateArg } from "../../pane-templates/items";
import { dedupeById, PASTED_LIST_CATEGORY } from "../../view-model";
import type { ResultItem } from "../../list/model";
import { commandShortcutQuery, shortcutArgument, type parseRootShortcutIntent } from "./shortcuts";
import type { CommandBarRoute } from "../../workflow/types";
import { createRootCommandItemBuilder } from "./command-items";
import { buildRootShortcutItem } from "./shortcut-items";
import { buildHelpArgumentItems } from "./help-items";
import { buildStartHereItems } from "./start-here";
import { showsCommandBarIntro } from "../../../../app/command-bar-intro";

type RootShortcutIntent = ReturnType<typeof parseRootShortcutIntent>;

interface PaneTemplateItemOptions {
  category?: string;
  createOptions?: PaneTemplateCreateOptions;
  showShortcut?: boolean;
  shortcutExecution?: boolean;
}

interface PaneShortcutItemsOptions {
  filterQuery?: string;
  /**
   * The query the rows are for: the functions kept out of browse are offered
   * too, as the catalog lists them, and one whose case it names opens on it.
   */
  searchedQuery?: string;
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
  /** Builds one select/pin ticker row for a recent symbol. */
  buildRecentTickerItem?: (symbol: string) => ResultItem | null;
  /** Offers to bind a key to the typed text once it resolves to a command; omit to hide the row. */
  bindKey?: (query: string) => void;
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
  /** The function code the query starts with, claimed by the parser or not (`leadingShortcutCode`). */
  leadingShortcutCode?: string | null;
  /** Looks a recorded `pane-template:<id>` entry back up among the templates the bar offers now. */
  getRecentPaneTemplate?: (id: string, arg?: string) => PaneTemplateDef | undefined;
  hasPaneSettings: (paneId: string) => boolean;
  localTickerSearchResultItems: (query?: string, options?: { category?: string; limit?: number }) => ResultItem[];
  nonShortcutPaneTemplateItems: (filterQuery?: string) => ResultItem[];
  openModeRoute: (screen: "ticker-search" | "layout", initialQuery?: string, payload?: Record<string, unknown>) => void;
  paneShortcutItems: (options?: PaneShortcutItemsOptions) => ResultItem[];
  pluginCommandItems: () => ResultItem[];
  pluginCommandResultItems: (command: CommandDef, shortcutArg: string) => ResultItem[];
  /**
   * The install row for a code only an official plugin the user lacks answers
   * to. It leads the list but claims nothing: the same text may be a ticker.
   */
  pluginInstallItem?: ResultItem | null;
  rootQuery: string;
  rootShortcutIntent: RootShortcutIntent;
  /**
   * Rows from plugin search providers, already ordered by provider priority.
   * Appended after the local matches so a late answer never moves the row the
   * user is aiming at, and only ever adds to what the bar already resolved.
   */
  providerResultItems?: ResultItem[];
  /**
   * Rows from providers that answer from memory, built with the keystroke. The
   * empty bar shows them under Suggested; typed text ranks them as one block
   * among the local matches, at the place of their best row.
   */
  providerMatchItems?: ResultItem[];
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
  leadingCode: string | null,
): boolean {
  if (!query.trim()) return false;
  if (assist.state.status !== "idle" && assist.state.query === query.trim()) return true;
  // A resolved shortcut is the user speaking the command language, so nothing is
  // asked of the AI, and a sign-up offer must not outrank that exact match.
  if (hasShortcutIntent) return false;
  if (!assist.enabled) {
    // Text led by a function code (`MOST foo`) is a command gone wrong, not a
    // question, so the sign-up offer would be the only row and take Enter.
    if (leadingCode && !isQuestionLike(query)) return false;
    // Signed out there is nothing to wait for, so the older heuristic still picks
    // the queries worth offering a sign-up row for.
    return shouldShowAssistRow({ query, resultCount });
  }
  return assist.auto;
}

/** "Add 4 symbols to a watchlist", which runs AW on the list as its entries, Bloomberg's codes kept whole. */
function pastedListItem(
  symbols: readonly string[],
  executeCollectionCommand: RootResultModelOptions["executeCollectionCommand"],
): ResultItem {
  const shown = symbols.slice(0, 6).join(", ");
  return {
    id: `pasted-list:${symbols.length}:${symbols[0]}`,
    label: `Add ${symbols.length} symbols to a watchlist`,
    detail: symbols.length > 6 ? `${shown} and ${symbols.length - 6} more` : shown,
    category: PASTED_LIST_CATEGORY,
    kind: "action",
    action: () => { void executeCollectionCommand("add-watchlist", symbols.join(", ")); },
  };
}

/**
 * The text a key would replay. An inferred ticker is left out on purpose: the
 * key should follow the focused ticker at press time, not freeze today's.
 */
function buildBindKeyItem(
  intent: Exclude<RootShortcutIntent, { kind: "none" }>,
  bindKey: (query: string) => void,
): ResultItem {
  const query = intent.kind !== "inferred-complete" && intent.argText
    ? `${intent.prefix} ${intent.argText}`
    : intent.prefix;
  return {
    id: `bind-key:${query}`,
    label: `Bind a key to ${query}`,
    detail: intent.kind === "inferred-complete"
      ? `${intent.label} for the focused ticker, on a key of your choice`
      : `${intent.label}, on a key of your choice`,
    category: "Keybindings",
    kind: "action",
    defaultSelectable: false,
    action: () => bindKey(query),
  };
}

/**
 * Ranks a provider's in-memory rows with the local matches without reordering
 * them: the provider decided which rows answer and in what order, so the block
 * moves as one to where its best row would rank. A block none of whose rows
 * the bar's own matching finds still shows, after the local matches.
 */
function rankMatchBlock(
  localItems: ResultItem[],
  blockItems: ResultItem[],
  query: string,
): ResultItem[] {
  if (blockItems.length === 0) {
    return fuzzyFilter(localItems, query, rootItemSearchText, (item) => item.label);
  }
  const block = new Set(blockItems);
  const ranked = fuzzyFilter([...localItems, ...blockItems], query, rootItemSearchText, (item) => item.label);
  const firstBlockIndex = ranked.findIndex((item) => block.has(item));
  const local = ranked.filter((item) => !block.has(item));
  if (firstBlockIndex < 0) return [...local, ...blockItems];
  return [...local.slice(0, firstBlockIndex), ...blockItems, ...local.slice(firstBlockIndex)];
}

function rootItemSearchText(item: ResultItem): string {
  return `${item.label} ${item.searchText || ""} ${item.detail} ${item.right || ""}`;
}

/** Kept short: the empty bar is still a browse list of everything below. */
const MAX_RECENT_TICKER_ROWS = 4;
const MAX_RECENT_PANE_ROWS = 4;

function buildRecentResultItems(options: {
  buildRecentTickerItem?: (symbol: string) => ResultItem | null;
  createPaneTemplateItem: (template: PaneTemplateDef, options?: PaneTemplateItemOptions) => ResultItem;
  getRecentPaneTemplate?: (id: string, arg?: string) => PaneTemplateDef | undefined;
  recentCommands: AppState["config"]["recentCommands"];
  recentTickers: string[];
}): { items: ResultItem[]; codes: string[] } {
  const {
    buildRecentTickerItem = () => null,
    createPaneTemplateItem,
    getRecentPaneTemplate = () => undefined,
    recentCommands,
    recentTickers,
  } = options;
  const items: ResultItem[] = [];
  // The codes of the recent panes that open as their code alone does, which the groups below then leave out.
  const codes: string[] = [];
  for (const symbol of recentTickers) {
    if (items.length >= MAX_RECENT_TICKER_ROWS) break;
    const item = buildRecentTickerItem(symbol);
    if (item) items.push({ ...item, category: "Suggested" });
  }
  let paneRows = 0;
  for (const recent of recentCommands) {
    if (paneRows >= MAX_RECENT_PANE_ROWS) break;
    if (!recent.id.startsWith("pane-template:")) continue;
    // Only a template the bar would offer now: its plugin enabled, and able
    // to open for that argument.
    const template = getRecentPaneTemplate(recent.id.slice("pane-template:".length), recent.arg);
    if (!template) continue;
    const arg = recentPaneTemplateArg(template, recent.arg);
    const item = createPaneTemplateItem(template, {
      showShortcut: true,
      ...(arg ? { createOptions: { arg } } : {}),
    });
    items.push({
      ...item,
      id: arg ? `recent:${recent.id}:${arg}` : `recent:${recent.id}`,
      label: arg ? `${item.label} ${arg}` : item.label,
      category: "Suggested",
    });
    if (!arg && item.shortcutQuery) codes.push(item.shortcutQuery.toUpperCase());
    paneRows += 1;
  }
  return { items, codes };
}

export function buildRootResultModel(options: RootResultModelOptions): RootResultModel {
  const {
    activeCollectionId,
    activeTickerData,
    activeTickerSymbol,
    assist,
    availableCommands,
    bindKey,
    buildLayoutItems,
    buildRecentTickerItem,
    buildPaneSettingItems,
    buildWindowModeItems,
    createPaneTemplateItem,
    createPluginCommandItem,
    currentRoute,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    getRecentPaneTemplate,
    hasPaneSettings,
    leadingShortcutCode = null,
    localTickerSearchResultItems,
    nonShortcutPaneTemplateItems,
    openModeRoute,
    paneShortcutItems,
    pluginCommandItems,
    pluginCommandResultItems,
    pluginInstallItem,
    rootQuery,
    rootShortcutIntent,
    providerResultItems = [],
    providerMatchItems = [],
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
  // A command typed after its ticker (`MC FP Equity DES`) lists as typed first (`DES MC:EPA`).
  const match = matchPrefix(commandShortcutQuery(rootQuery, rootShortcutIntent), availableCommands);
  // A pasted list, which the bar flattens into one line, leads with adding its symbols. The AI is still offered.
  const pastedList = rootShortcutIntent.kind === "none" && !match && rootQuery ? pastedRootList(rootQuery) : null;
  let initialIdx = 0;
  // Off when the code's own rows only say why the argument opens nothing (`PF Nope`).
  let shortcutRuns = true;
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
        createOptions: shortcutArgument(rootShortcutIntent) ? { arg: shortcutArgument(rootShortcutIntent) } : undefined,
        showShortcut: true,
        shortcutExecution: true,
      }))
      : [shortcutItem];
    shortcutRuns = templateItems.some((item) => !item.disabled);
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
    const dynamicItems = pluginCommandResultItems(rootShortcutIntent.command, rootShortcutIntent.argText);
    items.push(...(dynamicItems.length > 0 ? dynamicItems : [shortcutItem]));
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
        action: () => openModeRoute("ticker-search", "", SECURITY_DESCRIPTION_SEARCH),
      });
    } else if (match.arg) {
      items.push(...localTickerSearchResultItems(match.arg, { limit: 6 }));
    }
  } else if (match && isCollectionCommand(match.command.id)) {
    if (shortcutItem) items.push(shortcutItem);
  } else if (match && match.command.id === "help") {
    // HELP alone is the Help pane; HELP <fn> leads with the function's card.
    const helpItems = buildHelpArgumentItems(match.arg);
    items.push(...helpItems);
    if (!match.arg || helpItems.every((item) => item.disabled)) {
      const item = commandToItem(match.command);
      if (item) items.push(item);
    }
  } else if (match && !match.command.hasArg) {
    const item = commandToItem(match.command);
    if (item) items.push(item);
  } else if (!rootQuery) {
    // One row per function: a code a group above already runs as it is (a
    // recent CHAT, Start Here's PF) is not listed again in the groups below.
    const listedCodes = new Set<string>();
    const unlisted = (item: ResultItem) => !item.shortcutQuery || !listedCodes.has(item.shortcutQuery.toUpperCase());
    if (rootShortcutIntent.kind === "none") {
      const recent = buildRecentResultItems({
        buildRecentTickerItem,
        createPaneTemplateItem,
        getRecentPaneTemplate,
        recentCommands: state.config.recentCommands ?? [],
        recentTickers: state.recentTickers ?? [],
      });
      items.push(...recent.items);
      for (const code of recent.codes) listedCodes.add(code);
    }
    items.push(...providerMatchItems);
    // Plain-word rows for the common first tasks, ahead of the codes, for the
    // first opens only. Each runs what its code's own row runs.
    if (showsCommandBarIntro(state.config)) {
      const startHere = buildStartHereItems({
        templatesForCode: getAvailablePaneShortcutTemplates,
        createTemplateItem: (template) => createPaneTemplateItem(template, { showShortcut: true }),
        lookUpCompany: availableCommands.some((command) => command.id === "security-description")
          ? () => openModeRoute("ticker-search", "", SECURITY_DESCRIPTION_SEARCH)
          : null,
      }).filter(unlisted);
      items.push(...startHere);
      for (const item of startHere) if (item.shortcutQuery) listedCodes.add(item.shortcutQuery.toUpperCase());
    }
    items.push(...paneShortcutItems().filter(unlisted));
    for (const command of availableCommands) {
      const item = commandToItem(command);
      if (item && unlisted(item)) items.push(item);
    }
    items.push(...tickerActionItems());
    items.push(...pluginCommandItems());
  } else {
    // Quit answers only its own words, `quit` and `exit` (matched above): a
    // partial query (`q`, `e`, `ex`) never makes it the row Enter runs.
    const commandItems = availableCommands
      .filter((command) => command.id !== "quit")
      .map((command) => commandToItem(command))
      .filter((item): item is ResultItem => item !== null);
    const pluginItems = pluginCommandItems();
    // A layout action that is also a command (Add a Desk, DESK) is listed once, as the command.
    const commandRows = new Set([...commandItems, ...pluginItems].map((item) => `${item.label}\u0000${item.right ?? ""}`));
    const allItems = [
      ...commandItems,
      ...buildLayoutItems("", { confirmDangerousActions: true })
        .filter((item) => !commandRows.has(`${item.label}\u0000${item.right ?? ""}`)),
      ...buildPaneSettingItems(state.focusedPaneId, rootQuery),
      ...paneShortcutItems({ includePromptableTickerTemplates: true, searchedQuery: rootQuery }),
      ...nonShortcutPaneTemplateItems(),
      ...tickerActionItems(),
      ...pluginItems,
    ];
    if (pastedList) items.push(pastedListItem(pastedList, executeCollectionCommand));
    items.push(...rankMatchBlock(allItems, providerMatchItems, rootQuery));
  }

  const shortcutClaimedQuery = rootShortcutIntent.kind !== "none";
  // Counted before the provider rows: they arrive whenever the network answers,
  // and an assist offer must not appear and vanish as they land.
  const matchCount = items.length;
  // Text the parser can run is text a key can run, so the offer sits under the
  // match it would replay. Never the default selection: Enter still runs the
  // command itself.
  if (bindKey && shortcutClaimedQuery && shortcutRuns && rootShortcutIntent.kind !== "ambiguous") {
    items.push(buildBindKeyItem(rootShortcutIntent, bindKey));
  }
  // A resolved prefix means the user is speaking the command language, so
  // only providers that asked to answer after that code add rows, below the
  // code's own.
  if (shortcutClaimedQuery) {
    items.push(...providerMatchItems);
  }
  items.push(...providerResultItems);

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
      leadingShortcutCode,
    )
    ? buildAssistResultItems({ ...assist, query: rootQuery })
    : [];

  // Added last, so everything above is built exactly as it would be without
  // it; its section sorts ahead of the rest.
  const installItems = pluginInstallItem ? [pluginInstallItem] : [];
  return { items: dedupeById([...installItems, ...assistItems, ...items]), initialIdx };
}
