import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "../../../types/config";
import type { Quote, TickerFinancials } from "../../../types/financials";
import type { BrokerAccount } from "../../../types/trading";
import type { TickerRecord } from "../../../types/ticker";
import type { PortfolioSummaryTotals } from "./metrics";
import {
  buildPortfolioFooterSegments,
  buildPortfolioSummarySegments,
  fitSummarySegments,
  layoutPortfolioSummaryHeader,
} from "./summary";
import { shouldToggleCashMarginDrawer } from ".";
import { needsVisibleQuoteWatchdogRefresh, selectQuoteWarmupTickers, selectStreamTickers } from "./pane/data";
import { buildPortfolioPaneSettingsDef, getPortfolioPaneSettings } from "./settings";
import { getLanguage, setLanguage } from "../../../i18n";

function ticker(symbol: string): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      name: symbol,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    },
  };
}

describe("buildPortfolioSummarySegments", () => {
  const totals: PortfolioSummaryTotals = {
    totalMktValue: 125000,
    dailyPnl: 5000,
    dailyPnlPct: 4.17,
    totalCostBasis: 100000,
    hasPositions: true,
    unrealizedPnl: 25000,
    unrealizedPnlPct: 25,
    avgWatchlistChange: 0,
    watchlistCount: 0,
  };

  const account: BrokerAccount = {
    accountId: "DU12345",
    name: "DU12345",
    netLiquidation: 125000,
    grossPositionValue: 175000,
    totalCashValue: -50000,
    settledCash: -45000,
    availableFunds: 12000,
    excessLiquidity: 10000,
    buyingPower: 24000,
  };

  test("prioritizes net liquidation at narrow widths for broker portfolios", () => {
    const segments = fitSummarySegments(buildPortfolioSummarySegments({
      totals,
      accountState: { account, sourceLabel: "Live" },
    }), 24);

    expect(segments.map((segment) => segment.id)).toEqual(["netliq", "val"]);
  });

  test("fits segments using translated terminal display widths", () => {
    const previousLanguage = getLanguage();
    try {
      setLanguage("zh-CN");
      const segments = fitSummarySegments(buildPortfolioSummarySegments({
        totals,
        accountState: { account, sourceLabel: "Live" },
      }), 22);

      expect(segments.map((segment) => segment.id)).toEqual(["netliq"]);
    } finally {
      setLanguage(previousLanguage);
    }
  });

  test("uses broker gross position value for broker portfolio value", () => {
    const segments = buildPortfolioSummarySegments({
      totals,
      accountState: { account, sourceLabel: "Live" },
    });

    expect(segments.find((segment) => segment.id === "val")?.parts[1]?.text).toBe("175k");
  });

  test("drops low-priority broker segments before required ones", () => {
    const segments = fitSummarySegments(buildPortfolioSummarySegments({
      totals,
      accountState: { account, sourceLabel: "Live" },
    }), 100);

    expect(segments.map((segment) => segment.id)).toEqual([
      "netliq",
      "val",
      "cash",
      "day",
      "pnl",
      "settled",
      "avail",
    ]);
  });

  test("the open cash drawer continues where the header row ran out of room", () => {
    const segments = buildPortfolioSummarySegments({ totals, accountState: { account, sourceLabel: "Live" } });
    const layout = layoutPortfolioSummaryHeader(segments, 50, { cashDrawer: true, hideHeader: false });
    const ids = (list: typeof segments) => list.map((segment) => segment.id);

    expect(ids(layout.row)).toEqual(["netliq", "val", "cash"]);
    expect(ids(layout.detail)).toEqual(["day", "pnl"]);
    expect(ids(layoutPortfolioSummaryHeader(segments, 50, { cashDrawer: true, hideHeader: true }).detail))
      .toEqual(["netliq", "val", "cash"]);
  });

  test("keeps an account failure in the footer when the portfolio has nothing to total", () => {
    const segments = buildPortfolioFooterSegments({
      totals: { ...totals, hasPositions: false },
      accountState: null,
      accountStatusText: "Acct missing",
      financialsMap: new Map(),
      isPortfolioTab: true,
      refreshingSize: 0,
      sortedTickers: [],
    });

    expect(segments.map((segment) => segment.parts[0]?.text)).toEqual(["Acct missing", "-"]);
  });

  test("treats only a bare c as the cash drawer shortcut", () => {
    expect(shouldToggleCashMarginDrawer({ name: "c" }, true)).toBe(true);
    expect(shouldToggleCashMarginDrawer({ name: "c" }, false)).toBe(false);
    expect(shouldToggleCashMarginDrawer({ name: "j" }, true)).toBe(false);
    // Cmd+Shift+C copies a pane screenshot.
    expect(shouldToggleCashMarginDrawer({ name: "c", meta: true, shift: true }, true)).toBe(false);
    expect(shouldToggleCashMarginDrawer({ name: "c", super: true, shift: true }, true)).toBe(false);
  });
});

