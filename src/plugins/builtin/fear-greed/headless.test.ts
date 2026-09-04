import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createFearGreedHeadless } from "./headless";
import type { FearGreedData } from "./data";

const args: HeadlessPaneLoadArgs = { rawArgument: "", argument: null, symbols: [], options: {} };

const data: FearGreedData = {
  overall: {
    score: 63,
    rating: "greed",
    updatedAt: new Date("2026-09-04T12:00:00Z"),
    previousClose: 58,
    previousWeek: 41,
    previousMonth: 35,
    previousYear: 52,
    history: [],
  },
  indicators: [{
    definition: {
      id: "market-volatility",
      title: "Market Volatility",
      subtitle: "VIX and its 50-day moving average",
      primaryKey: "market_volatility_vix",
      primaryLabel: "VIX",
      secondaryKey: "market_volatility_vix_50",
      secondaryLabel: "50-day moving average",
      valueFormat: "number",
    },
    score: 72,
    rating: "greed",
    updatedAt: new Date("2026-09-04T12:00:00Z"),
    points: [],
    secondaryPoints: [],
    latestValue: 14.25,
    latestSecondaryValue: 17.5,
  }],
};

describe("fear and greed headless model", () => {
  test("maps the loaded index and indicators into shared sections", async () => {
    const headless = createFearGreedHeadless({
      load: async () => ({ data, fetchedAt: 123, stale: false }),
    });
    const result = await headless.load(args, {} as HeadlessPaneContext);

    expect(result.sections[0]?.title).toBe("Fear & Greed Index");
    expect(result.sections[0]?.entries?.[0]).toMatchObject({ label: "Score", value: 63 });
    expect(result.sections[1]?.rows?.[0]).toMatchObject({
      id: "market-volatility", latestValue: 14.25, secondaryValue: 17.5,
    });
  });
});
