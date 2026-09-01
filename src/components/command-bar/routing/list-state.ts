import { useMemo } from "react";
import type { PluginRegistry } from "../../../plugins/registry";
import {
  getEmptyState,
  type CommandBarCategoryPriorities,
  type CommandBarMode,
  type CommandBarSectionOrder,
} from "../view-model";
import {
  getScreenFooterLeft,
  getScreenFooterRight,
} from "../helpers";
import {
  orderListResults,
  type ListScreenState,
  type ResultItem,
} from "../list/model";
import type { matchPrefix } from "../commands/registry";
import { getVisibleMultiSelectPickerOptions } from "../multi-select-picker";
import type { CommandBarRoute } from "../workflow/types";
import { tc } from "../../../i18n";

type ActiveCommandMatch = ReturnType<typeof matchPrefix>;

interface BuildRouteListStateOptions {
  activeMatch: ActiveCommandMatch;
  adaptTickerSearchRouteResult: (
    item: ResultItem,
    routePayload: Record<string, unknown> | undefined,
  ) => ResultItem;
  buildLayoutItems: (query: string) => ResultItem[];
  buildPaneSettingItems: (
    paneId: string | null,
    query: string,
    options?: { keepRouteOpen?: boolean },
  ) => ResultItem[];
  currentRoute: CommandBarRoute | null;
  orderedRootResults: ResultItem[];
  pluginRegistry: Pick<PluginRegistry, "resolvePaneSettings">;
  rootHoveredIdx: number | null;
  rootModeKind: CommandBarMode;
  rootQuery: string;
  rootCategoryPriorities?: CommandBarCategoryPriorities;
  rootSearching: boolean;
  rootSectionOrder: CommandBarSectionOrder;
  rootSelectedIdx: number;
  tickerSearchPending: boolean;
  tickerSearchResults: ResultItem[];
}

