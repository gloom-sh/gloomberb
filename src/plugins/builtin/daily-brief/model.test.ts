import { describe, expect, test } from "bun:test";
import type { EconEvent } from "../econ/types";
import { FUTURES_CONTRACTS } from "../../../market-data/futures-board";
import type { NewsArticle } from "../../../news/types";
import { assembleBrief, BRIEF_FUTURES, type BriefSlices } from "./model";

function article(id: string): NewsArticle {
  return {
    id,
    title: `Story ${id}`,
    url: `https://example.com/${id}`,
    source: "Wire",
    publishedAt: new Date("2026-10-05T12:00:00.000Z"),
    topic: "markets",
    topics: [],
    sectors: [],
    categories: [],
    tickers: [],
    scores: { importance: 0, urgency: 0, marketImpact: 0, novelty: 0, confidence: 0 },
    isBreaking: false,
    isDeveloping: false,
    importance: 0,
  };
}

function econ(id: string, time: string, date: string): EconEvent {
  return {
    id,
    date: new Date(date),
    time,
    country: "US",
    event: "CPI",
    actual: null,
    forecast: null,
    prior: null,
    impact: "high",
  };
}

function slices(partial: Partial<BriefSlices> & Pick<BriefSlices, "now">): BriefSlices {
  return {
    quotes: new Map(),
    articles: [],
    earnings: [],
    econ: [],
    fetchedAt: [],
    ...partial,
  };
}

describe("assembleBrief", () => {
  test("a New York evening keeps the New York date", () => {
    const brief = assembleBrief(slices({ now: Date.parse("2026-10-05T03:30:00Z") }));
    expect(brief.session.date).toBe("2026-10-04");
  });

  test("premarket and the regular session follow the New York clock", () => {
    expect(assembleBrief(slices({ now: Date.parse("2026-10-05T10:40:00Z") })).session.phase).toBe("pre");
    expect(assembleBrief(slices({ now: Date.parse("2026-10-05T14:30:00Z") })).session.phase).toBe("regular");
  });

  test("headlines keep the first eight in order", () => {
    const articles = Array.from({ length: 12 }, (_, index) => article(String(index + 1)));
    const brief = assembleBrief(slices({ now: Date.parse("2026-10-05T14:30:00Z"), articles }));
    expect(brief.headlines).toHaveLength(8);
    expect(brief.headlines[0]?.articleId).toBe("1");
  });

  test("earnings stay on the session date", () => {
    const brief = assembleBrief(slices({
      now: Date.parse("2026-10-05T03:30:00Z"),
      earnings: [
        { symbol: "AEHR", date: "2026-10-04", timing: "amc", name: "Aehr Test Systems", epsEstimate: 0.12, revenueEstimate: 1_500_000 },
        { symbol: "MSS", date: "2026-10-04", timing: null, name: "  ", epsEstimate: null, revenueEstimate: null },
        { symbol: "DAL", date: "2026-10-04", timing: "bmo", name: "Delta Air Lines", epsEstimate: 1.4, revenueEstimate: null },
        { symbol: "NVDA", date: "2026-10-05", timing: "amc", name: "NVIDIA", epsEstimate: 0.7, revenueEstimate: 30_000_000_000 },
      ],
    }));
    expect(brief.events.map((event) => event.symbol)).toEqual(["DAL", "AEHR", "MSS"]);
    expect(brief.events.find((event) => event.symbol === "AEHR")).toMatchObject({
      name: "Aehr Test Systems",
      epsEstimate: 0.12,
      revenueEstimate: 1_500_000,
    });
    expect(brief.events.find((event) => event.symbol === "DAL")?.epsEstimate).toBe(1.4);
    expect(brief.events.find((event) => event.symbol === "MSS")).toMatchObject({
      name: null,
      epsEstimate: null,
      revenueEstimate: null,
    });
  });

  test("an econ release uses the New York date when UTC has already rolled", () => {
    const brief = assembleBrief(slices({
      now: Date.parse("2026-10-05T03:30:00Z"),
      econ: [econ("cpi", "23:30", "2026-10-05T03:30:00Z")],
    }));
    expect(brief.events.map((event) => event.id)).toEqual(["cpi"]);
  });

  test("events sort by time", () => {
    const brief = assembleBrief(slices({
      now: Date.parse("2026-10-05T14:30:00Z"),
      econ: [
        econ("late", "16:05", "2026-10-05T14:30:00Z"),
        econ("open", "08:30", "2026-10-05T14:30:00Z"),
        econ("mid", "10:00", "2026-10-05T14:30:00Z"),
      ],
    }));
    expect(brief.events.map((event) => event.at)).toEqual(["08:30", "10:00", "16:05"]);
  });

  test("a missing last still keeps the futures symbol", () => {
    const brief = assembleBrief(slices({
      now: Date.parse("2026-10-05T14:30:00Z"),
      quotes: new Map([["ES=F", { last: null, changePercent: null }]]),
    }));
    expect(brief.markets.map((row) => row.symbol)).toEqual([...BRIEF_FUTURES]);
    expect(brief.markets.map((row) => row.label)).toEqual(["ES", "NQ", "CL"]);
    expect(brief.markets[0]).toMatchObject({ symbol: "ES=F", label: "ES", last: null });
  });

  test("the futures strip is copied from the futures board", () => {
    for (const symbol of BRIEF_FUTURES) {
      expect(FUTURES_CONTRACTS.some((contract) => contract.symbol === symbol)).toBe(true);
    }
  });

  test("asOf is the oldest stamp", () => {
    const brief = assembleBrief(slices({
      now: Date.parse("2026-10-05T14:30:00Z"),
      fetchedAt: ["2026-10-05T14:00:00.000Z", Date.parse("2026-10-05T13:00:00.000Z")],
    }));
    expect(brief.asOf).toBe("2026-10-05T13:00:00.000Z");
  });
});
