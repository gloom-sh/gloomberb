import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { t } from "../../i18n";
import { listingChoiceQuery, normalizeTickerInput } from "../../tickers/search";
import { isKnownExchangeCode, typedExchangeVenue } from "../../utils/exchanges";
import type { PluginRegistry } from "../../plugins/registry";
import type { Command } from "./commands/registry";
import { resolveCommandBarMode } from "./view-model";
import { isDefaultSelectable, type ResultItem } from "./list/model";
import type { CommandBarActionRuntime } from "./action-runtime";
import type { CommandBarNavigationState } from "./routing/navigation-state";
import type { CommandBarEnvironment } from "./surface/environment";
import {
  acceptRootShortcutTabAction,
  buildImmediateRootSelection,
} from "./routes/root/selection";
import { activatePickerSelectionAction } from "./picker-activation";
import type { RunRootRow } from "./routes/root/search-report";
import type { ShortcutIntent } from "./routes/root/shortcuts";
import { isNamedListingRow } from "./routes/ticker-search/results";
import { writtenAsSymbol } from "./routes/root/runtime";

interface UseCommandBarSelectionRuntimeOptions {
  env: CommandBarEnvironment;
  nav: CommandBarNavigationState;
  actions: CommandBarActionRuntime;
  availableCommands: Command[];
  clearThemePreview: (themeId: string) => void;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  pluginRegistry: PluginRegistry;
  promptTickerSymbol?: string | null;
  rootShortcutIntent: ShortcutIntent;
  rootThemeBaseIdRef: MutableRefObject<string | null>;
  /**
   * The command-search report, which runs each root row (and Tab on a typed
   * shortcut) so it can tell a row that ran from one that only opened a route
   * or rewrote the query. It never holds the row up.
   */
  runRootRow?: RunRootRow;
  /**
   * The search that decides the best row is still out, so the list on screen
   * is a stand-in for the answer.
   */
  searchPending: boolean;
}

