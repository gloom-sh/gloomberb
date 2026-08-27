import { useCallback, type RefObject } from "react";
import { type ScrollBoxRenderable } from "../../../ui";
import { useShortcut } from "../../../react/input";
import { isPlainArrowDown, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { getAdjacentPredictionCategoryId } from "../categories";
import { resolvePredictionKeyboardCommand } from "../keyboard";
import { getAdjacentPredictionVenueScope } from "../navigation";
import type {
  PredictionBrowseTab,
  PredictionCategoryId,
  PredictionDetailTab,
  PredictionListRow,
  PredictionMarketSummary,
  PredictionVenueScope,
} from "../types";

interface PredictionKeyboardEvent {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  super?: boolean;
  alt?: boolean;
  option?: boolean;
  shift?: boolean;
  defaultPrevented?: boolean;
  propagationStopped?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

interface UsePredictionControllerKeyboardParams {
  categoryId: PredictionCategoryId;
  detailOpen: boolean;
  detailScrollRef: RefObject<ScrollBoxRenderable | null>;
  detailTab: PredictionDetailTab;
  effectiveVenueScope: PredictionVenueScope;
  focused: boolean;
  hideTabs: boolean;
  searchFocused: boolean;
  selectedRow: PredictionListRow | null;
  selectedSummaryKey: string | null;
  sortedOutcomeMarkets: PredictionMarketSummary[];
  blurSearch: () => void;
  focusSearch: () => void;
  selectBrowseTab: (tab: PredictionBrowseTab) => void;
  selectCategory: (categoryId: PredictionCategoryId) => void;
  selectMarket: (marketKey: string) => void;
  setVenue: (venueScope: PredictionVenueScope) => void;
  toggleWatchlist: (row: PredictionListRow) => void;
}

export function usePredictionControllerKeyboard({
  categoryId,
  detailOpen,
  detailScrollRef,
  detailTab,
  effectiveVenueScope,
  focused,
  hideTabs,
  searchFocused,
  selectedRow,
  selectedSummaryKey,
  sortedOutcomeMarkets,
  blurSearch,
  focusSearch,
  selectBrowseTab,
  selectCategory,
  selectMarket,
  setVenue,
  toggleWatchlist,
}: UsePredictionControllerKeyboardParams) {
  const handleSearchNavigation = useCallback(
    (event: PredictionKeyboardEvent) => {
      if (!focused || !searchFocused) return;

      if (isPlainArrowDown(event)) {
        stopSearchFocusNavigation(event);
        blurSearch();
        return;
      }

      if (resolvePredictionKeyboardCommand(event) === "escape") {
        event.stopPropagation?.();
        event.preventDefault?.();
        blurSearch();
      }
    },
    [blurSearch, focused, searchFocused],
  );

  const cycleDetailOutcome = useCallback(
    (direction: "previous" | "next") => {
      if (detailTab !== "overview" || sortedOutcomeMarkets.length === 0) {
        return;
      }
      const currentIndex = sortedOutcomeMarkets.findIndex(
        (market) => market.key === selectedSummaryKey,
      );
      const safeIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex =
        direction === "previous"
          ? Math.max(safeIndex - 1, 0)
          : Math.min(safeIndex + 1, sortedOutcomeMarkets.length - 1);
      const nextMarket = sortedOutcomeMarkets[nextIndex];
      if (nextMarket) {
        selectMarket(nextMarket.key);
      }
    },
    [detailTab, selectMarket, selectedSummaryKey, sortedOutcomeMarkets],
  );

  const scrollDetailBy = useCallback((delta: number) => {
    const scrollBox = detailScrollRef.current;
    if (!scrollBox) return;
    const maxScrollTop = Math.max(
      0,
      scrollBox.scrollHeight - (scrollBox.viewport?.height ?? 0),
    );
    scrollBox.scrollTop = Math.max(
      0,
      Math.min(maxScrollTop, scrollBox.scrollTop + delta),
    );
  }, [detailScrollRef]);

  const handleKeyboard = useCallback(
    (event: PredictionKeyboardEvent) => {
      if (event.defaultPrevented || event.propagationStopped) return;
      if (!focused) return;
      const command = resolvePredictionKeyboardCommand(event);

      if (searchFocused) {
        return;
      }

      if (detailOpen) {
        if (detailTab === "overview" && sortedOutcomeMarkets.length > 0) {
          if (command === "move-down" || command === "move-up") {
            event.stopPropagation?.();
            event.preventDefault?.();
            cycleDetailOutcome(command === "move-down" ? "next" : "previous");
          }
          return;
        }

        if (
          (detailTab === "overview" || detailTab === "rules")
          && (command === "move-down" || command === "move-up")
        ) {
          event.stopPropagation?.();
          event.preventDefault?.();
          scrollDetailBy(command === "move-down" ? 1 : -1);
        }
        return;
      }

      if (command === "search") {
        event.stopPropagation?.();
        event.preventDefault?.();
        focusSearch();
        return;
      }

      if (!hideTabs && command === "previous-venue-tab") {
        event.stopPropagation?.();
        event.preventDefault?.();
        setVenue(
          getAdjacentPredictionVenueScope(effectiveVenueScope, "previous"),
        );
        return;
      }

      if (!hideTabs && command === "next-venue-tab") {
        event.stopPropagation?.();
        event.preventDefault?.();
        setVenue(getAdjacentPredictionVenueScope(effectiveVenueScope, "next"));
        return;
      }

      if (command === "previous-category") {
        event.stopPropagation?.();
        event.preventDefault?.();
        selectCategory(getAdjacentPredictionCategoryId(categoryId, "previous"));
        return;
      }

      if (command === "next-category") {
        event.stopPropagation?.();
        event.preventDefault?.();
        selectCategory(getAdjacentPredictionCategoryId(categoryId, "next"));
        return;
      }

      if (command === "toggle-watchlist" && selectedRow) {
        event.stopPropagation?.();
        event.preventDefault?.();
        toggleWatchlist(selectedRow);
        return;
      }

      if (command === "browse-top") {
        selectBrowseTab("top");
        return;
      }
      if (command === "browse-ending") {
        selectBrowseTab("ending");
        return;
      }
      if (command === "browse-new") {
        selectBrowseTab("new");
        return;
      }
      if (command === "browse-watchlist") {
        selectBrowseTab("watchlist");
      }
    },
    [
      blurSearch,
      categoryId,
      cycleDetailOutcome,
      detailOpen,
      detailTab,
      effectiveVenueScope,
      focusSearch,
      focused,
      hideTabs,
      scrollDetailBy,
      searchFocused,
      selectBrowseTab,
      selectCategory,
      selectedRow,
      setVenue,
      sortedOutcomeMarkets.length,
      toggleWatchlist,
    ],
  );

  useShortcut(handleSearchNavigation, {
    allowEditable: true,
    enabled: focused && searchFocused,
    phase: "before",
  });

  useShortcut(handleKeyboard);
}
