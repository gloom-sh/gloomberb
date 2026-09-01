import { describe, expect, test } from "bun:test";
import { createDefaultConfig, type AppConfig, type BrokerInstanceConfig } from "../../../types/config";
import type { TickerRecord } from "../../../types/ticker";
import {
  findTickerForOrder,
  formatContractLabel,
  formatPreviewMetric,
  formatPreviewSummary,
  formatQuoteSummary,
  getKnownIbkrAccounts,
  getTradeTonePalette,
  hasIbkrTradingProfiles,
  inferDraftAccountId,
  isLimitOrder,
  isMarketDataWarning,
  isStopOrder,
  truncateTradeText,
} from "./utils";

function createGatewayInstance(): BrokerInstanceConfig {
  return {
    id: "ibkr-paper",
    brokerType: "ibkr",
    label: "Paper",
    connectionMode: "gateway",
    config: { connectionMode: "gateway", gateway: { host: "127.0.0.1", port: 4002, clientId: 1 } },
    enabled: true,
  };
}

function createFlexInstance(): BrokerInstanceConfig {
  return {
    id: "ibkr-flex",
    brokerType: "ibkr",
    label: "Flex",
    connectionMode: "flex",
    config: { connectionMode: "flex", flex: { token: "token", queryId: "query" } },
    enabled: true,
  };
}

function createConfig(brokerInstances: BrokerInstanceConfig[] = []): AppConfig {
  return {
    ...createDefaultConfig("/tmp/gloomberb-trade-utils"),
    brokerInstances,
  };
}

function createTicker(symbol: string): TickerRecord {
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

describe("trade-utils", () => {
  test("detects configured IBKR gateway profiles", () => {
    expect(hasIbkrTradingProfiles(createConfig())).toBe(false);
    expect(hasIbkrTradingProfiles(createConfig([createFlexInstance()]))).toBe(false);
    expect(hasIbkrTradingProfiles(createConfig([createGatewayInstance()]))).toBe(true);
  });

  test("infers account ids from portfolio, preferred account, or single account", () => {
    const config = createConfig([createGatewayInstance()]);
    config.portfolios = [{
      id: "portfolio:ibkr",
      name: "IBKR",
      currency: "USD",
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-paper",
      brokerAccountId: "DU111",
    }];

    expect(inferDraftAccountId(config, "portfolio:ibkr", [{ accountId: "DU999", name: "Other" }], "ibkr-paper")).toBe("DU111");
    expect(inferDraftAccountId(config, null, [{ accountId: "DU999", name: "Other" }], "ibkr-paper", "DU999")).toBe("DU999");
    expect(inferDraftAccountId(config, null, [{ accountId: "DU123", name: "Only" }], "ibkr-paper")).toBe("DU123");
  });

  test("merges cached and live accounts by account id", () => {
    const accounts = getKnownIbkrAccounts(
      {
        "ibkr-paper": [{
          accountId: "DU123",
          name: "Cached",
          currency: "USD",
          netLiquidation: 1000,
        }],
      },
      "ibkr-paper",
      [{
        accountId: "DU123",
        name: "Live",
        currency: "USD",
        availableFunds: 500,
      }],
    );

    expect(accounts).toEqual([{
      accountId: "DU123",
      name: "Live",
      currency: "USD",
      netLiquidation: 1000,
      availableFunds: 500,
    }]);
  });

  test("formats contract, quote, preview, and truncation helpers", () => {
    expect(formatContractLabel({ symbol: "AAPL", localSymbol: "AAPL  240621C00190000", secType: "OPT" })).toBe("AAPL  240621C00190000 OPT");
    expect(formatQuoteSummary()).toBe("No broker quote loaded");
    expect(formatQuoteSummary({
      symbol: "AAPL",
      price: 190.25,
      currency: "USD",
      change: 1.5,
      changePercent: 0.79,
      bid: 190.2,
      ask: 190.3,
      lastUpdated: Date.now(),
    })).toContain("Spd 0.1");
    expect(formatPreviewSummary(null)).toContain("Preview required before submit");
    expect(formatPreviewSummary({
      initMarginBefore: 12000,
      initMarginAfter: 13000,
      commission: 1.25,
      commissionCurrency: "USD",
    } as any)).toContain("What-if: init");
    expect(formatPreviewMetric(10, 15)).toBe("10 → 15");
    expect(truncateTradeText("ABCDEFGHIJ", 6)).toBe("ABC...");
  });

  test("detects order type variants and market data warnings", () => {
    expect(isLimitOrder("LMT")).toBe(true);
    expect(isLimitOrder("STP")).toBe(false);
    expect(isStopOrder("STP LMT")).toBe(true);
    expect(isMarketDataWarning("Delayed market data is not subscribed")).toBe(true);
    expect(getTradeTonePalette("positive").text).toBeDefined();
  });

  test("resolves order tickers by direct symbol or broker contract metadata", () => {
    const amd = createTicker("AMD");
    const spyOption: TickerRecord = {
      ...createTicker("SPY250117C00600000"),
      metadata: {
        ...createTicker("SPY250117C00600000").metadata,
        broker_contracts: [{
          brokerId: "ibkr",
          brokerInstanceId: "ibkr-paper",
          symbol: "SPY",
          localSymbol: "SPY  250117C00600000",
          conId: 123,
        }],
      },
    };
    const tickers = new Map([
      ["AMD", amd],
      ["SPY250117C00600000", spyOption],
    ]);

    expect(findTickerForOrder({
      contract: { symbol: "AMD", brokerInstanceId: "ibkr-paper" },
    }, tickers)?.metadata.ticker).toBe("AMD");
    expect(findTickerForOrder({
      contract: { symbol: "SPY", localSymbol: "SPY  250117C00600000", conId: 123, brokerInstanceId: "ibkr-paper" },
    }, tickers)?.metadata.ticker).toBe("SPY250117C00600000");
  });
});
