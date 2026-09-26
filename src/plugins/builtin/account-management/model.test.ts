import { describe, expect, test } from "bun:test";
import type { Portfolio, TickerRecord } from "../../../types/ticker";
import {
  buildPublishedProfileAnalyticsPreview,
  buildPortfolioChoices,
  buildProfileAnalyticsPreview,
  computeCumulativeReturn,
  countPortfolioHoldings,
  getPortfolioPositionTickers,
  NO_PORTFOLIO_VALUE,
} from "./model";

function makeTicker(symbol: string, portfolios: string[], positionedPortfolios: string[] = []): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "XNAS",
      currency: "USD",
      name: symbol,
      portfolios,
      watchlists: [],
      positions: positionedPortfolios.map((portfolio) => ({
        portfolio,
        shares: 10,
        avgCost: 90,
        currency: "USD",
        broker: "manual",
      })),
      custom: {},
      tags: [],
    },
  };
}

describe("account management model", () => {
  test("counts portfolio holdings from app ticker state", () => {
    const tickers = new Map([
      ["AAPL", makeTicker("AAPL", ["main"])],
      ["MSFT", makeTicker("MSFT", ["main", "income"])],
      ["SPY", makeTicker("SPY", [])],
    ]);

    expect(countPortfolioHoldings(tickers)).toEqual({ main: 2, income: 1 });
  });

  test("describes public portfolio analytics in the shared portfolio picker", () => {
    const portfolios: Portfolio[] = [
      { id: "main", name: "Main Portfolio", currency: "USD" },
    ];

    const choices = buildPortfolioChoices(portfolios, { main: 2 });

    expect(choices).toEqual([
      {
        id: NO_PORTFOLIO_VALUE,
        label: "None",
        detail: "Off",
        description: "Do not show portfolio analytics on your public profile.",
      },
      {
        id: "main",
        label: "Main Portfolio",
        detail: "2 tickers",
        description: "Shares this portfolio's 1Y return and SPY Beta on your public profile.",
      },
    ]);
  });

  test("filters shared analytics tickers by actual portfolio positions", () => {
    const tickers = new Map([
      ["AAPL", makeTicker("AAPL", ["main"], ["main"])],
      ["MSFT", makeTicker("MSFT", ["main"], [])],
      ["NVDA", makeTicker("NVDA", ["other"], ["other"])],
    ]);

    expect(getPortfolioPositionTickers(tickers, "main").map((ticker) => ticker.metadata.ticker)).toEqual(["AAPL"]);
  });

  test("compounds the selected one-year return series", () => {
    expect(computeCumulativeReturn([
      { dateKey: "2025-06-01", value: 0.1 },
      { dateKey: "2025-06-02", value: 0.05 },
      { dateKey: "2025-06-03", value: -0.02 },
    ])).toBeCloseTo(0.1319, 5);
  });

  test("builds a real public analytics preview snapshot", () => {
    const portfolio: Portfolio = { id: "main", name: "Main Portfolio", currency: "USD" };
    const ticker = makeTicker("AAPL", ["main"], ["main"]);
    const preview = buildProfileAnalyticsPreview({
      beta: 1.1,
      portfolio,
      portfolioTickers: [ticker],
      selectedPortfolioId: "main",
      oneYearReturn: 0.1,
    });

    expect(preview.status).toBe("ready");
    expect(preview.subtitle).toBe("");
    expect(preview.metrics).toHaveLength(2);
    expect(preview.metrics[0]).toMatchObject({ label: "1Y est.", value: "+10.00%", tone: "positive" });
    expect(preview.metrics[1]).toMatchObject({ label: "SPY Beta", value: "1.10" });
    expect(preview.publicAnalytics).toEqual({
      oneYearReturn: 0.1,
      spyBeta: 1.1,
      basis: "holdings",
    });
  });

  test("builds the visible profile analytics card from published account data", () => {
    const portfolio: Portfolio = { id: "main", name: "Main Portfolio", currency: "USD" };
    const preview = buildPublishedProfileAnalyticsPreview({
      analytics: { oneYearReturn: 0.15, spyBeta: 1.25 },
      draftProfilePublic: true,
      portfolio,
      profileLoaded: true,
      savedProfilePublic: true,
      savedSharedPortfolioId: "main",
      selectedPortfolioId: "main",
      syncing: false,
    });

    expect(preview.status).toBe("ready");
    expect(preview.title).toBe("Main Portfolio");
    expect(preview.metrics).toEqual([
      { id: "one-year", label: "1Y", value: "+15.00%", tone: "positive" },
      { id: "beta", label: "SPY Beta", value: "1.25" },
    ]);
    expect(preview.publicAnalytics).toEqual({ oneYearReturn: 0.15, spyBeta: 1.25, basis: null });
  });

  test("does not show stale published analytics when the selected profile portfolio is unsaved", () => {
    const portfolio: Portfolio = { id: "new", name: "New Portfolio", currency: "USD" };
    const preview = buildPublishedProfileAnalyticsPreview({
      analytics: { oneYearReturn: 0.15, spyBeta: 1.25 },
      draftProfilePublic: true,
      portfolio,
      profileLoaded: true,
      savedProfilePublic: true,
      savedSharedPortfolioId: "old",
      selectedPortfolioId: "new",
      syncing: false,
    });

    expect(preview.status).toBe("pending");
    expect(preview.metrics).toEqual([]);
    expect(preview.subtitle).toBe("Save profile to update published metrics.");
    expect(preview.publicAnalytics).toBeNull();
  });
});
