import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { AppState } from "../../../../state/app/context";
import type { DataProvider } from "../../../../types/data-provider";
import type { PaneTemplateDef } from "../../../../types/plugin";
import { listingChoiceQuery, symbolSearchQuery } from "../../../../tickers/search";
import { isAssistPlaceholderRow, type AssistRowHandlers } from "../../assist/model";
import { matchPrefix, type Command } from "../../commands/registry";
import { isDefaultSelectable, type ResultItem } from "../../list/model";
import type { CommandBarCategoryPriorities } from "../../view-model";
import type { CommandBarActionRuntime } from "../../action-runtime";
import type { CommandBarNavigationState } from "../../routing/navigation-state";
import type { CommandBarEnvironment } from "../../surface/environment";
import { normalizeCommandTickerSearchText, readRootTickerQuery } from "../ticker-search/results";
import { endsInLegalForm, readNearMissListing, readTerminalListingCode } from "../../../../tickers/terminal-codes";
import { useTickerSearchRouteResults } from "../ticker-search/route";
import { buildRootResultModel, type RootResultModel } from "./results";
import { useRootProviderSearch } from "./provider-search";
import { isProviderResultItem } from "./search-providers";
import { buildRootShortcutFeedback } from "./shortcut-feedback";
import { commandShortcutQuery, type ShortcutIntent } from "./shortcuts";
import { clampIndex } from "../../../../utils/math";
import { homeMarketVenue, systemTimeZone } from "../../../../market-data/market/header-market";

