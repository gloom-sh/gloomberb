import { describe, expect, test } from "bun:test";
import { getLanguage, setLanguage } from "../../../../i18n";
import type { BrokerAccount } from "../../../../types/trading";
import type { PortfolioSummaryTotals } from "../metrics";
import {
  buildPortfolioFooterSegments,
  buildPortfolioSummarySegments,
  fitSummarySegments,
  layoutPortfolioSummaryHeader,
  resolvePortfolioAccountState,
} from "./index";

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
    }), 26);

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

    expect(segments.find((segment) => segment.id === "val")?.parts[1]?.text).toBe("175.0k");
    expect(segments.find((segment) => segment.id === "leverage")?.parts[1]?.text).toBe("1.4x");
    // Leverage is a ratio of two converted figures, so the display currency cannot move it.
    const converted = buildPortfolioSummarySegments({
      totals, accountState: { account, sourceLabel: "Live" }, convertAccountValue: (value) => value * 1.2,
    });
    expect(converted.find((segment) => segment.id === "leverage")?.parts[1]?.text).toBe("1.4x");
    const noNetLiquidation = buildPortfolioSummarySegments({
      totals, accountState: { account: { ...account, netLiquidation: 0 }, sourceLabel: "Live" },
    });
    expect(noNetLiquidation.some((segment) => segment.id === "leverage")).toBe(false);
  });

  test("drops low-priority broker segments before required ones", () => {
    const segments = fitSummarySegments(buildPortfolioSummarySegments({
      totals,
      accountState: { account, sourceLabel: "Live" },
    }), 112);

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
    const layout = layoutPortfolioSummaryHeader(segments, 56, { cashDrawer: true, hideHeader: false });
    const ids = (list: typeof segments) => list.map((segment) => segment.id);

    expect(ids(layout.row)).toEqual(["netliq", "val", "cash"]);
    expect(ids(layout.detail)).toEqual(["day", "pnl", "settled"]);
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
