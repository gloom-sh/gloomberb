import { describe, expect, test } from "bun:test";
import type { CloudNewsPayload } from "../../../api-client";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import type { NewsQuery } from "../../../news/types";
import {
  createNewsFeedHeadless,
  createTickerNewsHeadless,
  type NewsHeadlessDependencies,
} from "./headless";

function story(
  id: string,
  sentiment: CloudNewsPayload["sentiment"],
  importance: number,
  publishedAt: string,
): CloudNewsPayload {
  return {
    id,
    headline: `${id} headline`,
    summary: `${id} summary`,
    category: "markets",
    sentiment,
    sectors: ["technology"],
    firstPublishedAt: publishedAt,
    lastPublishedAt: publishedAt,
    firstSeenAt: publishedAt,
    lastSeenAt: publishedAt,
    primaryUrl: `https://example.com/${id}`,
    primarySource: "Example Wire",
    scores: {
      importance,
      urgency: importance - 1,
      marketImpact: importance - 2,
      novelty: 7,
      confidence: 90,
    },
    flags: { breaking: importance > 80 },
    variantCount: 1,
    sourceCount: 1,
    sources: ["Example Wire"],
    entities: [],
    tickerLinks: [{
      symbol: "AMD",
      exchange: "NASDAQ",
      canonicalTicker: "AMD",
      relationType: "issuer",
      displayTier: "primary",
      confidence: 1,
      relevanceScore: 1,
    }],
  };
}

const stories = [
  story("newer", "positive", 95, "2026-09-04T20:00:00.000Z"),
  story("older", "negative", 70, "2026-09-04T18:00:00.000Z"),
];

function args(
  symbol: string | null,
  options: Record<string, string | number | boolean>,
): HeadlessPaneLoadArgs {
  return {
    rawArgument: symbol ?? "",
    argument: symbol,
    symbols: symbol ? [symbol] : [],
    options,
  };
}

const context = {} as HeadlessPaneContext;

function dependencies(seen: NewsQuery[]): NewsHeadlessDependencies {
  return {
    loadNews: async (query) => {
      seen.push(query);
      return { items: stories, nextCursor: "page-2" };
    },
    now: () => new Date("2026-09-04T21:00:00.000Z"),
  };
}

describe("news feed headless", () => {
  test("maps cloud stories into a point-in-time snapshot", async () => {
    const seen: NewsQuery[] = [];
    const definition = createNewsFeedHeadless(dependencies(seen));

    const result = await definition.load(
      args(null, { sentiment: "any", minImportance: 0, limit: 50 }),
      context,
    );

    expect(result.asOf).toBe("2026-09-04T21:00:00.000Z");
    expect(result.items[0]).toMatchObject({
      id: "newer",
      headline: "newer headline",
      tickers: ["AMD"],
      sentiment: "positive",
      importance: 95,
      breaking: true,
      sourceCount: 1,
    });
    expect(seen[0]).toMatchObject({ feed: "latest", limit: 50 });
  });

  test("applies sentiment and importance options", async () => {
    const definition = createNewsFeedHeadless(dependencies([]));

    const result = await definition.load(
      args(null, { sentiment: "positive", minImportance: 90, limit: 50 }),
      context,
    );

    expect(result.items.map((item) => item.id)).toEqual(["newer"]);
  });
});

describe("ticker news headless", () => {
  test("requests the ticker feed and applies the row limit", async () => {
    const seen: NewsQuery[] = [];
    const definition = createTickerNewsHeadless(dependencies(seen));

    const result = await definition.load(
      args("AMD:XNAS", { sentiment: "any", minImportance: 0, limit: 1 }),
      context,
    );

    expect(seen[0]).toMatchObject({
      feed: "ticker",
      ticker: "AMD",
      exchange: "NASDAQ",
      tickerTier: "primary",
      limit: 1,
    });
    expect(result.items).toHaveLength(1);
    expect(result.metadata).toMatchObject({ truncated: true });
  });
});
