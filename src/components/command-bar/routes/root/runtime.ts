import { useEffect, useLayoutEffect, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ScrollBoxRenderable } from "../../../../ui";
import type { AppState } from "../../../../state/app/context";
import type { DataProvider } from "../../../../types/data-provider";
import type { CommandDef, PaneTemplateCreateOptions, PaneTemplateDef } from "../../../../types/plugin";
import type { TickerRecord } from "../../../../types/ticker";
import { listingChoiceQuery, symbolSearchQuery, type TickerSearchCandidate } from "../../../../tickers/search";
import type { AssistRowHandlers } from "../../assist/model";
import { matchPrefix, type Command } from "../../commands/registry";
import { isDefaultSelectable, type ResultItem } from "../../list/model";
import type { CommandBarCategoryPriorities } from "../../view-model";
import type { CommandBarRoute } from "../../workflow/types";
import { normalizeCommandTickerSearchText, readRootTickerQuery } from "../ticker-search/results";
import { endsInLegalForm, readNearMissListing, readTerminalListingCode } from "../../../../tickers/terminal-codes";
import { useTickerSearchRouteResults } from "../ticker-search/route";
import { buildRootResultModel, type RootResultModel } from "./results";
import { useRootProviderSearch } from "./provider-search";
import { isProviderResultItem } from "./search-providers";
import { buildRootShortcutFeedback } from "./shortcut-feedback";
import type { ShortcutIntent } from "./shortcuts";
import { clampIndex } from "../../../../utils/math";

