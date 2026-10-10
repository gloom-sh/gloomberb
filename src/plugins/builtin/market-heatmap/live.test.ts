import { describe, expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import type { QueryEntry } from "../../../market-data/result-types";
import { buildQuoteKey } from "../../../market-data/selectors";
import { resolveScreenerQuoteFeedStatus } from "../../../market-data/quotes/screener-live-quotes";
import type { HeatmapBoardAsset } from "./portfolio";
import {
  HEATMAP_MAX_QUOTE_TARGETS,
  buildHeatmapQuoteTargets,
  liveHeatmapWeight,
  rankHeatmapQuoteWeights,
} from "./live";

function asset(symbol: string, size: number, extra: Partial<HeatmapBoardAsset> = {}): HeatmapBoardAsset {
  return {
    symbol, name: symbol, price: 100, change: 0, changePercent: 0, hasChange: true, size, sizeKind: "market-cap",
    volume: null, currency: "USD", exchange: "NASDAQ", sector: null, industry: null, marketState: null, source: "gloom", ...extra,
  };
}

function entry(quote: Quote): QueryEntry<Quote> {
  return { phase: "ready", data: quote, lastGoodData: quote, source: "gloomberb-cloud", fetchedAt: quote.receivedAt ?? null, staleAt: null, error: null, attempts: [] };
}

describe("heat map stream targets", () => {
  // Ranked in an order the server cannot recover alphabetically: the largest name sorts last.
  const board = Array.from({ length: 600 }, (_, index) => asset(`S${String(599 - index).padStart(3, "0")}`, 1e12 / (index + 1)));

  test("the largest names rank first with distinct weights, capped at 500, and only the selection is marked", () => {
    const weights = rankHeatmapQuoteWeights(board, null);
    const targets = buildHeatmapQuoteTargets(board, weights, "S500");

    expect(targets).toHaveLength(HEATMAP_MAX_QUOTE_TARGETS);
    expect(targets[0]!.symbol).toBe("S599");
    const ranked = targets.map((target) => target.weight!);
    for (let index = 1; index < ranked.length; index += 1) expect(ranked[index]!).toBeLessThan(ranked[index - 1]!);
    // At or under the off-screen ceiling, so covering the pane rewrites nothing.
    expect(ranked[0]!).toBeLessThanOrEqual(10);
    expect(ranked[ranked.length - 1]!).toBeGreaterThan(0);
    expect(targets.filter((target) => target.selected).map((target) => target.symbol)).toEqual(["S500"]);
    expect(targets.some((target) => "visible" in target)).toBe(false);
    expect(targets.every((target) => target.surface === "screener")).toBe(true);
  });

  test("a refresh that reorders names keeps their weights, so nothing is re-sent", () => {
    const first = rankHeatmapQuoteWeights([asset("A", 300), asset("B", 200), asset("C", 100)], null);
    const reordered = rankHeatmapQuoteWeights([asset("B", 310), asset("A", 300), asset("C", 100), asset("D", 50)], first);

    expect(reordered.get("A")).toBe(first.get("A"));
    expect(reordered.get("B")).toBe(first.get("B"));
    expect(reordered.get("D")).toBeLessThan(reordered.get("C")!);
  });

  test("a tile sized by market cap follows the live price; one sized by its own weight does not", () => {
    const snapshot = asset("A", 1000);
    expect(liveHeatmapWeight(snapshot, { ...snapshot, price: 110 })).toBeCloseTo(1100);
    expect(liveHeatmapWeight(snapshot, snapshot)).toBe(1000);
    const position = asset("B", 1000, { weight: 40 });
    expect(liveHeatmapWeight(position, { ...position, price: 110 })).toBe(40);
  });

  test("the footer says live only when every target streams real-time quotes", () => {
    const names = [asset("A", 3), asset("B", 2), asset("C", 1)];
    const targets = buildHeatmapQuoteTargets(names, rankHeatmapQuoteWeights(names, null), null);
    const now = 10_000;
    const quote = (symbol: string, dataSource: "live" | "delayed"): Quote => ({
      symbol, price: 100, change: 0, changePercent: 0, currency: "USD", lastUpdated: now, receivedAt: now,
      delivery: "stream", stale: false, dataSource,
    });
    const status = (sources: Record<string, "live" | "delayed">) => resolveScreenerQuoteFeedStatus(
      targets,
      new Map(Object.entries(sources).map(([symbol, source]) => [buildQuoteKey({ symbol, exchange: "NASDAQ" }), entry(quote(symbol, source))])),
      { now, subscriptionStartedAt: 0 },
    );

    expect(status({ A: "live", B: "live", C: "live" })).toBe("live");
    // The server kept only part of the board for this connection.
    expect(status({ A: "live", B: "live" })).toBe("mixed");
    // A delayed stream ticks too, but it is not real-time.
    expect(status({ A: "delayed", B: "delayed", C: "delayed" })).toBe("polling");
  });
});
