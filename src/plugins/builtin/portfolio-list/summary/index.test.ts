import { describe, expect, test } from "bun:test";
import { getLanguage, setLanguage } from "../../../../i18n";
import { useRegularMarketSession } from "../../../../test-support/market-session";
import {
  MARGIN_EXCHANGE_RATES,
  MARGIN_PORTFOLIO,
  MARGIN_TICKERS,
  createMarginAccount,
  marginQuotes,
} from "../../../../test-support/margin-account";
import type { BrokerAccount } from "../../../../types/trading";
import { calculatePortfolioSummaryTotals, type PortfolioSummaryTotals } from "../metrics";
import {
  buildPortfolioFooterSegments,
  buildPortfolioSummarySegments,
  fitSummarySegments,
  layoutPortfolioSummaryHeader,
  resolvePortfolioAccountState,
} from "./index";
import { formatPortfolioAmount } from "./totals";

describe("resolvePortfolioAccountState", () => {
  test("does not reuse a single cached broker account for a different explicit portfolio account", () => {
    const accountState = resolvePortfolioAccountState({
      id: "broker:ibkr-flex:U12345",
      name: "U12345",
      currency: "USD",
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-flex",
      brokerAccountId: "U12345",
    }, {
      config: {
        brokerInstances: [{
          id: "ibkr-flex",
          label: "IBKR Flex",
          brokerType: "ibkr",
          enabled: true,
          config: {},
        }],
      } as any,
      brokerAccounts: {
        "ibkr-flex": [{
          accountId: "alias-account",
          name: "alias-account",
          currency: "USD",
          source: "flex",
          updatedAt: new Date("2026-05-15T05:02:17.000Z").getTime(),
        }],
      },
    }, {
      status: null,
      accounts: [],
    });

    expect(accountState).toBeNull();
  });

  test("still uses the only cached broker account for legacy broker portfolios without an account id", () => {
    const accountState = resolvePortfolioAccountState({
      id: "broker:ibkr-flex:default",
      name: "IBKR Flex",
      currency: "USD",
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-flex",
    }, {
      config: {
        brokerInstances: [{
          id: "ibkr-flex",
          label: "IBKR Flex",
          brokerType: "ibkr",
          enabled: true,
          config: {},
        }],
      } as any,
      brokerAccounts: {
        "ibkr-gateway": [{
          accountId: "U12345",
          name: "U12345",
          currency: "USD",
          source: "gateway",
          updatedAt: new Date("2026-05-14T05:02:17.000Z").getTime(),
          netLiquidation: 100000,
        }],
        "ibkr-flex": [{
          accountId: "U12345",
          name: "U12345",
          currency: "USD",
          source: "flex",
        }],
      },
    }, {
      status: null,
      accounts: [],
    });

    expect(accountState?.account.accountId).toBe("U12345");
  });

  test("uses exact cached account data from another profile for the same broker account", () => {
    const accountState = resolvePortfolioAccountState({
      id: "broker:ibkr-gateway:U12345",
      name: "U12345",
      currency: "USD",
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-gateway",
      brokerAccountId: "U12345",
    }, {
      config: {
        brokerInstances: [
          {
            id: "ibkr-gateway",
            label: "IBKR Gateway",
            brokerType: "ibkr",
            enabled: true,
            config: {},
          },
          {
            id: "ibkr-flex",
            label: "IBKR Flex",
            brokerType: "ibkr",
            enabled: true,
            config: {},
          },
        ],
      } as any,
      brokerAccounts: {
        "ibkr-flex": [{
          accountId: "U12345",
          name: "U12345",
          currency: "USD",
          source: "flex",
          updatedAt: new Date("2026-05-15T05:02:17.000Z").getTime(),
          asOfDate: "2026-05-14",
          netLiquidation: 123456,
        }],
      },
    }, {
      status: null,
      accounts: [],
    });

    expect(accountState?.account.netLiquidation).toBe(123456);
    expect(accountState?.sourceLabel).toBe("Flex May 14");
  });

  test("uses the account as-of date when choosing the freshest cached Flex account", () => {
    const accountState = resolvePortfolioAccountState({
      id: "broker:ibkr-old:U12345",
      name: "U12345",
      currency: "USD",
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-old",
      brokerAccountId: "U12345",
    }, {
      config: {
        brokerInstances: [
          {
            id: "ibkr-old",
            label: "IBKR Old",
            brokerType: "ibkr",
            enabled: true,
            config: {},
          },
          {
            id: "ibkr-new",
            label: "IBKR New",
            brokerType: "ibkr",
            enabled: true,
            config: {},
          },
        ],
      } as any,
      brokerAccounts: {
        "ibkr-old": [{
          accountId: "U12345",
          name: "U12345",
          currency: "USD",
          source: "flex",
          updatedAt: new Date("2026-06-16T10:00:00.000Z").getTime(),
          asOfDate: "2026-06-15",
          netLiquidation: 100000,
        }],
        "ibkr-new": [{
          accountId: "U12345",
          name: "U12345",
          currency: "USD",
          source: "flex",
          updatedAt: new Date("2026-06-15T10:00:00.000Z").getTime(),
          asOfDate: "2026-06-16",
          netLiquidation: 200000,
        }],
      },
    }, {
      status: null,
      accounts: [],
    });

    expect(accountState?.account.netLiquidation).toBe(200000);
    expect(accountState?.sourceLabel).toBe("Flex Jun 16");
  });

});