interface UseCommandBarRootRuntimeOptions {
  activeCollectionId: string | null;
  activePortfolio?: AppState["config"]["portfolios"][number];
  activeTickerData: TickerRecord | null | undefined;
  activeTickerSymbol: string | null;
  assist: AssistRowHandlers;
  availableCommands: Command[];
  bindKey?: (query: string) => void;
  buildLayoutItems(query: string, options?: { confirmDangerousActions?: boolean }): ResultItem[];
  buildPaneSettingItems(paneId: string | null, query: string): ResultItem[];
  buildRecentTickerItem?: (symbol: string) => ResultItem | null;
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
  getRecentPaneTemplate?: (id: string, arg?: string) => PaneTemplateDef | undefined;
  leadingShortcutCode?: string | null;
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
  pluginInstallItem?: ResultItem | null;
  providerResultItems?: ResultItem[];
  providerMatchItems?: ResultItem[];
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
  bindKey,
  buildLayoutItems,
  buildPaneSettingItems,
  buildRecentTickerItem,
  buildTickerSearchResultItems,
  buildWindowModeItems,
  createPaneTemplateItem,
  createPluginCommandItem,
  currentRoute,
  dataProvider,
  executeCollectionCommand,
  getAvailablePaneShortcutTemplates,
  getRecentPaneTemplate,
  leadingShortcutCode,
  getTickers,
  hasPaneSettings,
  localTickerSearchResultItems,
  nativeListScrollRef,
  nonShortcutPaneTemplateItems,
  openModeRoute,
  paneShortcutItems,
  pluginCommandItems,
  pluginCommandResultItems,
  pluginInstallItem = null,
  providerResultItems = [],
  providerMatchItems = [],
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
  rootResultsCurrent: boolean;
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
    bindKey,
    buildLayoutItems,
    buildPaneSettingItems,
    buildRecentTickerItem,
    buildWindowModeItems,
    createPaneTemplateItem,
    createPluginCommandItem,
    currentRoute,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    getRecentPaneTemplate,
    hasPaneSettings,
    leadingShortcutCode,
    localTickerSearchResultItems,
    nonShortcutPaneTemplateItems,
    openModeRoute,
    paneShortcutItems,
    pluginCommandItems,
    pluginCommandResultItems,
    pluginInstallItem,
    rootQuery,
    rootShortcutIntent,
    providerResultItems,
    providerMatchItems,
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
    bindKey,
    buildLayoutItems,
    buildPaneSettingItems,
    buildRecentTickerItem,
    buildWindowModeItems,
    createPaneTemplateItem,
    createPluginCommandItem,
    currentRoute,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    getRecentPaneTemplate,
    hasPaneSettings,
    leadingShortcutCode,
    localTickerSearchResultItems,
    nonShortcutPaneTemplateItems,
    openModeRoute,
    paneShortcutItems,
    pluginCommandItems,
    pluginCommandResultItems,
    pluginInstallItem,
    rootQuery,
    rootShortcutIntent,
    providerResultItems,
    providerMatchItems,
    runDirectCommand,
    runSecurityDescriptionShortcut,
    state,
    tickerActionItems,
  ]);

  // `DES VOD LN` searches the listing the code names, as Enter opens it; `DES SAP SE` the company.
  const rootSecurityDescriptionArg = activeMatch?.command.id === "security-description" && activeMatch.arg.length >= 1
    ? (endsInLegalForm(activeMatch.arg) ? null : readTerminalListingCode(activeMatch.arg)?.key) ?? readNearMissListing(activeMatch.arg)?.symbol ?? activeMatch.arg
    : null;
  // Free text that no prefix claims also goes to symbol search, so "nvidia"
  // finds NVDA without the backtick. Skipped when a local row already carries
  // that exact name, since an "Exact Match" symbol would otherwise outrank it.
  // `NET:` is that symbol's venue dropdown. The search itself is the bare symbol.
  const rootListingChoice = useMemo(() => {
    if (currentRoute || activeMatch || rootShortcutIntent.kind !== "none") return null;
    return listingChoiceQuery(rootQuery);
  }, [activeMatch, currentRoute, rootQuery, rootShortcutIntent.kind]);
  // `VOD LN`, `AAPL GP` and `700.HK` search the symbol they are read as, and the rows say which listing they name.
  const rootTickerReading = useMemo(() => (
    currentRoute || activeMatch || rootShortcutIntent.kind !== "none" || rootListingChoice ? null : readRootTickerQuery(rootQuery)
  ), [activeMatch, currentRoute, rootListingChoice, rootQuery, rootShortcutIntent.kind]);
  const rootPlainTickerSearchArg = useMemo(() => {
    if (currentRoute || activeMatch || rootShortcutIntent.kind !== "none") return null;
    // An explicit venue choice also searches one-letter symbols and names shared with local actions.
    if (rootListingChoice) return rootListingChoice.symbol;
    if (rootTickerReading) return rootTickerReading.search;
    const trimmed = rootQuery.trim();
    const symbolQuery = symbolSearchQuery(trimmed);
    if (symbolQuery.length < 2) return null;
    const normalizedQuery = normalizeCommandTickerSearchText(symbolQuery);
    // The install row for "TV" is labelled TV, but it leads on purpose and
    // must not keep Grupo Televisa out of the list.
    // A plugin's row never stands in for the symbol: a DM with @spy must not
    // keep SPY out of the list.
    const hasExactLocalRow = rootResultModel.items.some((item) => (
      item !== pluginInstallItem
      && item.kind !== "ticker"
      && item.kind !== "search"
      && !isProviderResultItem(item)
      && normalizeCommandTickerSearchText(item.label) === normalizedQuery
    ));
    return hasExactLocalRow ? null : symbolQuery;
  }, [activeMatch, currentRoute, pluginInstallItem, rootListingChoice, rootQuery, rootResultModel.items, rootShortcutIntent.kind, rootTickerReading]);
  const rootTickerSearchArg = rootSecurityDescriptionArg ?? rootPlainTickerSearchArg;

  const {
    activeRootProviderResultsKey,
    orderedRootResults,
    rootResultsCurrent,
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
    listingSuffix: rootPlainTickerSearchArg && rootListingChoice ? rootListingChoice.suffix : null,
    reading: rootPlainTickerSearchArg ? rootTickerReading : null,
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
        return clampIndex(current, resultIds.length);
      }
      // Untouched, the selection follows the best row on offer. When every row
      // is an offer or a placeholder, none of them is the answer and none is
      // selected: Enter must not take one of them for the ticker still being
      // searched.
      const defaultIdx = orderedRootResults.findIndex(isDefaultSelectable);
      if (defaultIdx < 0) return -1;
      return clampIndex(Math.max(rootResultModel.initialIdx, defaultIdx), resultIds.length);
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
    rootResultsCurrent,
    rootSearching,
    rootSectionOrder,
    rootShortcutFeedback,
    rootShortcutIntent,
    tickerSearchPending,
    tickerSearchResults,
  };
}
