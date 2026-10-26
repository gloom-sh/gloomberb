import { expect, test } from "bun:test";
import type { CloudNewsListResponse } from "../../api-client";
import type { NewsQuery } from "../../news/types";
import { cloudNewsAccess, cloudNewsReadArticles, readCloudNews } from "./news";

function story(id: string, tickers: string[] = []) {
  const at = "2026-10-20T21:41:38.000Z";
  return {
    id, headline: `Story ${id}`, summary: "", topic: "crypto", category: "crypto", sentiment: "neutral", sectors: [],
    firstPublishedAt: at, lastPublishedAt: at, firstSeenAt: at, lastSeenAt: at,
    primaryUrl: `https://example.com/${id}`, primarySource: "wire", primaryPublisher: "Wire",
    variantCount: 1, sourceCount: 1, sources: ["wire"], entities: [],
    tickerLinks: tickers.map((symbol) => ({ symbol, canonicalTicker: symbol })),
  } as unknown as CloudNewsListResponse["items"][number];
}

/** Gloom Cloud with no story filed under the asked ticker unless `filed` has some; every search is kept. */
function cloud({ filed = [], found = [story("btc-1", ["BTC"]), story("btc-2", ["BTC", "JPM"])], searchFails = false }: {
  filed?: CloudNewsListResponse["items"];
  found?: CloudNewsListResponse["items"];
  searchFails?: boolean;
} = {}) {
  const searches: Array<[string, number | undefined]> = [];
  return {
    searches,
    client: {
      getCloudNews: async () => ({ items: filed, nextCursor: filed.length ? "next" : null }),
      searchCloudNews: async (text: string, limit?: number) => {
        searches.push([text, limit]);
        if (searchFails) throw new Error("search down");
        return { items: found, nextCursor: null };
      },
    },
  };
}

const tickerQuery = (ticker: string, extra: Partial<NewsQuery> = {}): NewsQuery => ({ feed: "ticker", ticker, exchange: "CCC", limit: 20, ...extra });

test("a coin pair with no story filed under it reads the stories that mention the coin, each marked with what was searched", async () => {
  const { client, searches } = cloud();
  const read = await readCloudNews(client as never, tickerQuery("BTC-USD"));
  expect(searches).toEqual([["bitcoin", 20]]);
  expect(read).toMatchObject({ searchedFor: "bitcoin", nextCursor: null });
  const articles = cloudNewsReadArticles(read, "BTC-USD");
  expect(articles.map((article) => [article.id, article.searchedFor, article.tickers])).toEqual([
    ["btc-1", "bitcoin", ["BTC"]],
    ["btc-2", "bitcoin", ["BTC", "JPM"]],
  ]);

  // A coin the major names do not cover is searched by its listing's name, without the quote currency.
  const other = cloud();
  await readCloudNews(other.client as never, tickerQuery("HYPE32196-USD", { listingName: "Hyperliquid USD" }));
  expect(other.searches).toEqual([["hyperliquid", 20]]);
});

test("only an empty first page of a coin pair's feed falls back, and a failed search keeps the empty answer", async () => {
  const cases: Array<[string, NewsQuery, Parameters<typeof cloud>[0]]> = [
    ["a company", { feed: "ticker", ticker: "AAPL", exchange: "NASDAQ", limit: 20 }, {}],
    ["stories filed under the pair", tickerQuery("BTC-USD"), { filed: [story("filed", ["BTC-USD"])] }],
    ["a later page", tickerQuery("BTC-USD", { cursor: "page-2" }), {}],
    ["a coin with no name to search", tickerQuery("PEPE24478-USD"), {}],
    ["a currency pair", { feed: "ticker", ticker: "EUR-USD", limit: 20 }, {}],
    ["the latest feed", { feed: "latest", limit: 20 }, {}],
  ];
  for (const [, query, options] of cases) {
    const { client, searches } = cloud(options);
    const read = await readCloudNews(client as never, query);
    expect(read.searchedFor).toBeUndefined();
    expect(searches).toEqual([]);
  }

  const failing = cloud({ searchFails: true });
  const read = await readCloudNews(failing.client as never, tickerQuery("BTC-USD"));
  expect(failing.searches).toEqual([["bitcoin", 20]]);
  expect(read).toEqual({ items: [], nextCursor: null, access: null });
});

test("an answer is held back when no session went with it, and live only when it holds a story too recent to hold back", async () => {
  const now = Date.parse("2026-10-26T17:00:00.000Z");
  const seen = (hoursAgo: number) => ({ ...story(`seen-${hoursAgo}h`), lastSeenAt: new Date(now - hoursAgo * 3_600_000).toISOString() });
  // No session: the service holds news back for anyone it cannot name.
  expect(cloudNewsAccess({ items: [seen(1)] }, false, now)).toBe("delayed");
  // A session and a story seen an hour ago: only the live wire carries it.
  expect(cloudNewsAccess({ items: [seen(13), seen(1)] }, true, now)).toBe("realtime");
  // Nothing newer than the delay, or within the hour left for the clocks to disagree: a quiet live feed looks the same as a held-back one.
  expect(cloudNewsAccess({ items: [seen(13)] }, true, now)).toBeNull();
  expect(cloudNewsAccess({ items: [seen(11.5)] }, true, now)).toBeNull();
  expect(cloudNewsAccess({ items: [] }, true, now)).toBeNull();
  // What the service says wins.
  expect(cloudNewsAccess({ items: [seen(1)], access: "delayed" }, true, now)).toBe("delayed");

  // A read asks the client whether a session goes with the request.
  const signedOut = { ...cloud({ filed: [story("filed")] }).client, hasSessionCredential: () => false };
  expect((await readCloudNews(signedOut as never, { feed: "top", limit: 20 })).access).toBe("delayed");
});
