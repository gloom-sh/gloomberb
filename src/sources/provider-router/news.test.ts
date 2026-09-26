import { describe, expect, test } from "bun:test";
import { ProviderRouterNewsRoutes } from "./news";

function failingSource() {
  return {
    id: "cloud",
    name: "cloud",
    news: {
      fetchNews: async () => {
        throw new Error("cloud down");
      },
    },
  };
}

describe("ProviderRouterNewsRoutes", () => {
  test.each([
    ["ticker", { feed: "ticker", ticker: "AAPL" }],
    ["global", { feed: "latest" }],
  ] as const)("throws when every %s news source fails", async (_label, query) => {
    const routes = new ProviderRouterNewsRoutes({
      newsSourcesInPriorityOrder: () => [failingSource()],
      logProviderError: () => {},
    });

    await expect(routes.getNews(query)).rejects.toThrow("cloud down");
  });
});