describe("selectStreamTickers", () => {
  test("includes visible rows with overscan and clamps boundaries", () => {
    const tickers = Array.from({ length: 20 }, (_, index) => ticker(`T${index}`));
    expect(selectStreamTickers(tickers, { start: 3, end: 7 }).map((entry) => entry.metadata.ticker)).toEqual(
      tickers.slice(0, 13).map((entry) => entry.metadata.ticker),
    );
    expect(selectStreamTickers(tickers, { start: 18, end: 20 }).map((entry) => entry.metadata.ticker)).toEqual(
      tickers.slice(12, 20).map((entry) => entry.metadata.ticker),
    );
  });

  test("includes selected ticker outside the visible streaming window", () => {
    const tickers = Array.from({ length: 20 }, (_, index) => ticker(`T${index}`));
    expect(selectStreamTickers(tickers, { start: 3, end: 7 }, "T19").map((entry) => entry.metadata.ticker)).toContain("T19");
  });
});

describe("selectQuoteWarmupTickers", () => {
  function financials(quoteValue: Quote | undefined): TickerFinancials {
    return {
      annualStatements: [],
      quarterlyStatements: [],
      priceHistory: [],
      quote: quoteValue,
    };
  }

  test("includes hidden quote-missing rows when sorting by quote-dependent columns", () => {
    const tickers = Array.from({ length: 30 }, (_, index) => ticker(`T${index}`));
    const financialsMap = new Map<string, TickerFinancials>(
      tickers.slice(0, 29).map((entry, index) => [
        entry.metadata.ticker,
        financials({
          symbol: entry.metadata.ticker,
          price: index + 1,
          currency: "USD",
          change: index,
          changePercent: index,
          lastUpdated: 1_700_000_000_000,
        }),
      ]),
    );

    const selected = selectQuoteWarmupTickers(
      tickers,
      { start: 0, end: 24 },
      financialsMap,
      { columnId: "change_pct", direction: "asc" },
      1_700_000_010_000,
    ).map((entry) => entry.metadata.ticker);

    expect(selected).toContain("T29");
  });

  test("does not add hidden rows for ticker-only sorting", () => {
    const tickers = Array.from({ length: 30 }, (_, index) => ticker(`T${index}`));
    expect(selectQuoteWarmupTickers(
      tickers,
      { start: 0, end: 24 },
      new Map(),
      { columnId: "ticker", direction: "asc" },
    ).map((entry) => entry.metadata.ticker)).toEqual(
      tickers.slice(0, 24).map((entry) => entry.metadata.ticker),
    );
  });
});

describe("visible quote refresh predicates", () => {
  function quote(overrides: Partial<Quote> = {}): Quote {
    return {
      symbol: "AAPL",
      price: 125,
      currency: "USD",
      change: 5,
      changePercent: 4.17,
      lastUpdated: 1_700_000_000_000,
      ...overrides,
    };
  }

  function financials(quoteValue: Quote | undefined): TickerFinancials {
    return {
      annualStatements: [],
      quarterlyStatements: [],
      priceHistory: [],
      quote: quoteValue,
    };
  }

  test("refreshes visible quotes when the local stream timestamp is too old", () => {
    const now = 1_700_000_120_000;
    expect(needsVisibleQuoteWatchdogRefresh(
      financials(quote({ lastUpdated: now, receivedAt: now - 61_000 })),
      now,
      60_000,
    )).toBe(true);
    expect(needsVisibleQuoteWatchdogRefresh(
      financials(quote({ lastUpdated: now, receivedAt: now - 10_000 })),
      now,
      60_000,
    )).toBe(false);
  });
});

describe("portfolio list pane settings", () => {
  test("exposes view mode only for portfolio collections", () => {
    const config = createDefaultConfig("/tmp/gloomberb-portfolio-list-settings");
    const settings = getPortfolioPaneSettings({ viewMode: "grid" });
    const portfolioFields = buildPortfolioPaneSettingsDef(config, settings, "main").fields.map((field) => field.key);
    const watchlistFields = buildPortfolioPaneSettingsDef(config, settings, "watchlist").fields.map((field) => field.key);

    expect(portfolioFields).toContain("viewMode");
    expect(watchlistFields).not.toContain("viewMode");
  });
});
