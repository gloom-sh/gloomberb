import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { apiClient, type CloudMarketResponse, type CloudNewsListResponse, type CloudQuotePayload } from "../../api-client";
import { createDefaultConfig } from "../../types/config";
import type { GloomPlugin } from "../../types/plugin";
import { createGloomberbCloudCapabilities } from "../../sources/gloomberb-cloud";
import { createBrowserAppServices } from "./app-services";

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key) { return store.get(key) ?? null; },
    key(index) { return [...store.keys()][index] ?? null; },
    removeItem(key) { store.delete(key); },
    setItem(key, value) { store.set(key, String(value)); },
  };
}

const originalLocalStorage = globalThis.localStorage;
let activeServices: ReturnType<typeof createBrowserAppServices> | null = null;

afterEach(() => {
  setSystemTime();
  activeServices?.destroy();
  activeServices = null;
  if (originalLocalStorage === undefined) {
    delete (globalThis as Record<string, unknown>).localStorage;
  } else {
    Object.defineProperty(globalThis, "localStorage", { value: originalLocalStorage, configurable: true, writable: true });
  }
});

describe("createBrowserAppServices", () => {
  test("preserves news pagination, avoids duplicate fetches, caches resources, and tracks connection health", async () => {
    setSystemTime(new Date("2026-11-25T16:00:00Z"));
    Object.defineProperty(globalThis, "localStorage", { value: memoryStorage(), configurable: true, writable: true });

    const newsSpy = spyOn(apiClient, "getCloudNews").mockResolvedValue({
      items: [{
        id: "story-1",
        headline: "Apple ships update",
        summary: "Summary",
        primaryUrl: "https://example.com/1",
        primarySource: "reuters",
        primaryPublisher: "Reuters",
        firstPublishedAt: new Date().toISOString(),
        tickerLinks: [{ symbol: "AAPL", exchange: "XNAS", canonicalTicker: "AAPL:XNAS" }],
      }],
      nextCursor: "cursor-page-2",
      access: "realtime",
    } as unknown as CloudNewsListResponse);

    const quoteSpy = spyOn(apiClient, "getCloudQuote").mockResolvedValue({
      status: "success",
      data: {
        symbol: "AAPL",
        exchangeName: "XNAS",
        name: "Apple Inc.",
        currency: "USD",
        price: 200,
        previousClose: 199,
        change: 1,
        changePercent: 0.5,
        volume: 1000,
        marketState: "REGULAR",
        lastUpdated: Date.now(),
      },
    } as unknown as CloudMarketResponse<CloudQuotePayload>);

    try {
      const cloudPlugin: GloomPlugin = {
        id: "gloomberb-cloud",
        name: "Gloom Cloud",
        version: "1.0.0",
        capabilities: createGloomberbCloudCapabilities(),
      };

      activeServices = createBrowserAppServices({
        config: createDefaultConfig("/browser"),
        plugins: [cloudPlugin],
      });
      await activeServices.ready;

      // Single news request per query, preserving nextCursor for Load More.
      const page = await activeServices.newsService.load({ feed: "ticker", ticker: "AAPL", exchange: "XNAS" });
      expect(newsSpy).toHaveBeenCalledTimes(1);
      expect(page.articles).toHaveLength(1);
      expect(page.nextCursor).toBe("cursor-page-2");

      // Single quote request, written through to browser persistence resources.
      const quote = await activeServices.dataProvider.getQuote("AAPL", "XNAS");
      expect(quoteSpy).toHaveBeenCalledTimes(1);
      expect(quote.price).toBe(200);
      expect(
        activeServices.persistence.resources.list({ namespace: "market", kind: "quote", entityKey: "AAPL" }),
      ).toHaveLength(1);

      const snapshot = activeServices.pluginRegistry.connectionHealth.getSnapshot();
      const marketSource = snapshot.sources.find((source) => source.id === "asset-data.gloomberb-cloud");
      const newsSource = snapshot.sources.find((source) => source.id === "news.gloomberb-cloud");
      expect(marketSource?.status).toBe("connected");
      expect(newsSource?.status).toBe("connected");
    } finally {
      newsSpy.mockRestore();
      quoteSpy.mockRestore();
    }
  });
});
