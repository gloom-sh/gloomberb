import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import {
  getOnboardingProgress,
  listOnboardingPositions,
  pickLargestBrokerPosition,
  pickLargestPosition,
} from "./wizard-model";

function ticker(symbol: string, shares: number | null, avgCost = 100): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      name: `${symbol} Inc.`,
      currency: "USD",
      portfolios: ["main"],
      watchlists: [],
      positions: shares === null ? [] : [{ portfolio: "main", shares, avgCost, currency: "USD", broker: "manual" }],
    },
  } as unknown as TickerRecord;
}

describe("onboarding positions", () => {
  test("values rows from the last quote and falls back to cost basis", () => {
    const rows = listOnboardingPositions(
      [ticker("AAPL", 10, 180), ticker("MSFT", 4, 400), ticker("NVDA", null)],
      "main",
      (symbol) => (symbol === "AAPL" ? { price: 300 } as never : null),
    );
    expect(rows.map((row) => [row.symbol, row.value])).toEqual([
      ["AAPL", 3000],
      ["MSFT", 1600],
      ["NVDA", null],
    ]);
  });

  test("opens the largest holding, and the first row when nothing is priced", () => {
    const rows = listOnboardingPositions(
      [ticker("AAPL", 10, 180), ticker("MSFT", 4, 400), ticker("NVDA", null)],
      "main",
      () => null,
    );
    expect(pickLargestPosition(rows)?.symbol).toBe("AAPL");
    expect(pickLargestPosition(rows.filter((row) => row.shares === null))?.symbol).toBe("NVDA");
    expect(pickLargestPosition([])).toBeNull();
  });

  test("ranks broker imports by cost basis and ignores rows without a symbol", () => {
    expect(pickLargestBrokerPosition([
      { ticker: "", exchange: "NASDAQ", shares: 500, avgCost: 500, currency: "USD" },
      { ticker: "AAPL", exchange: "NASDAQ", shares: 7, avgCost: 180, currency: "USD" },
      { ticker: "MSFT", exchange: "NASDAQ", shares: 4, avgCost: 400, currency: "USD" },
    ])?.ticker).toBe("MSFT");
  });

  test("maps retired stages onto the surviving steps", () => {
    const config = createDefaultConfig("/tmp/onboarding");
    for (const [saved, expected] of [["welcome", "portfolio"], ["add-ticker", "portfolio"], ["verify", "upgrade"], ["ready", "ready"]] as const) {
      expect(getOnboardingProgress({
        ...config,
        onboardingProgress: { version: 1, stage: saved, accountStatus: "signed-in" },
      })).toMatchObject({ stage: expected, accountStatus: "signed-in" });
    }
    expect(getOnboardingProgress(config).stage).toBe("portfolio");
  });
});
