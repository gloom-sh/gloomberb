import type { GloomPlugin } from "../../../types/plugin";
import type { NewsArticle, NewsQuery } from "../../../types/news-source";
import { normalizeNewsFeed } from "../../../news/news-model";
import { YahooFinanceClient } from "../../../sources/yahoo-finance";
import { assetDataProvider, newsProvider } from "../../../capabilities";

class YahooPluginProvider extends YahooFinanceClient {
  readonly priority = 1000;
}

function createYahooProvider() {
  return new YahooPluginProvider();
}

function createYahooNewsProvider(provider: YahooPluginProvider) {
  return {
    supports(query: NewsQuery): boolean {
      return normalizeNewsFeed(query) === "ticker" && !!query.ticker;
    },
    async fetchNews(query: NewsQuery): Promise<NewsArticle[]> {
      if (normalizeNewsFeed(query) !== "ticker" || !query.ticker) return [];
      return provider.getNews(query.ticker.trim().toUpperCase(), query.limit ?? 50, query.exchange ?? "");
    },
  };
}

const yahooProvider = createYahooProvider();

export const yahooPlugin: GloomPlugin = {
  id: "yahoo",
  name: "Yahoo Fallback",
  version: "1.0.0",
  description: "Built-in delayed fallback for quotes, fundamentals, charts, and unsupported cloud data.",
  capabilities: [
    assetDataProvider(yahooProvider),
    newsProvider({ id: "yahoo", name: "Yahoo Finance", priority: 1000, provider: createYahooNewsProvider(yahooProvider) }),
  ],
};
