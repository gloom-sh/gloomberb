import { useEffect, useLayoutEffect, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ScrollBoxRenderable } from "../../../../ui";
import type { AppState } from "../../../../state/app/context";
import type { DataProvider } from "../../../../types/data-provider";
import type { CommandDef, PaneTemplateCreateOptions, PaneTemplateDef } from "../../../../types/plugin";
import type { TickerRecord } from "../../../../types/ticker";
import type { TickerSearchCandidate } from "../../../../tickers/search";
import type { AssistRowHandlers } from "../../assist/model";
import { matchPrefix, type Command } from "../../commands/registry";
import type { ResultItem } from "../../list/model";
import type { CommandBarCategoryPriorities } from "../../view-model";
import type { CommandBarRoute } from "../../workflow/types";
import { normalizeCommandTickerSearchText } from "../ticker-search/results";
import { useTickerSearchRouteResults } from "../ticker-search/route";
import { buildRootResultModel, type RootResultModel } from "./results";
import { useRootProviderSearch } from "./provider-search";
import { buildRootShortcutFeedback } from "./shortcut-feedback";
import type { ShortcutIntent } from "./shortcuts";

function clampSelectedIdx(index: number, length: number): number {
  return Math.max(0, Math.min(index, length - 1));
}

/** A row plain Enter can run, so the untouched selection may rest on it. */
function isDefaultSelectable(item: ResultItem): boolean {
  return item.disabled !== true && item.defaultSelectable !== false;
}

