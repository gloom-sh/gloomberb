import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newsProvider } from "../capabilities";
import type { NewsArticle, NewsPage, NewsQuery } from "../news/types";
import { NewsService } from "../news/aggregator";
import { createTestArticle } from "../test-support/news";
import { createRpcLoopback } from "../test-support/rpc-loopback";
import { DesktopCapabilityBridge } from "../renderers/electrobun/bun/desktop/capability-bridge";
import { decodeRpcResponse, decodeRpcValue, encodeRpcResponse, encodeRpcValue } from "../renderers/electrobun/shared/rpc-codec";
import { createDesktopNewsSource } from "../renderers/electrobun/view/news-source";
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

test.each([
  { name: "failed feed", articles: [], error: "1 of 1 RSS feeds unavailable.", nextCursor: null },
  { name: "partial feed", articles: [createTestArticle("kept-story")], error: "1 of 2 RSS feeds unavailable.", nextCursor: "older-stories" },
  { name: "successful empty feed", articles: [], error: null, nextCursor: null },
])("desktop fallback preserves $name through the aggregate news RPC", async (page) => {
  dataDir = await mkdtemp(join(tmpdir(), "gloomberb-news-fallback-"));
  services = createAppServices({
    config: createDefaultConfig(dataDir),
    plugins: [{
      id: "fixture-news", name: "Fixture News", version: "1.0.0",
      capabilities: [newsProvider({
        id: "fixture-news", name: "Fixture News",
        provider: { fetchNews: async () => page.articles, fetchNewsPage: async () => page },
      })],
    }],
  });
  await services.ready;

  const bridge = new DesktopCapabilityBridge({ getRegistry: () => services!.pluginRegistry.capabilities, getWindowKey: () => "news" });
  const send = createRpcLoopback((request) => encodeRpcResponse(() => bridge.handle(
    { send: { "capability.event": () => {} } }, decodeRpcValue(request),
  )));
  const request = <T,>(operationId: string, query: NewsQuery): Promise<T> => send(encodeRpcValue({
    method: "capability.invoke", payload: { capabilityId: "news.core", operationId, payload: { query } },
  })).then(decodeRpcResponse<T>);
  const desktop = new NewsService();
  desktop.register(createDesktopNewsSource({
    id: "desktop-backend", name: "Desktop Backend",
    getNews: (query) => request<NewsArticle[]>("fetchNews", query),
    getNewsPage: (query) => request<NewsPage>("fetchNewsPage", query),
  }, {
    getCloudNews: async () => { throw new Error("Direct news request unavailable"); },
    getCloudNewsStory: async () => { throw new Error("Story request not used"); },
  }));
  try {
    const state = await desktop.load({ feed: "latest" });
    expect(state.error).toBe(page.error);
    expect(state.articles.map((article) => article.id)).toEqual(page.articles.map((article) => article.id));
    expect(state.nextCursor).toBe(page.nextCursor);
    if (state.articles.length) expect(state.articles[0]!.publishedAt).toBeInstanceOf(Date);
  } finally {
    desktop.stop();
    bridge.disposeAll();
  }
});
