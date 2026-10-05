import type { NewsArticle } from "../../../../news/types";

/**
 * Filters a news list by a free-text query. Every word must appear in the
 * headline, source, summary, tickers, topics, or categories.
 */
export function filterNewsArticles<T extends NewsArticle>(
  articles: readonly T[],
  query: string,
): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return articles as T[];
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return articles as T[];

  return articles.filter((article) => {
    const haystack = [
      article.title,
      article.source,
      article.summary ?? "",
      ...article.tickers,
      ...article.topics,
      ...article.categories,
    ].join(" ").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/**
 * The empty list's copy. The filter and the mutes only see the stories the
 * list has loaded, so an empty result says so instead of claiming there is
 * no such story at all.
 */
export function newsListEmptyCopy(options: {
  query: string;
  /** Stories the list has loaded, before mutes. */
  loadedCount: number;
  /** Loaded stories left once the mutes are applied. */
  unmutedCount: number;
  fallback: { title: string; hint: string };
}): { title: string; hint: string } {
  if (options.loadedCount === 0) return options.fallback;
  if (options.unmutedCount === 0) {
    return {
      title: "Every loaded story is muted",
      hint: "Muted Sources and Muted Keywords are in the pane settings.",
    };
  }
  if (!options.query.trim()) return options.fallback;
  return {
    title: "No loaded story matches",
    hint: "Clear the filter to scroll and load older stories.",
  };
}
