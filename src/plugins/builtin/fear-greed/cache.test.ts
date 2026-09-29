import { afterEach, describe, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import type { FearGreedData } from "./data";
import {
  attachFearGreedPersistence,
  loadFearGreed,
  resetFearGreedPersistence,
} from "./cache";

function makeFearGreedData(score: number): FearGreedData {
  const date = new Date("2026-05-24T12:00:00.000Z");
  return {
    overall: {
      score,
      rating: "greed",
      updatedAt: date,
      previousClose: 60,
      previousWeek: 58,
      previousMonth: 55,
      previousYear: 45,
      history: [
        { date, open: score, high: score, low: score, close: score, volume: 0 },
      ],
    },
    indicators: [
      {
        definition: {
          id: "market-momentum",
          title: "Market Momentum",
          subtitle: "S&P 500 and its 125-day moving average",
          primaryKey: "market_momentum_sp500",
          primaryLabel: "S&P 500",
          valueFormat: "number",
        },
        score,
        rating: "greed",
        updatedAt: date,
        points: [
          { date, open: score, high: score, low: score, close: score, volume: 0 },
        ],
        secondaryPoints: [],
        latestValue: score,
        latestSecondaryValue: null,
      },
    ],
  };
}

afterEach(() => {
  resetFearGreedPersistence();
});

describe("fear-greed cache", () => {
  test("rehydrates persisted data without refetching", async () => {
    const persistence = new MemoryPluginPersistence();
    attachFearGreedPersistence(persistence);

    const original = makeFearGreedData(64);
    await loadFearGreed(false, async () => original);

    resetFearGreedPersistence();
    attachFearGreedPersistence(persistence);

    let calls = 0;
    const cached = await loadFearGreed(false, async () => {
      calls += 1;
      return makeFearGreedData(12);
    });

    expect(calls).toBe(0);
    expect(cached.stale).toBe(false);
    expect(cached.data.overall.score).toBe(64);
    expect(cached.data.overall.updatedAt).toBeInstanceOf(Date);
    expect(cached.data.overall.history[0]!.date).toBeInstanceOf(Date);
  });

  test("reports a failed refresh as stale instead of a fresh load", async () => {
    const persistence = new MemoryPluginPersistence();
    attachFearGreedPersistence(persistence);
    await loadFearGreed(false, async () => makeFearGreedData(64));

    const result = await loadFearGreed(true, async () => {
      throw new Error("CNN unreachable");
    });

    expect(result.data.overall.score).toBe(64);
    expect(result.stale).toBe(true);
    expect(result.refreshError).toContain("CNN unreachable");
  });
});
