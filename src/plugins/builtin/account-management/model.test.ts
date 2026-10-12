import { describe, expect, test } from "bun:test";
import type { Portfolio, TickerRecord } from "../../../types/ticker";
import {
  buildPublishedProfileAnalyticsPreview,
  buildPortfolioChoices,
  buildProfileAnalyticsPreview,
  chatCardUpdate,
  countPortfolioHoldings,
  NO_PORTFOLIO_VALUE,
  profileToDraft,
} from "./model";
import { makeAccountProfile } from "../chat/test-harness";
import { createTestTicker } from "../../../test-support/ticker";

function makeTicker(symbol: string, portfolios: string[], positionedPortfolios: string[] = []): TickerRecord {
  return createTestTicker(symbol, symbol, {
    exchange: "XNAS",
    portfolios,
    positions: positionedPortfolios.map((portfolio) => ({
      portfolio,
      shares: 10,
      avgCost: 90,
      currency: "USD",
      broker: "manual",
    })),
  });
}

describe("account management model", () => {
  test("what you trade stays off until you turn it on, pre-filled from your first-run answer, and local time stays on", () => {
    const fresh = makeAccountProfile({ showLocalTime: true, chatDesks: [], onboardingDesks: ["options", "futures"] });
    const draft = profileToDraft(fresh);
    expect(draft).toMatchObject({ showLocalTime: true, showDesks: false, desks: ["options", "futures"] });
    // Saving the profile as it is shows no desks.
    expect(chatCardUpdate(fresh, draft)).toEqual({ showLocalTime: true, chatDesks: null });
    expect(chatCardUpdate(fresh, { ...draft, showDesks: true })).toEqual({ showLocalTime: true, chatDesks: ["options", "futures"] });
    // On with nothing picked shows nothing either.
    expect(chatCardUpdate(fresh, { ...draft, showDesks: true, desks: [] })).toEqual({ showLocalTime: true, chatDesks: null });
    expect(chatCardUpdate(fresh, { ...draft, showLocalTime: false })).toMatchObject({ showLocalTime: false });

    const shown = profileToDraft(makeAccountProfile({ showLocalTime: false, chatDesks: ["fx"], onboardingDesks: ["options"] }));
    expect(shown).toMatchObject({ showLocalTime: false, showDesks: true, desks: ["fx"] });

    // A server that predates the settings is sent none of them.
    const older = makeAccountProfile();
    expect(chatCardUpdate(older, profileToDraft(older))).toEqual({});
  });

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
