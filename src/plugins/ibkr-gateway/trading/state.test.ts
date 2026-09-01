import { afterEach, describe, expect, test } from "bun:test";
import type { TickerRecord } from "../../../types/ticker";
import type { BrokerOrder } from "../../../types/trading";
import {
  clearTradingDraft,
  getTradeTicketState,
  loadOrderIntoDraft,
  prefillTradeFromTicker,
  removeBrokerInstanceFromTradingState,
} from "./state";

function createTicker(symbol: string, brokerInstanceId?: string): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      name: symbol,
      assetCategory: "STK",
      portfolios: [],
      watchlists: [],
      positions: [],
      broker_contracts: brokerInstanceId ? [{
        brokerId: "ibkr",
        brokerInstanceId,
        symbol,
        localSymbol: symbol,
        secType: "STK",
        exchange: "SMART",
        currency: "USD",
      }] : [],
      custom: {},
      tags: [],
    },
  };
}

afterEach(() => {
  clearTradingDraft();
});

describe("ibkr trading state", () => {
  test("keeps separate ticket drafts per ticker", () => {
    const amd = createTicker("AMD", "ibkr-paper");
    const aapl = createTicker("AAPL", "ibkr-paper");

    prefillTradeFromTicker(amd, "BUY");
    prefillTradeFromTicker(aapl, "SELL");

    expect(getTradeTicketState("AMD", amd).draft.action).toBe("BUY");
    expect(getTradeTicketState("AAPL", aapl).draft.action).toBe("SELL");
    expect(getTradeTicketState("AMD", amd).draft.contract.symbol).toBe("AMD");
    expect(getTradeTicketState("AAPL", aapl).draft.contract.symbol).toBe("AAPL");
  });

  test("loads an order into only the targeted ticker ticket", () => {
    const amd = createTicker("AMD", "ibkr-paper");
    const aapl = createTicker("AAPL", "ibkr-paper");

    prefillTradeFromTicker(amd, "BUY");
    prefillTradeFromTicker(aapl, "BUY");

    const order: BrokerOrder = {
      orderId: 101,
      brokerInstanceId: "ibkr-paper",
      accountId: "DU12345",
      status: "Submitted",
      action: "SELL",
      orderType: "LMT",
      quantity: 4,
      filled: 0,
      remaining: 4,
      limitPrice: 123.45,
      tif: "DAY",
      updatedAt: Date.now(),
      contract: {
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-paper",
        symbol: "AMD",
        localSymbol: "AMD",
        secType: "STK",
        exchange: "SMART",
        currency: "USD",
      },
    };

    loadOrderIntoDraft("AMD", order, amd);

    expect(getTradeTicketState("AMD", amd).editingOrderId).toBe(101);
    expect(getTradeTicketState("AMD", amd).draft.action).toBe("SELL");
    expect(getTradeTicketState("AAPL", aapl).editingOrderId).toBeUndefined();
    expect(getTradeTicketState("AAPL", aapl).draft.action).toBe("BUY");
  });

  test("removes broker-linked ticket metadata only for the removed instance", () => {
    const amd = createTicker("AMD", "ibkr-paper");
    const aapl = createTicker("AAPL", "ibkr-live");

    prefillTradeFromTicker(amd, "BUY");
    prefillTradeFromTicker(aapl, "SELL");

    removeBrokerInstanceFromTradingState("ibkr-paper");

    expect(getTradeTicketState("AMD", amd).brokerInstanceId).toBeUndefined();
    expect(getTradeTicketState("AMD", amd).draft.contract.brokerInstanceId).toBeUndefined();
    expect(getTradeTicketState("AAPL", aapl).brokerInstanceId).toBe("ibkr-live");
    expect(getTradeTicketState("AAPL", aapl).draft.contract.brokerInstanceId).toBe("ibkr-live");
  });
});
