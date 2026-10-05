import { useMemo, useState } from "react";
import { usePaneFooter, useQueryBarSearch } from "../../../../../components";
import type { NewsArticle } from "../../../../../news/types";
import { filterNewsArticles } from "../filter-articles";

/** Only what the list has loaded is filtered; older stories load as the list scrolls. */
export const NEWS_LIST_SEARCH_PLACEHOLDER = "filter loaded stories";

export function useNewsListSearch<T extends NewsArticle>(articles: readonly T[]) {
  const [searchQuery, setSearchQuery] = useState("");
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
  };
}

export function useNewsListSearchHint(registrationId: string, visible: boolean, onPress: () => void) {
  usePaneFooter(`${registrationId}:search`, () => (
    visible
      ? { hints: [{ id: "search", key: "/", label: "search", onPress }] }
      : null
  ), [onPress, registrationId, visible]);
}