function buildRouteListState(options: BuildRouteListStateOptions): ListScreenState | null {
  const {
    activeMatch,
    adaptTickerSearchRouteResult,
    buildLayoutItems,
    buildPaneSettingItems,
    currentRoute,
    orderedRootResults,
    pluginRegistry,
    rootHoveredIdx,
    rootModeKind,
    rootCategoryPriorities,
    rootQuery,
    rootSearching,
    rootSectionOrder,
    rootSelectedIdx,
    tickerSearchPending,
    tickerSearchResults,
  } = options;

  if (!currentRoute) {
    const emptyState = getEmptyState(
      rootModeKind,
      rootQuery,
      activeMatch?.command.id === "security-description" ? activeMatch.arg : undefined,
    );
    return {
      kind: "root",
      title: "Commands",
      query: rootQuery,
      selectedIdx: rootSelectedIdx,
      hoveredIdx: rootHoveredIdx,
      results: orderedRootResults,
      searching: rootSearching,
      emptyLabel: emptyState.label,
      emptyDetail: emptyState.detail,
      footerLeft: getScreenFooterLeft(null),
      footerRight: getScreenFooterRight(null),
      sectionOrder: rootSectionOrder,
      categoryPriorities: rootCategoryPriorities,
    };
  }

  if (currentRoute.kind === "mode") {
    switch (currentRoute.screen) {
      case "layout": {
        const results = buildLayoutItems(currentRoute.query);
        return {
          kind: "mode",
          title: "Layout Actions",
          subtitle: "Organize panes and saved layouts.",
          query: currentRoute.query,
          selectedIdx: currentRoute.selectedIdx,
          hoveredIdx: currentRoute.hoveredIdx,
          results: orderListResults(results),
          searching: false,
          emptyLabel: getEmptyState("layout", currentRoute.query).label,
          emptyDetail: getEmptyState("layout", currentRoute.query).detail,
          footerLeft: getScreenFooterLeft(currentRoute),
          footerRight: getScreenFooterRight(currentRoute),
        };
      }
      case "ticker-search": {
        const results = tickerSearchResults.map((item) => adaptTickerSearchRouteResult(item, currentRoute.payload));
        const emptyState = getEmptyState("search", currentRoute.query, currentRoute.query);
        return {
          kind: "mode",
          title: "Security Description",
          subtitle: "Resolve a ticker, then open its Ticker Research pane.",
          query: currentRoute.query,
          selectedIdx: currentRoute.selectedIdx,
          hoveredIdx: currentRoute.hoveredIdx,
          results: orderListResults(results, { sectionOrder: "ranked" }),
          searching: tickerSearchPending,
          emptyLabel: emptyState.label,
          emptyDetail: emptyState.detail,
          footerLeft: getScreenFooterLeft(currentRoute),
          footerRight: getScreenFooterRight(currentRoute),
          sectionOrder: "ranked",
        };
      }
      default:
        return null;
    }
  }

  if (currentRoute.kind === "picker") {
    const filteredOptions = getVisibleMultiSelectPickerOptions(currentRoute);
    const filtered = filteredOptions.map((option) => ({
      id: option.id,
      label: option.label,
      detail: option.detail || "",
      category: tc("picker-heading", "Options"),
      kind: "action" as const,
      disabled: option.disabled,
      action: () => {},
    }));
    const selectedIdx = filtered.length === 0
      ? 0
      : Math.max(0, Math.min(currentRoute.selectedIdx, filtered.length - 1));
    return {
      kind: "picker",
      title: currentRoute.title,
      query: currentRoute.query,
      selectedIdx,
      hoveredIdx: currentRoute.hoveredIdx,
      results: orderListResults(filtered),
      searching: false,
      emptyLabel: "No matches",
      emptyDetail: "Adjust the filter to see more options.",
      footerLeft: getScreenFooterLeft(currentRoute),
      footerRight: getScreenFooterRight(currentRoute),
    };
  }

  if (currentRoute.kind === "pane-settings") {
    const descriptor = pluginRegistry.resolvePaneSettings(currentRoute.paneId);
    if (!descriptor) return null;
    const filtered = buildPaneSettingItems(currentRoute.paneId, currentRoute.query, { keepRouteOpen: true });
    return {
      kind: "pane-settings",
      title: descriptor.settingsDef.title || "Pane Settings",
      subtitle: descriptor.pane.title || descriptor.paneDef.name,
      query: currentRoute.query,
      selectedIdx: currentRoute.selectedIdx,
      hoveredIdx: currentRoute.hoveredIdx,
      results: orderListResults(filtered),
      searching: false,
      emptyLabel: "No settings match",
      emptyDetail: currentRoute.query || "This pane exposes no settings.",
      footerLeft: getScreenFooterLeft(currentRoute),
      footerRight: getScreenFooterRight(currentRoute),
    };
  }

  return null;
}

export function useRouteListState(options: BuildRouteListStateOptions): ListScreenState | null {
  const {
    activeMatch,
    adaptTickerSearchRouteResult,
    buildLayoutItems,
    buildPaneSettingItems,
    currentRoute,
    orderedRootResults,
    pluginRegistry,
    rootCategoryPriorities,
    rootHoveredIdx,
    rootModeKind,
    rootQuery,
    rootSearching,
    rootSectionOrder,
    rootSelectedIdx,
    tickerSearchPending,
    tickerSearchResults,
  } = options;

  return useMemo(() => buildRouteListState(options), [
    activeMatch,
    adaptTickerSearchRouteResult,
    buildLayoutItems,
    buildPaneSettingItems,
    currentRoute,
    orderedRootResults,
    pluginRegistry,
    rootCategoryPriorities,
    rootHoveredIdx,
    rootModeKind,
    rootQuery,
    rootSearching,
    rootSectionOrder,
    rootSelectedIdx,
    tickerSearchPending,
    tickerSearchResults,
  ]);
}
