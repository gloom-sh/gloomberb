import { apiClient } from "../../../api-client";
import { newsProvider, type NewsCapability } from "../../../capabilities";
import { cloudNewsParams, mapCloudNewsArticle } from "../../../sources/gloomberb-cloud/news";
import type { NewsArticle, NewsPage, NewsQuery } from "../../../news/types";

interface BackendNews {
  id: string;
  name: string;
  getNews(query: NewsQuery): Promise<NewsArticle[]>;
  getNewsPage(query: NewsQuery): Promise<NewsPage>;
}

type CloudNewsClient = Pick<typeof apiClient, "getCloudNews" | "getCloudNewsStory">;

/**
 * The view's only news source: the desktop view runs without capability
 * handlers, so the Gloom Cloud news capability lives in the backend and is not
 * registered here. Lists come through the backend; a page or a story by id
 * is read from Gloom Cloud directly, which is what opens a story from a chat
 * link that carries no list copy.
 */
export function createDesktopNewsSource(backend: BackendNews, client: CloudNewsClient = apiClient): NewsCapability {
  return newsProvider({
    id: backend.id,
    name: backend.name,
    priority: 0,
    provider: {
      fetchNews: (query) => backend.getNews(query),
      fetchNewsPage: async (query) => {
        try {
          const response = await client.getCloudNews(cloudNewsParams(query));
          return {
            articles: response.items.map((item) => mapCloudNewsArticle(item, query.ticker)),
            nextCursor: response.nextCursor ?? null,
          };
        } catch {
          // The aggregate page keeps RSS failures beside any usable stories.
          return backend.getNewsPage(query);
        }
      },
      fetchNewsStory: async (storyId) => mapCloudNewsArticle(await client.getCloudNewsStory(storyId)),
    },
  });
}