test("a book's totals read to the unit, never rounded to a hundred, and compact only from a billion", () => {
  // $1,587.80 read Val 1.6k beside a Day of -101.10.
  expect(formatPortfolioAmount(1587.8, "USD")).toBe("1,588");
  expect(formatPortfolioAmount(-101.1, "USD", { signed: true })).toBe("-101.10");
  expect(formatPortfolioAmount(999.996, "USD")).toBe("1,000");
  expect(formatPortfolioAmount(-4_198_000, "USD", { signed: true })).toBe("-4,198,000");
  expect(formatPortfolioAmount(1_234_000_000, "USD")).toBe("1.23B");
  expect(formatPortfolioAmount(0.001, "USD", { signed: true })).toBe("0.00");
  // A currency without a minor unit keeps none; another than the app's leads with its symbol.
  expect(formatPortfolioAmount(950, "JPY", { baseCurrency: "JPY" })).toBe("¥950");
  expect(formatPortfolioAmount(60_000, "AUD", { signed: true })).toBe("+A$60,000");
  expect(formatPortfolioAmount(Number.NaN, "USD")).toBe("—");
});

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

  // A CAD book of NBIS and cash read TOTAL +4.49% with nothing to say it was on the holdings' cost, cash left out.
  test("beside cash entered by hand, the day and P&L percents say what they are of", () => {
    const segments = buildPortfolioSummarySegments({
      totals, accountState: null, currency: "CAD", baseCurrency: "CAD",
      manualCash: { value: 50_000, weight: 28.6, targetWeight: null, drift: null, tradeValue: null, tradeUnits: null, total: 175_000 },
    });
    const percent = (id: string) => segments.find((segment) => segment.id === id)?.parts[2]?.text;
    expect([percent("day"), percent("pnl")]).toEqual(["(+4.17% ex cash)", "(+25.00% on cost)"]);
    // Without cash the holdings are the book: as it was.
    expect(buildPortfolioSummarySegments({ totals, accountState: null }).find((segment) => segment.id === "pnl")?.parts[2]?.text).toBe("(+25.00%)");
  });

  test("prioritizes net liquidation at narrow widths for broker portfolios", () => {
    const segments = fitSummarySegments(buildPortfolioSummarySegments({
      totals,
      accountState: { account, sourceLabel: "Live" },
    }), 30);

    expect(segments.map((segment) => segment.id)).toEqual(["netliq", "val"]);
  });

  test("Val leaves what it is priced at to a Day that names its after-hours print, and keeps it when the Day has no room", () => {
    const atPrint: PortfolioSummaryTotals = { ...totals, totalMktValue: 1587.8, dailyPnl: -101.1, dailyPnlPct: -5.99,
      totalCostBasis: 1500, unrealizedPnl: 87.8, unrealizedPnlPct: 5.85, dayChangeBasis: "AH vs Tue 10 Nov close", dayAtExtendedPrint: true };
    const fit = (width: number, value = atPrint) => fitSummarySegments(buildPortfolioSummarySegments({
      totals: value, accountState: null, valuationBasis: "latest-print",
    }), width).map((segment) => segment.parts.map((part) => part.text).join(" "));
    expect(fit(120)).toEqual(["Val 1,588", "Day -101.10 (-5.99%) AH vs Tue 10 Nov close", "P&L +87.80 (+5.85%)"]);
    expect(fit(30)).toEqual(["Val 1,588 (latest print)"]);
    // A day at regular-session prices names no print, so Val says it.
    expect(fit(120, { ...atPrint, dayChangeBasis: "vs Tue 10 Nov close", dayAtExtendedPrint: undefined })[0]).toBe("Val 1,588 (latest print)");
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

    expect(segments.find((segment) => segment.id === "val")?.parts[1]?.text).toBe("175,000");
  });

  test("drops low-priority broker segments before required ones", () => {
    const segments = fitSummarySegments(buildPortfolioSummarySegments({
      totals,
      accountState: { account, sourceLabel: "Live" },
    }), 118);

    expect(segments.map((segment) => segment.id)).toEqual([
      "netliq",
      "val",
      "cash",
      "day",
      "pnl",
      "lev",
      "settled",
    ]);
  });

  test("the open cash drawer continues where the header row ran out of room", () => {
    const segments = buildPortfolioSummarySegments({ totals, accountState: { account, sourceLabel: "Live" } });
    const layout = layoutPortfolioSummaryHeader(segments, 56, { cashDrawer: true, hideHeader: false });
    const ids = (list: typeof segments) => list.map((segment) => segment.id);

    expect(ids(layout.row)).toEqual(["netliq", "val", "cash"]);
    expect(ids(layout.detail)).toEqual(["day", "pnl", "lev"]);
    expect(ids(layoutPortfolioSummaryHeader(segments, 56, { cashDrawer: true, hideHeader: true }).detail))
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
});

