import { expect, test } from "bun:test";
import { tickerInstrumentLabel } from "./instrument-label";

test("a stock contract with a zero strike labels as the bare symbol", () => {
  // IBKR's AMD stock contract: strike 0, empty expiry, multiplier "0".
  expect(tickerInstrumentLabel("AMD", { brokerId: "ibkr", brokerInstanceId: "ibkr-1", symbol: "AMD", localSymbol: "AMD", secType: "STK",
    exchange: "NASDAQ", currency: "USD", lastTradeDateOrContractMonth: "", multiplier: "0", conId: 4391, strike: 0 } as never)).toBe("AMD");
});

test("an option keeps its expiry, right and strike", () => {
  expect(tickerInstrumentLabel("AMD", { brokerId: "ibkr", brokerInstanceId: "ibkr-1", symbol: "AMD", localSymbol: "AMD 261016C00150000",
    secType: "OPT", lastTradeDateOrContractMonth: "20261016", right: "C", strike: 150 } as never)).toBe("AMD 261016C00150000 20261016 C 150");
});

test("a future's contract month reads as a month and year", () => {
  expect(tickerInstrumentLabel("ES", { brokerId: "ibkr", symbol: "ES", localSymbol: "ESZ6", secType: "FUT",
    lastTradeDateOrContractMonth: "202612", multiplier: "50" } as never)).toBe("ESZ6 Dec 2026");
});
