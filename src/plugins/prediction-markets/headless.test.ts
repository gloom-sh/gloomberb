import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../types/plugin";
import {
  createPredictionMarketsHeadless,
  type PredictionMarketsHeadlessDependencies,
} from "./headless";
import type { PredictionMarketSummary, PredictionVenue } from "./types";

function market(
  key: string,
  venue: PredictionVenue,
  title: string,
  volume24h: number,
  endsAt: string,
): PredictionMarketSummary {
  return {
    key,
    venue,
    marketId: `${key}-id`,
    title,
    marketLabel: "Yes",
    eventLabel: title,
    category: title.includes("Fed") ? "Economics" : "Politics",
    tags: [],
    status: "open",
    url: `https://example.com/${key}`,
    description: `${title} market`,
    endsAt,
    updatedAt: "2026-09-04T20:00:00.000Z",
    yesPrice: 0.62,
    noPrice: 0.38,
    yesBid: 0.61,
    yesAsk: 0.63,
    noBid: 0.37,
    noAsk: 0.39,
    spread: 0.02,
    lastTradePrice: 0.62,
    volume24h,
    volume24hUnit: "usd",
    totalVolume: volume24h * 10,
    totalVolumeUnit: "usd",
    openInterest: volume24h / 2,
    openInterestUnit: venue === "kalshi" ? "contracts" : "usd",
    liquidity: volume24h / 4,
    liquidityUnit: "usd",
  };
}

const markets = [
  market("poly-fed", "polymarket", "Will the Fed cut rates?", 2_000_000, "2026-10-01T00:00:00.000Z"),
  market("kalshi-election", "kalshi", "Will the incumbent win?", 500_000, "2026-11-01T00:00:00.000Z"),
];

function args(
  argument: string | null,
  options: Record<string, string | number | boolean>,
): HeadlessPaneLoadArgs {
  return {
    rawArgument: argument ?? "",
    argument,
    symbols: [],
    options,
  };
}

const context = {} as HeadlessPaneContext;

function dependencies(seen: string[]): PredictionMarketsHeadlessDependencies {
  return {
    loadPolymarket: async (query) => {
      seen.push(`polymarket:${query}`);
      return markets.filter((entry) => entry.venue === "polymarket");
    },
    loadKalshi: async (query) => {
      seen.push(`kalshi:${query}`);
      return markets.filter((entry) => entry.venue === "kalshi");
    },
    now: () => new Date("2026-09-04T21:00:00.000Z"),
  };
}

describe("prediction markets headless", () => {
  test("projects venue data through the pane's shared row ordering", async () => {
    const definition = createPredictionMarketsHeadless(dependencies([]));

    const result = await definition.load(args(null, {
      venue: "all",
      category: "all",
      tab: "top",
      limit: 1,
    }), context);

    expect(result.rows).toEqual([
      expect.objectContaining({
        key: "poly-fed",
        venue: "polymarket",
        yesProbability: 0.62,
        volume24h: 2_000_000,
      }),
    ]);
    expect(result.metadata).toMatchObject({ total: 2, returned: 1, truncated: true });
  });

  test("uses the shortcut venue prefix without querying the other venue", async () => {
    const seen: string[] = [];
    const definition = createPredictionMarketsHeadless(dependencies(seen));

    const result = await definition.load(args("polymarket:fed", {
      venue: "all",
      category: "macro",
      tab: "ending",
      limit: 20,
    }), context);

    expect(seen).toEqual(["polymarket:fed"]);
    expect(result.rows.map((row) => row.key)).toEqual(["poly-fed"]);
    expect(result.metadata).toMatchObject({ venue: "polymarket", query: "fed" });
  });
});
