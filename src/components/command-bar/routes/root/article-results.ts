import type { NewsArticle } from "../../../../news/types";
import {
  looksLikeArticleQuery,
  searchNewsArticles,
} from "../../../../plugins/builtin/news/wire/article-search";
import type { ResultItem } from "../../list/model";

/**
 * Builds command-bar rows for an article-lookup (`ART`) query by matching the
 * typed text against the loaded news feed.
 */
export function buildArticleSearchResultItems(options: {
  articles: readonly NewsArticle[];
  cloudArticles?: readonly NewsArticle[];
  query: string;
  phase?: "idle" | "loading" | "ready" | "refreshing" | "error";
  onOpen: (article: NewsArticle) => void;
}): ResultItem[] {
  const query = options.query.trim();
  if (!query || !looksLikeArticleQuery(query)) return [];

  const seen = new Set<string>();
  const matches = [
    ...(options.cloudArticles ?? []),
    ...searchNewsArticles(options.articles, query),
  ].filter((article) => {
    if (seen.has(article.id)) return false;
    seen.add(article.id);
    return true;
  }).slice(0, 8);
  const items = matches.map((article) => ({
    id: `article:${article.id}`,
    label: article.title,
    detail: article.source,
    category: "Articles",
    kind: "action" as const,
    right: "ART",
    searchText: [
      article.title,
      article.source,
      article.summary ?? "",
      ...article.topics,
      ...article.categories,
      "article",
      "news",
      "press",
    ].join(" "),
    action: () => options.onOpen(article),
  }));

  if (items.length > 0) return items;
  if (options.phase === "loading" || options.phase === "idle" || options.phase === "refreshing") {
    return [{
      id: "article:loading",
      label: "Looking up articles…",
      detail: "",
      category: "Articles",
      kind: "info",
      defaultSelectable: false,
      action: () => {},
    }];
  }
  return [];
}