describe("a margin account's header", () => {
  useRegularMarketSession();

  const header = (quotes: ReturnType<typeof marginQuotes>, account: BrokerAccount | null) => {
    const totals = calculatePortfolioSummaryTotals(MARGIN_TICKERS, quotes, "USD", MARGIN_EXCHANGE_RATES, true, MARGIN_PORTFOLIO.id);
    const segments = buildPortfolioSummarySegments({
      totals,
      accountState: account ? { account, sourceLabel: "Synced", snapshotBasis: "marks" } : null,
      brokerPortfolio: true,
    });
    return { totals, text: segments.map((segment) => segment.parts.map((part) => part.text).join(" ")) };
  };

  test("leads with the equity and labels the positions' sum as gross", () => {
    const { text } = header(marginQuotes(), createMarginAccount());
    expect(text.slice(0, 3)).toEqual(["Net Liq 1,000,000", "Gross 1,600,000", "Cash -600,000"]);
    expect(text).toContain("Lev 1.6x");
  });

  test("live quotes for every position replace the gross, never the equity", () => {
    const { totals, text } = header(marginQuotes({ move: 10, option: true }), createMarginAccount());
    expect(totals.livePriced).toBe(true);
    expect(text.slice(0, 2)).toEqual(["Net Liq 1,040,000", "Gross 1,640,000"]);
    // Without the broker's day, the quotes' day is a return on the equity, not on the positions,
    // from a NASDAQ, a XETRA and a CBOE close that need not be the same day's.
    expect(text).toContain("Day +40,000 (+4.00%) vs mixed closes");
  });

  test("without its account, the equity and cash read as unknown beside the gross", () => {
    const { text } = header(marginQuotes(), null);
    expect(text.slice(0, 3)).toEqual(["Net Liq —", "Gross 1,600,000", "Cash —"]);
    expect(text.some((segment) => segment.startsWith("Val") || segment.startsWith("Lev"))).toBe(false);
  });
});
