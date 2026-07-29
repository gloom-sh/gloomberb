import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newsProvider } from "../capabilities";
import type { NewsArticle } from "../news/types";
import { createDefaultConfig } from "../types/config";
import type { GloomPlugin } from "../types/plugin";
import { createAppServices, type AppServices } from "./app-services";

let services: AppServices | null = null;
let dataDir: string | null = null;

afterEach(async () => {
  services?.destroy();
  services = null;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = null;
});

test("the router does not re-enter the aggregate news facade", async () => {
  dataDir = await mkdtemp(join(tmpdir(), "gloomberb-news-composition-"));
  let fetchCount = 0;
  const article: NewsArticle = {
    id: "composition-story",
    title: "Composition story",
    url: "https://composition.example.com/story",
    source: "Test",
    publishedAt: new Date("2026-07-26T12:00:00.000Z"),
    topic: "markets",
    topics: ["markets"],
    sectors: [],
    categories: ["markets"],
    tickers: [],
    scores: { importance: 50, urgency: 0, marketImpact: 50, novelty: 0, confidence: 100 },
    importance: 50,
    isBreaking: false,
    isDeveloping: false,
  };
  const plugin: GloomPlugin = {
    id: "composition-news",
    name: "Composition News",
    version: "1.0.0",
    capabilities: [newsProvider({
      id: "composition-news",
      name: "Composition News",
      provider: {
        fetchNews: async () => {
          fetchCount++;
          return [article];
        },
      },
    })],
  };

  services = createAppServices({
    config: createDefaultConfig(dataDir),
    plugins: [plugin],
  });
  await services.ready;

  const articles = await services.providerRouter.getNews({ feed: "latest", limit: 20 });

  expect(fetchCount).toBe(1);
  expect(articles.map((item) => item.id)).toEqual([article.id]);
});
