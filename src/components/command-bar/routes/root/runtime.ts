import { useEffect, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ScrollBoxRenderable } from "../../../../ui";
import type { AppState } from "../../../../state/app/context";
import type { DataProvider } from "../../../../types/data-provider";
import type { CommandDef, PaneTemplateCreateOptions, PaneTemplateDef } from "../../../../types/plugin";
import type { TickerRecord } from "../../../../types/ticker";
import type { TickerSearchCandidate } from "../../../../tickers/search";
import type { AssistRowHandlers } from "../../assist/model";
import { matchPrefix, type Command } from "../../commands/registry";
import type { ResultItem } from "../../list/model";
import type { CommandBarRoute } from "../../workflow/types";
import { useTickerSearchRouteResults } from "../ticker-search/route";
import { buildRootResultModel, type RootResultModel } from "./results";
import { useRootProviderSearch } from "./provider-search";
import { buildRootShortcutFeedback } from "./shortcut-feedback";
import { parseRootShortcutIntent } from "./shortcuts";

interface UseCommandBarRootRuntimeOptions {
  activeCollectionId: string | null;
  activePortfolio?: AppState["config"]["portfolios"][number];
  activeTickerData: TickerRecord | null | undefined;
  activeTickerSymbol: string | null;
  assist: AssistRowHandlers;
  availableCommands: Command[];
  buildLayoutItems(query: string, options?: { confirmDangerousActions?: boolean }): ResultItem[];
  buildPaneSettingItems(paneId: string | null, query: string): ResultItem[];
  buildPluginItems(query: string): ResultItem[];
  buildTickerSearchResultItems(candidates: TickerSearchCandidate[], query: string): ResultItem[];
  buildWindowModeItems(arg: string): ResultItem[];
  createPaneTemplateItem(template: PaneTemplateDef, options?: {
    category?: string;
    createOptions?: PaneTemplateCreateOptions;
    showShortcut?: boolean;
    shortcutExecution?: boolean;
  }): ResultItem;
  createPluginCommandItem(command: CommandDef, options?: { shortcutArg?: string }): ResultItem;
  currentRoute: CommandBarRoute | null;
  dataProvider: DataProvider;
  executeCollectionCommand(
    commandId: "add-watchlist" | "add-portfolio" | "remove-watchlist" | "remove-portfolio",
    rawInput?: string,
  ): void | Promise<void>;
  getAvailablePaneShortcutTemplates(query: string): PaneTemplateDef[];
  getAvailablePluginCommands(): CommandDef[];
  getTickers(): AppState["tickers"];
  hasPaneSettings(paneId: string): boolean;
  localTickerSearchResultItems(query?: string, options?: { category?: string; limit?: number }): ResultItem[];
  nativeListScrollRef: RefObject<ScrollBoxRenderable | null>;
  nonShortcutPaneTemplateItems(filterQuery?: string): ResultItem[];
  openModeRoute(screen: "ticker-search" | "plugins" | "layout", initialQuery?: string): void;
  paneShortcutItems(options?: {
    filterQuery?: string;
    createOptions?: PaneTemplateCreateOptions;
    includePromptableTickerTemplates?: boolean;
  }): ResultItem[];
  pluginCommandItems(): ResultItem[];
  pluginCommandResultItems(command: CommandDef, shortcutArg: string): ResultItem[];
  readTickerSearchCache(
    query: string,
    brokerId?: string | null,
    brokerInstanceId?: string | null,
  ): TickerSearchCandidate[] | null;
  rootModeKind: string;
  rootQuery: string;
  runDirectCommand(command: Command, arg: string): void;
  runSecurityDescriptionShortcut(query?: string): void | Promise<void>;
  setRootHoveredIdx: Dispatch<SetStateAction<number | null>>;
  setRootSelectedIdx: Dispatch<SetStateAction<number>>;
  skipTickerSearchDebounceRef: RefObject<boolean>;
  state: AppState;
  tickerActionItems(): ResultItem[];
  writeTickerSearchCache(
    query: string,
    candidates: TickerSearchCandidate[],
    brokerId?: string | null,
    brokerInstanceId?: string | null,
  ): void;
}

