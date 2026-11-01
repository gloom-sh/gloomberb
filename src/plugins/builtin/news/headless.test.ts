import { describe, expect, test } from "bun:test";
import type { CloudNewsPayload } from "../../../api-client";
import { renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
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

  test("asks for the saved listing of a bare symbol listed on several exchanges", async () => {
    const seen: NewsQuery[] = [];
    const definition = createTickerNewsHeadless(dependencies(seen));

    await definition.load(args("NVDA", { sentiment: "any", minImportance: 0, limit: 5 }), {
      resolveInstrument: async (symbol: string) => ({ symbol, exchange: "NASDAQ" }),
    } as unknown as HeadlessPaneContext);

    expect(seen[0]).toMatchObject({ feed: "ticker", ticker: "NVDA", exchange: "NASDAQ" });
  });
});

test("the text report lists a story's tickers and prints every time to the second, while JSON keeps the raw values", async () => {
  const base = story("pair", "neutral", 50, "2026-09-04T20:41:07.000Z");
  const pair: CloudNewsPayload = { ...base, tickerLinks: [...base.tickerLinks, { ...base.tickerLinks[0]!, symbol: "NVDA", canonicalTicker: "NVDA" }] };
  const definition = createTickerNewsHeadless({
    loadNews: async () => ({ items: [pair, stories[0]!], nextCursor: null }),
    now: () => new Date("2026-09-04T21:00:00.000Z"),
  });
  const loadArgs = args("AMD", { sentiment: "any", minImportance: 0, limit: 50 });
  const result = await definition.load(loadArgs, context);
  const text = renderHeadlessPaneText(definition, result, loadArgs, "CN");

  expect(text).toContain("2026-09-04 20:41:07 UTC");
  // A story published on a whole minute reads like the rest, not 20:00.
  expect(text).toContain("2026-09-04 20:00:00 UTC");
  expect(text).toMatch(/AMD, NVDA/);
  expect(text).not.toContain("[");
  const json = serializeHeadlessPaneResult(definition, result) as { items: Array<{ publishedAt: string; tickers: string[] }> };
  expect(json.items.map(({ publishedAt, tickers }) => ({ publishedAt, tickers }))).toEqual([
    { publishedAt: "2026-09-04T20:41:07.000Z", tickers: ["AMD", "NVDA"] },
    { publishedAt: "2026-09-04T20:00:00.000Z", tickers: ["AMD"] },
  ]);
});

test("fn CN prints a summary on one line under its row and none that repeats the headline, while exports keep each summary whole", async () => {
  const losses = { ...story("losses", "negative", 33, "2026-10-15T11:52:00.000Z"),
    headline: "September 2026 Monthly Release",
    summary: "Allstate estimated September catastrophe losses at $220 million,\n\nbringing third-quarter losses to $1.65 billion." };
  const echo = { ...story("echo", "neutral", 0, "2026-10-14T09:00:00.000Z"), headline: "Allstate declares dividend", summary: "Allstate declares dividend" };
  const definition = createTickerNewsHeadless({
    loadNews: async () => ({ items: [losses, echo], nextCursor: null }),
    now: () => new Date("2026-10-16T00:00:00.000Z"),
  });
  const loadArgs = args("ALL", { sentiment: "any", minImportance: 0, limit: 50 });
  const result = await definition.load(loadArgs, context);
  const text = renderHeadlessPaneText(definition, result, loadArgs, "CN").split("\n");
  const row = text.findIndex((line) => line.includes("September 2026 Monthly Release"));
  expect(text[row + 1]).toBe("  Allstate estimated September catastrophe losses at $220 million, bringing third-quarter losses to $1.65 billion.");
  const dividend = text.findIndex((line) => line.includes("Allstate declares dividend"));
  expect(text[dividend + 1]?.trim().startsWith("Allstate declares dividend")).toBe(false);
  const json = serializeHeadlessPaneResult(definition, result) as { items: Array<{ summary: string | null }> };
  expect(json.items.map((item) => item.summary)).toEqual([losses.summary, echo.summary]);
});
