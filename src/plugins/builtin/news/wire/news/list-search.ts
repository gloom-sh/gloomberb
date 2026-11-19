import { useCallback, useMemo } from "react";
import { usePaneFooter, useQueryBarSearch } from "../../../../../components";
import { useDebouncedPluginPaneState, usePluginPaneState } from "../../../../runtime";
import type { NewsArticle } from "../../../../../news/types";
import { filterNewsArticles } from "../filter-articles";

/**
 * Only what the list has loaded is filtered; older stories load as the list scrolls. A narrow pane's field shows
 * the short form whole rather than "filter loaded st".
 */
export const NEWS_LIST_SEARCH_PLACEHOLDER = ["filter loaded stories", "filter stories"] as const;

type ListPosition = { list: string; query: string; index: number };

export function useNewsListSearch<T extends NewsArticle>(articles: readonly T[], paneKey: string, list = paneKey) {
  const searchKey = list === paneKey ? `${paneKey}:search` : `${paneKey}:search:${list}`;
  const [searchQuery, setSearchQuery] = usePluginPaneState(searchKey, "");
  const [position, setPosition] = useDebouncedPluginPaneState<ListPosition | null>(`${paneKey}:scroll`, null);
  const initialScrollIndex = position?.list === list && position.query === searchQuery ? position.index : null;
  const onVisibleRangeChange = useCallback(({ start, end }: { start: number; end: number }) => {
    if (end <= start) return;
    setPosition((current) => current?.list === list && current.query === searchQuery && current.index === start
      ? current : { list, query: searchQuery, index: start });
  }, [list, searchQuery, setPosition]);
  const { active, focus, blur, searchProps } = useQueryBarSearch();
  const filteredArticles = useMemo(
    () => filterNewsArticles(articles, searchQuery),
    [articles, searchQuery],
  );

  return {
    searchQuery,
    searchFocused: active,
    filteredArticles,
    focusSearch: focus,
    blurSearch: blur,
    searchProps,
    setSearchQuery,
    initialScrollIndex,
    onVisibleRangeChange,
    visibleRangeKey: JSON.stringify([list, searchQuery]),
  };
}

export function useNewsListSearchHint(registrationId: string, visible: boolean, onPress: () => void) {
  usePaneFooter(`${registrationId}:search`, () => (
    visible
      ? { hints: [{ id: "search", key: "/", label: "search", onPress }] }
      : null
  ), [onPress, registrationId, visible]);
}