export function useCommandBarRootRuntime({
  activeCollectionId,
  activePortfolio,
  activeTickerData,
  activeTickerSymbol,
  assist,
  availableCommands,
  buildLayoutItems,
  buildPaneSettingItems,
  buildPluginItems,
  buildTickerSearchResultItems,
  buildWindowModeItems,
  createPaneTemplateItem,
  createPluginCommandItem,
  currentRoute,
  dataProvider,
  executeCollectionCommand,
  getAvailablePaneShortcutTemplates,
  getAvailablePluginCommands,
  getTickers,
  hasPaneSettings,
  localTickerSearchResultItems,
  nativeListScrollRef,
  nonShortcutPaneTemplateItems,
  openModeRoute,
  paneShortcutItems,
  pluginCommandItems,
  pluginCommandResultItems,
  readTickerSearchCache,
  rootModeKind,
  rootQuery,
  runDirectCommand,
  runSecurityDescriptionShortcut,
  setRootHoveredIdx,
  setRootSelectedIdx,
  skipTickerSearchDebounceRef,
  state,
  tickerActionItems,
  writeTickerSearchCache,
}: UseCommandBarRootRuntimeOptions): {
  activeMatch: ReturnType<typeof matchPrefix>;
  orderedRootResults: ResultItem[];
  rootGhostSuffix: string | null;
  rootResultModel: RootResultModel;
  rootSearching: boolean;
  rootSectionOrder: ReturnType<typeof useRootProviderSearch>["rootSectionOrder"];
  rootShortcutFeedback: string | null;
  rootShortcutIntent: ReturnType<typeof parseRootShortcutIntent>;
  tickerSearchPending: boolean;
  tickerSearchResults: ResultItem[];
} {
  const previousRootSelectionContextRef = useRef<{ query: string; mode: string } | null>(null);
  const activeMatch = matchPrefix(rootQuery, availableCommands);

  const rootShortcutIntent = useMemo(() => parseRootShortcutIntent({
    query: rootQuery,
    commands: availableCommands,
    pluginCommands: getAvailablePluginCommands(),
    paneTemplates: getAvailablePaneShortcutTemplates(rootQuery),
    activeTicker: activeTickerSymbol,
  }), [activeTickerSymbol, availableCommands, getAvailablePaneShortcutTemplates, getAvailablePluginCommands, rootQuery]);

  const tickerSearchRouteQuery = currentRoute?.kind === "mode" && currentRoute.screen === "ticker-search"
    ? currentRoute.query
    : null;

  const {
    tickerSearchPending,
    tickerSearchResults,
  } = useTickerSearchRouteResults({
    brokerId: activePortfolio?.brokerId,
    brokerInstanceId: activePortfolio?.brokerInstanceId,
    buildTickerSearchResultItems,
    dataProvider,
    getTickers,
    localTickerSearchResultItems,
    readTickerSearchCache,
    routeQuery: tickerSearchRouteQuery,
    skipTickerSearchDebounceRef,
    writeTickerSearchCache,
  });

  const rootResultModel = useMemo(() => buildRootResultModel({
    activeCollectionId,
    activeTickerData,
    activeTickerSymbol,
    assist,
    availableCommands,
    buildLayoutItems,
    buildPaneSettingItems,
    buildPluginItems,
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
    runDirectCommand,
    runSecurityDescriptionShortcut,
    state,
    tickerActionItems,
  }), [
    activeCollectionId,
    activeTickerData,
    activeTickerSymbol,
    assist,
    availableCommands,
    buildLayoutItems,
    buildPaneSettingItems,
    buildPluginItems,
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
    runDirectCommand,
    runSecurityDescriptionShortcut,
    state,
    tickerActionItems,
  ]);

  const rootSecurityDescriptionArg = activeMatch?.command.id === "security-description" && activeMatch.arg.length >= 1
    ? activeMatch.arg
    : null;
  const rootTickerSearchArg = rootSecurityDescriptionArg;

  useEffect(() => {
    if (currentRoute) return;

    setRootHoveredIdx((current) => (current != null && current < rootResultModel.items.length ? current : null));
    const selectionContextChanged =
      previousRootSelectionContextRef.current?.query !== rootQuery
      || previousRootSelectionContextRef.current?.mode !== rootModeKind;
    if (activeMatch?.command.id === "plugins" || !selectionContextChanged) {
      setRootSelectedIdx((current) => Math.max(0, Math.min(current, rootResultModel.items.length - 1)));
    } else {
      setRootSelectedIdx(Math.max(0, Math.min(rootResultModel.initialIdx, rootResultModel.items.length - 1)));
    }
    previousRootSelectionContextRef.current = { query: rootQuery, mode: rootModeKind };
  }, [
    activeMatch?.command.id,
    currentRoute,
    rootModeKind,
    rootQuery,
    rootResultModel.initialIdx,
    rootResultModel.items.length,
    setRootHoveredIdx,
    setRootSelectedIdx,
  ]);

  const {
    activeRootProviderResultsKey,
    orderedRootResults,
    rootSearching,
    rootSectionOrder,
  } = useRootProviderSearch({
    activeCollectionId,
    buildTickerSearchResultItems,
    currentRoute,
    dataProvider,
    localTickerSearchResultItems,
    portfolios: state.config.portfolios,
    readTickerSearchCache,
    rootPlainTickerSearchArg: null,
    rootResultItems: rootResultModel.items,
    rootTickerSearchArg,
    tickers: state.tickers,
    writeTickerSearchCache,
  });

  useEffect(() => {
    if (!activeRootProviderResultsKey) return;
    setRootSelectedIdx(0);
    setRootHoveredIdx(null);
    nativeListScrollRef.current?.scrollTo(0);
  }, [activeRootProviderResultsKey, nativeListScrollRef, setRootHoveredIdx, setRootSelectedIdx]);

  const rootGhostCompletion = !currentRoute && rootShortcutIntent.kind === "inferred-complete"
    ? rootShortcutIntent.completionQuery
    : null;
  const rootGhostSuffix = rootGhostCompletion && rootGhostCompletion.startsWith(rootQuery)
    ? rootGhostCompletion.slice(rootQuery.length)
    : null;
  const rootShortcutFeedback = useMemo(() => buildRootShortcutFeedback({
    activeCollectionId,
    activeTickerSymbol,
    currentRoute,
    rootShortcutIntent,
    state,
  }), [activeCollectionId, activeTickerSymbol, currentRoute, rootShortcutIntent, state]);

  return {
    activeMatch,
    orderedRootResults,
    rootGhostSuffix,
    rootResultModel,
    rootSearching,
    rootSectionOrder,
    rootShortcutFeedback,
    rootShortcutIntent,
    tickerSearchPending,
    tickerSearchResults,
  };
}
