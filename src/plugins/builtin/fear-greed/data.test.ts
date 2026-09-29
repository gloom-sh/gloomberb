import { describe, expect, test } from "bun:test";
import { normalizeFearGreedData, type CnnFearGreedGraphData } from "./data";

describe("fear-greed data normalization", () => {
  test("combines latest score with chart history and aligned overlay series", () => {
    const charts: CnnFearGreedGraphData = {
      fear_and_greed: {
        score: 65,
        rating: "greed",
        timestamp: "2026-05-08T23:59:55+00:00",
      },
      fear_and_greed_historical: {
        score: 65,
        rating: "greed",
        data: [
          { x: 2000, y: 62, rating: "greed" },
          { x: 1000, y: 58, rating: "greed" },
        ],
      },
      market_momentum_sp500: {
        score: 99.6,
        rating: "extreme greed",
        timestamp: 2000,
        data: [
          { x: 1000, y: 100 },
          { x: 2000, y: 110 },
        ],
      },
      market_momentum_sp125: {
        timestamp: 2000,
        data: [
          { x: 1000, y: 92 },
          { x: 2000, y: 96 },
        ],
      },
      stock_price_strength: {
        score: 61.4,
        rating: "greed",
        data: [{ x: 1000, y: 3.8 }],
      },
    };
    const latest: CnnFearGreedGraphData = {
      fear_and_greed: {
        score: 70.4,
        rating: "greed",
        timestamp: "2026-05-09T12:00:00+00:00",
        previous_close: 67.5,
        previous_1_week: 71.1,
        previous_1_month: 29.1,
        previous_1_year: 57.6,
      },
    };

    const data = normalizeFearGreedData(charts, latest);

    expect(data.overall.score).toBe(70.4);
    expect(data.overall.previousClose).toBe(67.5);
    expect(data.overall.history.map((point) => point.close)).toEqual([58, 62]);

    const momentum = data.indicators.find((indicator) => indicator.definition.id === "market-momentum");
    expect(momentum?.rating).toBe("extreme greed");
    expect(momentum?.points.map((point) => point.close)).toEqual([100, 110]);
    expect(momentum?.secondaryPoints).toEqual([
      { index: 0, value: 92 },
      { index: 1, value: 96 },
    ]);
  });

  test("rejects responses without an index score", () => {
    expect(() => normalizeFearGreedData({})).toThrow("index score");
  });
});
