import type { NewsArticle } from "../news/types";

export function createTestArticle(id: string, overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id,
    title: id,
    url: `https://example.com/${id}`,
    source: "Test",
    publishedAt: new Date(),
    topic: "general",
    topics: ["general"],
    sectors: [],
    categories: [],
    tickers: [],
    scores: { importance: 50, urgency: 0, marketImpact: 50, novelty: 0, confidence: 0 },
    importance: 50,
    isBreaking: false,
    isDeveloping: false,
    ...overrides,
  };
}
