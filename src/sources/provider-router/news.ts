import { normalizeNewsFeed } from "../../news/news-model";
import type { NewsArticle, NewsQuery } from "../../news/types";
import type { CapabilityRouteSource } from "../../types/capability-route-source";
import { shouldLogProviderError } from "../provider-errors";

interface ProviderRouterNewsRoutesOptions {
  newsSourcesInPriorityOrder: () => CapabilityRouteSource[];
  logProviderError: (message: string) => void;
}

export class ProviderRouterNewsRoutes {
  constructor(private readonly options: ProviderRouterNewsRoutesOptions) {}

  async getNews(query: NewsQuery): Promise<NewsArticle[]> {
    const sources = this.options.newsSourcesInPriorityOrder()
      .filter((source) => source.news?.supports?.(query) ?? true);
    const feed = normalizeNewsFeed(query);
    if (feed === "ticker") {
      let firstEmpty: NewsArticle[] | null = null;
      let lastError: unknown = null;
      let sawSuccess = false;
      for (const source of sources) {
        try {
          const articles = await source.news!.fetchNews(query);
          sawSuccess = true;
          if (articles.length > 0) return articles;
          firstEmpty ??= articles;
        } catch (error) {
          lastError = error;
          if (shouldLogProviderError(error)) {
            this.options.logProviderError(`${source.id} failed: ${error}`);
          }
        }
      }
      if (!sawSuccess && lastError) throw lastError;
      return firstEmpty ?? [];
    }

    const settled = await Promise.allSettled(sources.map((source) => source.news!.fetchNews(query)));
    const articles = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (
      articles.length === 0
      && settled.length > 0
      && settled.every((result) => result.status === "rejected")
    ) {
      const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      throw rejected?.reason ?? new Error("News sources are unavailable");
    }
    return articles;
  }
}