export function useCommandBarSelectionRuntime({
  env,
  nav,
  actions,
  availableCommands,
  clearThemePreview,
  closeAll,
  pluginRegistry,
  promptTickerSymbol = null,
  rootShortcutIntent,
  rootThemeBaseIdRef,
  runRootRow,
  searchPending,
}: UseCommandBarSelectionRuntimeOptions) {
  const { activeTickerSymbol, state: { config: { layout: stateConfigLayout } }, stateRef, visibleListStateRef } = env;
  const {
    currentRoute,
    currentRouteRef,
    rootModeKindRef,
    rootQuery,
    rootQueryRef,
    rootSelectedIdx,
    rootSelectionNavigatedRef,
    setRootQuery,
    updateTopRoute,
  } = nav;
  const {
    collectionWorkflowActions,
    createPaneTemplateItem,
    createPluginCommandItem,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    getAvailablePluginCommands,
    openInlineConfirm,
    openModeRoute,
    openPaneTemplateWorkflow,
    persistLayoutChange,
    pluginCommandResultItems,
    runDirectCommand,
    runSecurityDescriptionShortcut,
  } = actions;

  const startThemePicker = useCallback((arg: string) => {
    rootThemeBaseIdRef.current = stateRef.current.config.theme;
    setRootQuery(arg ? `TH ${arg}` : "TH ");
  }, [rootThemeBaseIdRef, setRootQuery, stateRef]);

  const acceptSelectedShortcutTab = useCallback((): boolean => {
    const listState = visibleListStateRef.current;
    if (listState?.kind !== "root") return false;

    const selected = listState.results[listState.selectedIdx];
    const shortcutQuery = selected?.shortcutQuery?.trim();
    if (!shortcutQuery) return false;

    setRootQuery(`${shortcutQuery} `);
    return true;
  }, [setRootQuery, visibleListStateRef]);

  const rootSelectionOptions = useMemo(() => ({
    activeTickerSymbol,
    promptTickerSymbol,
    availableCommands,
    createPaneTemplateItem,
    createPluginCommandItem,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    getAvailablePluginCommands,
    openModeRoute,
    openPaneTemplateWorkflow,
    pluginCommandResultItems,
    runDirectCommand,
    runSecurityDescriptionShortcut,
    setRootQuery,
    startThemePicker,
  }), [
    activeTickerSymbol,
    promptTickerSymbol,
    availableCommands,
    createPaneTemplateItem,
    createPluginCommandItem,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    getAvailablePluginCommands,
    openModeRoute,
    openPaneTemplateWorkflow,
    pluginCommandResultItems,
    runDirectCommand,
    runSecurityDescriptionShortcut,
    setRootQuery,
    startThemePicker,
  ]);

  const resolveImmediateRootSelection = useCallback(
    (query: string): ResultItem | null => buildImmediateRootSelection({ ...rootSelectionOptions, query }),
    [rootSelectionOptions],
  );

  /**
   * The typed ticker command Enter runs while no row is highlighted (DES
   * before its search answers), so the prompt names its keys as a ticker row's.
   */
  const typedTickerRow = useMemo(() => (
    !currentRoute && rootShortcutIntent.kind !== "none" && rootShortcutIntent.argKind === "ticker"
      ? resolveImmediateRootSelection(rootQuery) : null
  ), [currentRoute, resolveImmediateRootSelection, rootQuery, rootShortcutIntent]);

  /**
   * Tab on a typed shortcut: it completes the prefix, or opens what the
   * shortcut starts (a ticker search in the bar, a pane form in the form
   * modal), which is the typed text running.
   */
  const acceptRootShortcutTab = useCallback((): boolean => {
    const query = rootQueryRef.current;
    const accept = () => acceptRootShortcutTabAction({ ...rootSelectionOptions, query });
    const shortcutRow = runRootRow ? resolveImmediateRootSelection(query) : null;
    if (!runRootRow || !shortcutRow) return accept();
    let accepted = false;
    runRootRow({ item: shortcutRow, query, rank: 0, isShortcut: () => true }, () => {
      accepted = accept();
      return accepted;
    });
    return accepted;
  }, [resolveImmediateRootSelection, rootQueryRef, rootSelectionOptions, runRootRow]);

  /**
   * Runs `query` exactly as if it had been typed into the root bar and
   * submitted, so AI-suggested inputs take the same prefix/arg path as anything
   * the user types. Argless prefixes reject a trailing argument outright
   * ("ERN NVDA" resolves to nothing), so the bare prefix gets a second try
   * before the text is merely dropped into the input. Returns whether a row
   * ran.
   */
  const runRootQuery = useCallback((query: string, options?: { fallbackPrefix?: string }): boolean => {
    const item = resolveImmediateRootSelection(query);
    if (item && !item.disabled) {
      void item.action();
      return true;
    }
    const trimmed = query.trim();
    const fallbackPrefix = (options?.fallbackPrefix ?? trimmed.split(/\s+/)[0] ?? "").trim();
    if (fallbackPrefix && fallbackPrefix.toUpperCase() !== trimmed.toUpperCase()) {
      const fallbackItem = resolveImmediateRootSelection(fallbackPrefix);
      if (fallbackItem && !fallbackItem.disabled) {
        void fallbackItem.action();
        return true;
      }
    }
    setRootQuery(query);
    return false;
  }, [resolveImmediateRootSelection, setRootQuery]);

  const setActiveListQuery = useCallback((nextQuery: string) => {
    const route = currentRouteRef.current;
    if (!route) {
      if (rootModeKindRef.current === "themes" && resolveCommandBarMode(nextQuery, availableCommands).kind !== "themes") {
        clearThemePreview(rootThemeBaseIdRef.current ?? stateRef.current.config.theme);
        rootThemeBaseIdRef.current = null;
      }
      setRootQuery(nextQuery);
      return;
    }

    updateTopRoute((route) => ({ ...route, query: nextQuery, selectedIdx: 0, hoveredIdx: null }));
  }, [
    availableCommands,
    clearThemePreview,
    currentRouteRef,
    rootModeKindRef,
    rootThemeBaseIdRef,
    setRootQuery,
    stateRef,
    updateTopRoute,
  ]);

  /**
   * An Enter pressed with no row to run while the search is still out. It
   * waits for the answer instead of running whatever else the list shows, and
   * is dropped when the user types, moves the selection or leaves the root.
   */
  const pendingEnterRef = useRef<{ query: string; secondary: boolean } | null>(null);

  const activateListSelection = useCallback((options?: { secondary?: boolean; item?: ResultItem }) => {
    const listState = visibleListStateRef.current;
    if (!listState) return;
    // Enter opens exactly the highlighted row. The typed command runs as typed
    // only while no listing for it is highlighted: before its search answers
    // (`DES HFC` then opens the listing `quote HFC` reads), or while the rows
    // on screen are an earlier query's.
    const queryChanged = rootQueryRef.current !== rootQuery;
    const tickerArgument = rootShortcutIntent.kind !== "none" && rootShortcutIntent.argKind === "ticker"
      ? rootShortcutIntent.argText : null;
    // `DES BA LN` names its listing as `DES BA:LSE` does.
    const listingQuery = listingChoiceQuery((tickerArgument === null ? null : normalizeTickerInput(null, tickerArgument)) ?? rootQueryRef.current);
    // `DES INTP:IDX` names Jakarta's line as `DES INTP:JAKARTA` does (typedExchangeVenue).
    const choosingVenue = listingQuery && !isKnownExchangeCode(listingQuery.suffix) && !typedExchangeVenue(listingQuery.suffix);
    const highlighted = listState.results[listState.selectedIdx];
    // A function given a listing with its venue opens that listing: a row the
    // user did not pick (a saved BRK.B the letters match, Boeing's BA on NYSE)
    // runs only when it is that listing, and the typed text runs otherwise.
    const namedListing = tickerArgument !== null && listingQuery && !choosingVenue ? listingQuery : null;
    const otherListingHighlighted = !!namedListing && !!highlighted && !rootSelectionNavigatedRef.current
      && !isNamedListingRow(highlighted, namedListing);
    const listingHighlighted = !queryChanged && !otherListingHighlighted
      && (highlighted?.kind === "ticker" || highlighted?.kind === "search");
    const submitTyped = !options?.item && !currentRoute && !listingHighlighted
      && (queryChanged || (!rootSelectionNavigatedRef.current && !choosingVenue));
    // A name (`DES Microsoft`, `DES nvda`) is search's to read, not the
    // resolver's: before the answer, Enter waits for it.
    const nameAwaitingAnswer = searchPending && !queryChanged && tickerArgument !== null && !namedListing
      && !writtenAsSymbol(tickerArgument);
    const typed = submitTyped && !nameAwaitingAnswer && (queryChanged || tickerArgument !== null)
      ? resolveImmediateRootSelection(rootQueryRef.current) : null;
    const selected = options?.item ?? typed ?? listState.results[listState.selectedIdx];
    if (!selected) {
      if (searchPending && !currentRoute && !options?.item && !rootSelectionNavigatedRef.current) {
        pendingEnterRef.current = { query: rootQueryRef.current, secondary: options?.secondary === true };
      }
      return;
    }
    if (selected.disabled) return;

    // Opened from an add row: a venue picked from the colon list joins that
    // collection. Any other text or screen runs as usual.
    const addListing = stateRef.current.commandBarLaunchRequest;
    if (
      !options?.secondary
      && addListing?.kind === "add-listing"
      && !currentRoute
      && listingChoiceQuery(rootQueryRef.current)
      && (selected.kind === "ticker" || selected.kind === "search")
      && selected.resolveTicker
    ) {
      const launch = addListing;
      void (async () => {
        try {
          const ticker = await selected.resolveTicker!();
          await executeCollectionCommand(
            launch.collectionKind === "watchlist" ? "add-watchlist" : "add-portfolio",
            ticker.metadata.ticker,
            launch.collectionId,
            ticker,
            true,
          );
        } catch (error) {
          pluginRegistry.notify({
            type: "error",
            body: error instanceof Error ? error.message : t("Could not add the selected listing."),
          });
        }
      })();
      return;
    }

    const run = () => {
      if (options?.secondary && selected.secondaryAction) {
        void selected.secondaryAction();
        return;
      }

      if (currentRoute?.kind === "picker") {
        activatePickerSelectionAction({
          closeAll,
          collectionWorkflowActions,
          executeCollectionCommand,
          layout: stateConfigLayout,
          openInlineConfirm,
          persistLayoutChange,
          pluginRegistry,
          route: currentRoute,
          selectedId: selected.id,
        });
        return;
      }

      void selected.action();
    };
    if (currentRoute || !runRootRow) {
      run();
      return;
    }
    // Read before the row runs, which can rewrite the query.
    const query = rootQueryRef.current;
    runRootRow({
      item: selected,
      query,
      rank: selected === typed ? 0 : Math.max(0, listState.results.indexOf(selected)),
      // A listing row stays a ticker choice; a submitted command is the shortcut itself.
      isShortcut: () => !listingHighlighted && (selected === typed || resolveImmediateRootSelection(query)?.id === selected.id),
    }, run);
  }, [
    closeAll,
    collectionWorkflowActions,
    currentRoute,
    executeCollectionCommand,
    openInlineConfirm,
    persistLayoutChange,
    pluginRegistry,
    resolveImmediateRootSelection,
    rootQuery,
    rootQueryRef,
    rootSelectionNavigatedRef,
    rootShortcutIntent,
    runRootRow,
    searchPending,
    stateConfigLayout,
    stateRef,
    visibleListStateRef,
  ]);

  useEffect(() => {
    const pending = pendingEnterRef.current;
    if (!pending) return;
    if (currentRoute || rootQueryRef.current !== pending.query || rootSelectionNavigatedRef.current) {
      pendingEnterRef.current = null;
      return;
    }
    const listState = visibleListStateRef.current;
    if (!listState?.results.some(isDefaultSelectable)) {
      // Still searching: the answer may bring a row. Answered with none: there is nothing to run.
      if (!searchPending) pendingEnterRef.current = null;
      return;
    }
    // The selection follows the rows in the render after they land.
    if (!listState.results[listState.selectedIdx]) return;
    pendingEnterRef.current = null;
    activateListSelection({ secondary: pending.secondary });
  }, [
    activateListSelection,
    currentRoute,
    rootQueryRef,
    rootSelectedIdx,
    rootSelectionNavigatedRef,
    searchPending,
    visibleListStateRef,
  ]);

  return {
    acceptRootShortcutTab,
    acceptSelectedShortcutTab,
    activateListSelection,
    runRootQuery,
    setActiveListQuery,
    typedTickerRow,
  };
}