interface UseCommandBarRootRuntimeOptions {
  activeCollectionId: string | null;
  activePortfolio?: AppState["config"]["portfolios"][number];
  activeTickerData: TickerRecord | null | undefined;
  activeTickerSymbol: string | null;
  assist: AssistRowHandlers;
  availableCommands: Command[];
  buildLayoutItems(query: string, options?: { confirmDangerousActions?: boolean }): ResultItem[];
  buildPaneSettingItems(paneId: string | null, query: string): ResultItem[];
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
  getTickers(): AppState["tickers"];
  hasPaneSettings(paneId: string): boolean;
  localTickerSearchResultItems(query?: string, options?: { category?: string; limit?: number }): ResultItem[];
  nativeListScrollRef: RefObject<ScrollBoxRenderable | null>;
  nonShortcutPaneTemplateItems(filterQuery?: string): ResultItem[];
  openModeRoute(screen: "ticker-search" | "layout", initialQuery?: string): void;
  paneShortcutItems(options?: {
    filterQuery?: string;
    createOptions?: PaneTemplateCreateOptions;
    includePromptableTickerTemplates?: boolean;
  }): ResultItem[];
  pluginCommandItems(): ResultItem[];
  pluginCommandResultItems(command: CommandDef, shortcutArg: string): ResultItem[];
  articleResultItems?: ResultItem[];
  providerResultItems?: ResultItem[];
  providerCategoryPriorities?: CommandBarCategoryPriorities;
  providerSearching?: boolean;
  readTickerSearchCache(
    query: string,
    brokerId?: string | null,
    brokerInstanceId?: string | null,
  ): TickerSearchCandidate[] | null;
  rootModeKind: string;
  rootQuery: string;
  rootSelectionNavigatedRef: RefObject<boolean>;
  rootShortcutIntent: ShortcutIntent;
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
  buildTickerSearchResultItems,
  buildWindowModeItems,
  createPaneTemplateItem,
  createPluginCommandItem,
  currentRoute,
  dataProvider,
  executeCollectionCommand,
  getAvailablePaneShortcutTemplates,
  getTickers,
  hasPaneSettings,
  localTickerSearchResultItems,
  nativeListScrollRef,
  nonShortcutPaneTemplateItems,
  openModeRoute,
  paneShortcutItems,
  pluginCommandItems,
  pluginCommandResultItems,
  articleResultItems = [],
  providerResultItems = [],
  providerCategoryPriorities,
  providerSearching = false,
  readTickerSearchCache,
  rootModeKind,
  rootQuery,
  rootSelectionNavigatedRef,
  rootShortcutIntent,
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
  rootShortcutIntent: ShortcutIntent;
  tickerSearchPending: boolean;
  tickerSearchResults: ResultItem[];
} {
  const previousRootSelectionContextRef = useRef<{ query: string; mode: string } | null>(null);
  const previousRootResultIdsRef = useRef<string[]>([]);
  const activeMatch = matchPrefix(rootQuery, availableCommands);

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
    articleResultItems,
    providerResultItems,
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
    articleResultItems,
    providerResultItems,
    runDirectCommand,
    runSecurityDescriptionShortcut,
    state,
    tickerActionItems,
  ]);

  const rootSecurityDescriptionArg = activeMatch?.command.id === "security-description" && activeMatch.arg.length >= 1
    ? activeMatch.arg
    : null;
  // Free text that no prefix claims also goes to symbol search, so "nvidia"
  // finds NVDA without the backtick. Skipped when a local row already carries
  // that exact name, since an "Exact Match" symbol would otherwise outrank it.
  const rootPlainTickerSearchArg = useMemo(() => {
    if (currentRoute || activeMatch || rootShortcutIntent.kind !== "none") return null;
    const trimmed = rootQuery.trim();
    if (trimmed.length < 2) return null;
    const normalizedQuery = normalizeCommandTickerSearchText(trimmed);
    const hasExactLocalRow = rootResultModel.items.some((item) => (
      item.kind !== "ticker"
      && item.kind !== "search"
      && normalizeCommandTickerSearchText(item.label) === normalizedQuery
    ));
    return hasExactLocalRow ? null : trimmed;
  }, [activeMatch, currentRoute, rootQuery, rootResultModel.items, rootShortcutIntent.kind]);
  const rootTickerSearchArg = rootSecurityDescriptionArg ?? rootPlainTickerSearchArg;

  const {
    activeRootProviderResultsKey,
    orderedRootResults,
    rootSearching: tickerSearching,
    rootSectionOrder,
  } = useRootProviderSearch({
    activeCollectionId,
    buildTickerSearchResultItems,
    categoryPriorities: providerCategoryPriorities,
    currentRoute,
    dataProvider,
    localTickerSearchResultItems,
    portfolios: state.config.portfolios,
    readTickerSearchCache,
    rootPlainTickerSearchArg,
    rootResultItems: rootResultModel.items,
    rootTickerSearchArg,
    tickers: state.tickers,
    writeTickerSearchCache,
  });
  const rootSearching = tickerSearching || providerSearching;

  useLayoutEffect(() => {
    if (currentRoute) return;

    const resultIds = orderedRootResults.map((item) => item.id);
    const previousResultIds = previousRootResultIdsRef.current;
    previousRootResultIdsRef.current = resultIds;

    setRootHoveredIdx((current) => (current != null && current < resultIds.length ? current : null));

    const selectionContextChanged =
      previousRootSelectionContextRef.current?.query !== rootQuery
      || previousRootSelectionContextRef.current?.mode !== rootModeKind;
    previousRootSelectionContextRef.current = { query: rootQuery, mode: rootModeKind };
    if (selectionContextChanged) {
      rootSelectionNavigatedRef.current = false;
    }

    setRootSelectedIdx((current) => {
      if (rootSelectionNavigatedRef.current) {
        // The user picked this row. Async sections append below it, but an
        // exact symbol match still lands above, so the row is tracked by id
        // rather than by index.
        const selectedId = previousResultIds[current];
        const shiftedIdx = selectedId ? resultIds.indexOf(selectedId) : -1;
        if (shiftedIdx >= 0) return shiftedIdx;
        return clampSelectedIdx(current, resultIds.length);
      }
      // Untouched, the selection follows the best row on offer.
      const defaultIdx = orderedRootResults.findIndex(isDefaultSelectable);
      return clampSelectedIdx(Math.max(rootResultModel.initialIdx, defaultIdx), resultIds.length);
    });
  }, [
    activeMatch?.command.id,
    currentRoute,
    orderedRootResults,
    rootModeKind,
    rootQuery,
    rootResultModel.initialIdx,
    rootSelectionNavigatedRef,
    setRootHoveredIdx,
    setRootSelectedIdx,
  ]);

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