/** Written the way a symbol is: up to five letters and a share class (AAPL, nvda, BRK.B). */
const SYMBOL_SHAPED_QUERY = /^[A-Za-z]{1,5}(?:[.\-/][A-Za-z]{1,2})?$/;
/** Written the way an Asian exchange numbers its listings: Hong Kong's 0700, Tokyo's 7203, Shanghai's 600519. */
const LISTING_NUMBER_QUERY = /^\d{3,6}$/;
/** Written the way Singapore codes them, letters and digits in capitals: D05, C6L, A17U. */
const LISTING_CODE_QUERY = /^(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{3,4}$/;

/** A ticker written as one, in capitals (BA, BRK.B, 0700, D05, GC=F, ^GSPC): what the resolver reads as typed. */
export function writtenAsSymbol(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === trimmed.toUpperCase() && /^\^?[A-Z0-9][A-Z0-9=.\-/]*$/.test(trimmed);
}

/**
 * Text that asks for a symbol rather than a local row: symbol-shaped, and in
 * capitals or in no row's name, or a listing's number or code. `nvda` matches
 * Exposure only through its example input; `upd` is in Check for Updates.
 */
function readsAsSymbol(text: string, rows: readonly ResultItem[]): boolean {
  if (LISTING_NUMBER_QUERY.test(text) || LISTING_CODE_QUERY.test(text)) return true;
  if (!SYMBOL_SHAPED_QUERY.test(text)) return false;
  if (text === text.toUpperCase()) return true;
  const wanted = text.toLowerCase();
  return !rows.some((row) => isDefaultSelectable(row) && row.label.toLowerCase().includes(wanted));
}

interface UseCommandBarRootRuntimeOptions {
  env: CommandBarEnvironment;
  nav: CommandBarNavigationState;
  actions: CommandBarActionRuntime;
  assist: AssistRowHandlers;
  availableCommands: Command[];
  bindKey?: (query: string) => void;
  buildRecentTickerItem?: (symbol: string) => ResultItem | null;
  dataProvider: DataProvider;
  getRecentPaneTemplate?: (id: string, arg?: string) => PaneTemplateDef | undefined;
  getTickers(): AppState["tickers"];
  hasPaneSettings(paneId: string): boolean;
  leadingShortcutCode?: string | null;
  pluginInstallItem?: ResultItem | null;
  providerResultItems?: ResultItem[];
  providerMatchItems?: ResultItem[];
  providerCategoryPriorities?: CommandBarCategoryPriorities;
  providerSearching?: boolean;
  rootShortcutIntent: ShortcutIntent;
}

export function useCommandBarRootRuntime({
  env,
  nav,
  actions,
  assist,
  availableCommands,
  bindKey,
  buildRecentTickerItem,
  dataProvider,
  getRecentPaneTemplate,
  getTickers,
  hasPaneSettings,
  leadingShortcutCode,
  pluginInstallItem = null,
  providerResultItems = [],
  providerMatchItems = [],
  providerCategoryPriorities,
  providerSearching = false,
  rootShortcutIntent,
}: UseCommandBarRootRuntimeOptions): {
  activeMatch: ReturnType<typeof matchPrefix>;
  orderedRootResults: ResultItem[];
  rootGhostSuffix: string | null;
  rootCategoryPriorities: CommandBarCategoryPriorities | undefined;
  rootResultModel: RootResultModel;
  rootResultsCurrent: boolean;
  rootSearching: boolean;
  rootSectionOrder: ReturnType<typeof useRootProviderSearch>["rootSectionOrder"];
  rootShortcutFeedback: string | null;
  rootShortcutIntent: ShortcutIntent;
  tickerSearchPending: boolean;
  tickerSearchResults: ResultItem[];
} {
  const {
    activeCollectionId,
    activePortfolio,
    activeTickerData,
    activeTickerSymbol,
    nativeListScrollRef,
    skipTickerSearchDebounceRef,
    state,
  } = env;
  const {
    currentRoute,
    rootModeInfo: { kind: rootModeKind },
    rootQuery,
    rootSelectionNavigatedRef,
    setRootHoveredIdx,
    setRootSelectedIdx,
  } = nav;
  const {
    buildLayoutItems,
    buildPaneSettingItems,
    buildTickerSearchResultItems,
    buildWindowModeItems,
    createPaneTemplateItem,
    createPluginCommandItem,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    localTickerSearchResultItems,
    nonShortcutPaneTemplateItems,
    openModeRoute,
    paneShortcutItems,
    pluginCommandItems,
    pluginCommandResultItems,
    readTickerSearchCache,
    runDirectCommand,
    runSecurityDescriptionShortcut,
    tickerActionItems,
    writeTickerSearchCache,
  } = actions;
  const previousRootSelectionContextRef = useRef<{ query: string; mode: string } | null>(null);
  const previousRootResultIdsRef = useRef<string[]>([]);
  /**
   * The row the untouched highlight rests on once the query's answer is in,
   * and the answer it was on. A later answer that reorders the rows (a
   * fresher search over a cached one, a broker's) moves the highlight with
   * its row, so Enter opens the row that was highlighted.
   */
  const pinnedRootRowRef = useRef<{ id: string; answer: string | null } | null>(null);
  const previousAnswerTookTopRef = useRef(0);
  // `MC FP Equity DES` is `DES MC:EPA`, as `MC FP Equity GP` is `GP MC:EPA`.
  const activeMatch = matchPrefix(commandShortcutQuery(rootQuery, rootShortcutIntent), availableCommands);

  const tickerSearchRouteQuery = currentRoute?.kind === "mode" && currentRoute.screen === "ticker-search"
    ? currentRoute.query
    : null;
  // The market the header shows is the desk's own: search leads with its lines of the company a word names.
  const headerMarket = state.config.headerMarket;
  const homeVenue = useMemo(() => homeMarketVenue(headerMarket, systemTimeZone()), [headerMarket]);

  const {
    tickerSearchPending,
    tickerSearchResults,
  } = useTickerSearchRouteResults({
    brokerId: activePortfolio?.brokerId,
    brokerInstanceId: activePortfolio?.brokerInstanceId,
    buildTickerSearchResultItems,
    dataProvider,
    getTickers,
    homeVenue,
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
    // One letter is too little to be worth a search; one digit is a Hong Kong code as people type it (5 is HSBC's 0005).
    if (symbolQuery.length < 2 && !/^\d$/.test(symbolQuery)) return null;
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
    orderedRootResults: answeredRootResults,
    rootAnswerTookTop,
    rootCategoryPriorities,
    rootResultsCurrent,
    rootSearching: tickerSearching,
    rootSectionOrder,
  } = useRootProviderSearch({
    activeCollectionId,
    buildTickerSearchResultItems,
    categoryPriorities: providerCategoryPriorities,
    currentRoute,
    dataProvider,
    homeVenue,
    localTickerSearchResultItems,
    portfolios: state.config.portfolios,
    readTickerSearchCache,
    rootPlainTickerSearchArg,
    listingSuffix: rootPlainTickerSearchArg && rootListingChoice ? rootListingChoice.suffix : null,
    reading: rootPlainTickerSearchArg ? rootTickerReading : null,
    rootResultItems: rootResultModel.items,
    rootSelectionNavigatedRef,
    rootTickerSearchArg,
    tickers: state.tickers,
    writeTickerSearchCache,
  });
  const rootSearching = tickerSearching || providerSearching;
  // A symbol whose search has not answered: the rows on screen are what the
  // letters match locally (a pane whose example names AAPL), not the symbol,
  // so none of them is highlighted and Enter waits for the answer, as it would
  // get had the symbol been typed slowly. Lower case found in a row's name
  // (`upd`, `list`) is that row and runs at once. DES's rows before its answer
  // are saved tickers the letters match (`DES BA:LSE` finds Berkshire's BRK.B),
  // never the listing typed: none is highlighted, and Enter runs the text.
  const rootSymbolAnswerPending = !rootResultsCurrent && (rootSecurityDescriptionArg !== null || (rootPlainTickerSearchArg !== null
    && (rootTickerReading !== null || rootListingChoice !== null || readsAsSymbol(rootPlainTickerSearchArg, answeredRootResults))));
  // Nor does the AI hold a place for itself meanwhile: its Thinking row would
  // lead the list until the symbol's rows came in above it.
  const orderedRootResults = useMemo(
    () => (rootSymbolAnswerPending ? answeredRootResults.filter((item) => !isAssistPlaceholderRow(item)) : answeredRootResults),
    [answeredRootResults, rootSymbolAnswerPending],
  );

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
      pinnedRootRowRef.current = null;
    }
    // An answer that led with another listing than the index named takes the highlight the user left alone.
    if (previousAnswerTookTopRef.current !== rootAnswerTookTop) {
      previousAnswerTookTopRef.current = rootAnswerTookTop;
      if (!rootSelectionNavigatedRef.current) pinnedRootRowRef.current = null;
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
      const pinnedIdx = pinnedRootRowRef.current ? resultIds.indexOf(pinnedRootRowRef.current.id) : -1;
      if (pinnedIdx >= 0) return pinnedIdx;
      // Untouched, the selection follows the best row on offer until the
      // answer is in. When every row is an offer or a placeholder, none of
      // them is the answer and none is selected: Enter must not take one of
      // them for the ticker still being searched.
      const defaultIdx = orderedRootResults.findIndex(isDefaultSelectable);
      if (defaultIdx < 0 || rootSymbolAnswerPending) return -1;
      const selected = clampIndex(Math.max(rootResultModel.initialIdx, defaultIdx), resultIds.length);
      pinnedRootRowRef.current = rootResultsCurrent && resultIds[selected]
        ? { id: resultIds[selected]!, answer: activeRootProviderResultsKey }
        : null;
      return selected;
    });
  }, [
    activeRootProviderResultsKey,
    rootResultsCurrent,
    activeMatch?.command.id,
    currentRoute,
    orderedRootResults,
    rootAnswerTookTop,
    rootModeKind,
    rootQuery,
    rootResultModel.initialIdx,
    rootSelectionNavigatedRef,
    rootSymbolAnswerPending,
    setRootHoveredIdx,
    setRootSelectedIdx,
  ]);

  useEffect(() => {
    if (!activeRootProviderResultsKey) return;
    // A later answer that only reorders the rows leaves the highlight on its row.
    const pinned = pinnedRootRowRef.current;
    if (pinned && pinned.answer !== activeRootProviderResultsKey
      && orderedRootResults.some((item) => item.id === pinned.id)) return;
    setRootSelectedIdx(0);
    const top = orderedRootResults[0];
    pinnedRootRowRef.current = top ? { id: top.id, answer: activeRootProviderResultsKey } : null;
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
    rootCategoryPriorities,
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
