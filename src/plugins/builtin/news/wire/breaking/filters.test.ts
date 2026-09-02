import { describe, expect, test } from "bun:test";
import type { MarketNewsItem } from "../../../../../types/news-source";
import {
  isSectorMuted,
  parseBreakingScope,
  parseMutedSectors,
  selectNotifiableArticles,
} from "./filters";

function article(overrides: Partial<MarketNewsItem> = {}): MarketNewsItem {
  return {
    id: "1",
    title: "Headline",
    url: "https://example.com/1",
    source: "Reuters",
    publishedAt: new Date("2026-09-01T12:00:00Z"),
    topic: "general",
    topics: [],
    sectors: [],
    categories: [],
    tickers: [],
    scores: { importance: 80, urgency: 80, marketImpact: 80, novelty: 50, confidence: 90 },
    isBreaking: true,
    isDeveloping: false,
    importance: 80,
    ...overrides,
  };
}

const watched = new Set(["AAPL", "MSFT"]);

describe("breaking notification scope", () => {
  const macro = article({ id: "macro", tickers: [] });
  const held = article({ id: "held", tickers: ["AAPL"] });
  const unrelated = article({ id: "unrelated", tickers: ["XOM"] });
  const all = [macro, held, unrelated];

  const idsFor = (scope: string) =>
    selectNotifiableArticles(all, {
      scope: parseBreakingScope(scope),
      mutedSectors: new Set(),
      watchedSymbols: watched,
    }).map((item) => item.id);

  test("watchlist-macro keeps tracked tickers and market-wide stories", () => {
    expect(idsFor("watchlist-macro")).toEqual(["macro", "held"]);
  });

  test("watchlist drops market-wide stories", () => {
    expect(idsFor("watchlist")).toEqual(["held"]);
  });

  test("macro drops every ticker-linked story", () => {
    expect(idsFor("macro")).toEqual(["macro"]);
  });

  test("all keeps everything", () => {
    expect(idsFor("all")).toEqual(["macro", "held", "unrelated"]);
  });

  test("unknown or missing scope falls back to watchlist-macro", () => {
    expect(parseBreakingScope(undefined)).toBe("watchlist-macro");
    expect(parseBreakingScope("nonsense")).toBe("watchlist-macro");
  });
});

describe("muted sectors", () => {
  const muted = new Set(["health_care"]);

  test("mutes a story confined to a muted sector", () => {
    expect(isSectorMuted(article({ sectors: ["health_care"] }), muted)).toBe(true);
  });

  test("keeps a story that also spans an unmuted sector", () => {
    expect(isSectorMuted(article({ sectors: ["health_care", "energy"] }), muted)).toBe(false);
  });

  test("keeps stories with no sector attribution", () => {
    expect(isSectorMuted(article({ sectors: [] }), muted)).toBe(false);
  });

  test("ignores malformed stored values", () => {
    expect(parseMutedSectors(undefined).size).toBe(0);
    expect(parseMutedSectors(["energy", 3, ""]).has("energy")).toBe(true);
    expect(parseMutedSectors(["energy", 3, ""]).size).toBe(1);
  });
});

describe("scope and mute combined", () => {
  test("a muted sector suppresses an otherwise in-scope watchlist story", () => {
    const pharma = article({ id: "pharma", tickers: ["AAPL"], sectors: ["health_care"] });
    const kept = selectNotifiableArticles([pharma], {
      scope: "watchlist-macro",
      mutedSectors: new Set(["health_care"]),
      watchedSymbols: watched,
    });
    expect(kept).toEqual([]);
  });
});
