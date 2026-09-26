import { describe, expect, test } from "bun:test";
import { instrumentFromTicker, quoteSubscriptionTargetFromTicker } from "./request-types";
import { createTestTicker } from "../test-support/ticker";

describe("quoteSubscriptionTargetFromTicker", () => {
  test("selects the broker contract that belongs to the active portfolio", () => {
    const ticker = createTestTicker("VICR", "Vicor", {
      portfolios: [
        "broker:ibkr-live:DU111",
        "broker:ibkr-coldstart:DU222",
      ],
      positions: [
        {
          portfolio: "broker:ibkr-live:DU111",
          shares: 170,
          avgCost: 198,
          currency: "USD",
          broker: "ibkr",
          brokerInstanceId: "ibkr-live",
          brokerContractId: 275759,
        },
        {
          portfolio: "broker:ibkr-coldstart:DU222",
          shares: 350,
          avgCost: 290,
          currency: "USD",
          broker: "ibkr",
          brokerInstanceId: "ibkr-coldstart",
          brokerContractId: 275759,
        },
      ],
      broker_contracts: [
        {
          brokerId: "ibkr",
          brokerInstanceId: "ibkr-live",
          conId: 275759,
          symbol: "VICR",
          localSymbol: "VICR",
          exchange: "NASDAQ",
          currency: "USD",
          secType: "STK",
        },
        {
          brokerId: "ibkr",
          brokerInstanceId: "ibkr-coldstart",
          conId: 275759,
          symbol: "VICR",
          localSymbol: "VICR",
          exchange: "NASDAQ",
          currency: "USD",
          secType: "STK",
        },
      ],
    });

    expect(instrumentFromTicker(ticker, "VICR", { portfolioId: "broker:ibkr-coldstart:DU222" })).toMatchObject({
      symbol: "VICR",
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-coldstart",
      instrument: ticker.metadata.broker_contracts?.[1],
    });
  });

  test("preserves broker contract context for streaming targets", () => {
    const ticker = createTestTicker("AAPL", "Apple", {
      broker_contracts: [{
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-live",
        conId: 265598,
        symbol: "AAPL",
        localSymbol: "AAPL",
        exchange: "NASDAQ",
        currency: "USD",
        secType: "STK",
      }],
    });

    expect(quoteSubscriptionTargetFromTicker(ticker, ticker.metadata.ticker)).toEqual({
      symbol: "AAPL",
      exchange: "NASDAQ",
      route: "auto",
      context: {
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-live",
        instrument: ticker.metadata.broker_contracts?.[0],
      },
    });
  });

});
