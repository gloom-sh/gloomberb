import { expect, test } from "bun:test";
import type { TickerRecord } from "../types/ticker";
import { instrumentFromTicker, quoteSubscriptionTargetFromTicker } from "./request-types";
import { createTestTicker } from "../test-support/ticker";

function fixture(): TickerRecord {
  return createTestTicker("ACME", "ACME", {
    portfolios: ["a", "b", "manual"],
    positions: [
      { portfolio: "a", broker: "ibkr", brokerInstanceId: "feed-a", brokerContractId: 101, shares: 10 },
      { portfolio: "b", broker: "ibkr", brokerInstanceId: "feed-b", brokerContractId: 202, shares: 10 },
      { portfolio: "manual", broker: "manual", shares: 10 },
    ],
    broker_contracts: [
      { brokerId: "ibkr", brokerInstanceId: "feed-a", conId: 101, symbol: "ACME", currency: "USD", secType: "STK" },
      { brokerId: "ibkr", brokerInstanceId: "feed-b", conId: 202, symbol: "ACME", currency: "USD", secType: "STK" },
    ],
  });
}
const resolve = (ticker: TickerRecord, portfolioId: string) => instrumentFromTicker(ticker, "ACME", { portfolioId });

test("explicit missing or contradictory portfolio contracts cannot fall back to another account or conId", () => {
  for (const mode of ["missing", "same-instance-wrong-id", "wrong-broker", "no-contracts"]) {
    const ticker = fixture();
    if (mode === "missing") ticker.metadata.broker_contracts!.pop();
    if (mode === "same-instance-wrong-id") ticker.metadata.broker_contracts![1]!.conId = 303;
    if (mode === "wrong-broker") ticker.metadata.broker_contracts![1]!.brokerId = "other";
    if (mode === "no-contracts") ticker.metadata.broker_contracts = [];
    expect(resolve(ticker, "b")).toBeNull();
    expect(quoteSubscriptionTargetFromTicker(ticker, "ACME", "auto", { portfolioId: "b" })).toBeNull();
  }
});

test("manual and undeclared Flex positions retain public symbol lookup without another account's broker route", () => {
  const ticker = fixture();
  ticker.metadata.positions.push({ portfolio: "flex", broker: "ibkr", brokerInstanceId: "feed-flex", shares: 10 });
  for (const portfolio of ["manual", "flex"]) {
    expect(resolve(ticker, portfolio)).toMatchObject({ symbol: "ACME", instrument: null, brokerId: undefined, brokerInstanceId: undefined });
  }
  expect(instrumentFromTicker(ticker)?.instrument?.conId).toBe(101);
});

test("legacy scoped positions require a unique matching broker and instance, while explicit IDs never weaken to that match", () => {
  const ticker = fixture();
  delete ticker.metadata.positions[1]!.brokerContractId;
  expect(resolve(ticker, "b")?.instrument?.conId).toBe(202);
  ticker.metadata.broker_contracts!.push({ ...ticker.metadata.broker_contracts![1]! });
  expect(resolve(ticker, "b")?.instrument?.conId).toBe(202);
  ticker.metadata.broker_contracts!.push({ ...ticker.metadata.broker_contracts![1]!, conId: 303 });
  expect(resolve(ticker, "b")).toBeNull();
  ticker.metadata.positions[1]!.brokerContractId = 202;
  expect(resolve(ticker, "b")?.instrument?.conId).toBe(202);
  ticker.metadata.positions[1]!.brokerContractId = 404;
  expect(resolve(ticker, "b")).toBeNull();
});

test("one scoped quote can cover repeated identical lots but not distinct contracts or a mix of declared and unproven identities", () => {
  const ticker = fixture(), own = ticker.metadata.positions[1]!;
  ticker.metadata.positions.push({ ...own, shares: -5 });
  expect(resolve(ticker, "b")?.instrument?.conId).toBe(202);
  ticker.metadata.positions.push({ ...ticker.metadata.positions[0]!, portfolio: "b", shares: 0 });
  expect(resolve(ticker, "b")?.instrument?.conId).toBe(202);
  ticker.metadata.positions.at(-1)!.shares = 5;
  expect(resolve(ticker, "b")).toBeNull();
  ticker.metadata.positions.pop();
  ticker.metadata.positions.push({ portfolio: "b", shares: 5, broker: "manual" });
  expect(resolve(ticker, "b")).toBeNull();
});

test("legacy derivative declarations cannot collapse distinct financial definitions without a canonical contract ID", () => {
  const contract = { brokerId: "ibkr", brokerInstanceId: "feed-b", symbol: "ACME", secType: "OPT", currency: "USD", exchange: "SMART",
    lastTradeDateOrContractMonth: "20261016", right: "C" as const, strike: 100, multiplier: "100", tradingClass: "ACME", primaryExchange: "CBOE" };
  for (const change of [
    { strike: 110 }, { right: "P" as const }, { lastTradeDateOrContractMonth: "20261120" },
    { multiplier: "10" }, { tradingClass: "ACME1" }, { primaryExchange: "ISE" },
  ]) {
    const ticker = fixture();
    delete ticker.metadata.positions[1]!.brokerContractId;
    ticker.metadata.broker_contracts = [contract, { ...contract, ...change }];
    expect(resolve(ticker, "b")).toBeNull();
    ticker.metadata.broker_contracts = [contract, { ...contract }];
    expect(resolve(ticker, "b")?.instrument).toEqual(contract);
  }
});
