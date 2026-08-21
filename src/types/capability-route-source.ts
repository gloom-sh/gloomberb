import type { AssetDataProvider } from "./data-provider";
import type { NewsArticle, NewsPage, NewsQuery } from "../news/types";
import type { CachePolicyMap } from "./persistence";

export interface NewsDataProvider {
  supports?(query: NewsQuery): boolean;
  getCachedNews?(query: NewsQuery): NewsArticle[];
  fetchNews(query: NewsQuery): Promise<NewsArticle[]>;
  fetchNewsPage?(query: NewsQuery): Promise<NewsPage>;
  fetchNewsStory?(storyId: string): Promise<NewsArticle | null>;
}

export interface CapabilityRouteSource {
  readonly id: string;
  readonly name: string;
  readonly priority?: number;
  readonly cachePolicy?: CachePolicyMap;
  isEnabled?(): boolean;
  readonly market?: AssetDataProvider;
  readonly news?: NewsDataProvider;
}

export function routeSourcePriority(source: Pick<CapabilityRouteSource, "priority">): number {
  return source.priority ?? 1000;
}
