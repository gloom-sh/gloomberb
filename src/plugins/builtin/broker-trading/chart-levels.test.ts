import { expect, test } from "bun:test";
import { getThemeColors } from "../../../theme/colors";
import { ticketChartLevels, ticketOrderMatches } from "./chart-levels";
import { createDemoBroker } from "./test-fixture";
import { researchTradeMatches } from "../shared/research-trading";

const colors = getThemeColors("white");
test("chart overlays require the same listing or exact broker instrument", () => {
  const f = createDemoBroker();
  const trade = { levels: [], contract: f.draft.contract };
  expect(researchTradeMatches(trade, null)).toBe(false);
  expect(researchTradeMatches(trade, { symbol: "AAPL:XNAS" })).toBe(true);
  expect(researchTradeMatches(trade, { symbol: "AAPL", exchange: "LSE" })).toBe(false);
  expect(researchTradeMatches(trade, { symbol: "OTHER", exchange: "NASDAQ" })).toBe(false);
  const option = { ...trade, contract: { ...f.draft.contract, secType: "OPT", conId: 17 } };
  expect(researchTradeMatches(option, { symbol: "AAPL", exchange: "NASDAQ" })).toBe(false);
  expect(researchTradeMatches(option, { symbol: "AAPL", instrument: option.contract })).toBe(true);
});
test("chart order projection excludes another account, profile or derivative contract", () => {
  const f = createDemoBroker();
  const order = f.order(f.draft, "WORKING", 1);
  const match = (next: typeof order) => ticketOrderMatches(next, f.draft.contract, f.instance.id, f.draft.accountId);
  expect(match(order)).toBe(true);
  expect(match({ ...order, contract: { ...order.contract, localSymbol: order.contract.symbol } })).toBe(true);
  expect(match({ ...order, contract: { ...order.contract, localSymbol: "OTHER" } })).toBe(false);
  expect(match({ ...order, accountId: "other" })).toBe(false);
  expect(match({ ...order, brokerInstanceId: "other" })).toBe(false);
  expect(match({ ...order, contract: { ...order.contract, brokerInstanceId: "other" } })).toBe(false);
  for (const patch of [{ symbol: "OTHER" }, { exchange: "LSE" }, { secType: "OPT" }, { strike: 123 }, { lastTradeDateOrContractMonth: "203001" }]) {
    expect(match({ ...order, contract: { ...order.contract, ...patch } })).toBe(false);
  }
  expect(ticketOrderMatches(order, f.draft.contract, f.instance.id, undefined)).toBe(false);
});
// Regression: Aries lists an option order under its underlying, routed SMART
// with a dashed expiry, so the contract's own page lost its open order.
test("an option order matches its contract by OCC identity, however the broker writes it", () => {
  const f = createDemoBroker();
  const page = { brokerId: f.draft.contract.brokerId, brokerInstanceId: f.instance.id, symbol: "AAPL", localSymbol: "AAPL261026C00345000", secType: "OPT", currency: "USD", lastTradeDateOrContractMonth: "20261026", right: "C" as const, strike: 345, multiplier: "100" };
  const listed = { ...f.order(f.draft, "WORKING", 1), contract: { ...page, exchange: "SMART", lastTradeDateOrContractMonth: "2026-10-26" } };
  const match = (contract: Omit<typeof page, "right"> & { right: "C" | "P" }) => ticketOrderMatches(listed, contract, f.instance.id, f.draft.accountId);
  expect(match(page)).toBe(true);
  // A contract opened by its symbol alone, from a chain without a broker underlying.
  expect(match({ ...page, symbol: "AAPL261026C00345000", lastTradeDateOrContractMonth: undefined as never, right: undefined as never, strike: undefined as never })).toBe(true);
  for (const patch of [{ strike: 350, localSymbol: "AAPL261026C00350000" }, { right: "P" as const, localSymbol: "AAPL261026P00345000" }, { multiplier: "10" }]) {
    expect(match({ ...page, ...patch })).toBe(false);
  }
});

test("a spread is its underlying's order: the stock's ticket and a spread ticket list it, a leg's own ticket does not", () => {
  const f = createDemoBroker();
  const option = { ...f.draft.contract, symbol: "AAPL", localSymbol: "AAPL261026C00345000", secType: "OPT", lastTradeDateOrContractMonth: "20261026", right: "C" as const, strike: 345, multiplier: "100" };
  const spread = { ...f.order(f.draft, "WORKING", 1), contract: { ...f.draft.contract, secType: "BAG", exchange: "SMART" }, legs: [{ contract: option, action: "BUY" as const, ratio: 1 }] };
  const match = (contract: typeof f.draft.contract, order: Parameters<typeof ticketOrderMatches>[0] = spread) => ticketOrderMatches(order, contract, f.instance.id, f.draft.accountId);
  expect([match(f.draft.contract), match(spread.contract), match(option), match({ ...f.draft.contract, symbol: "MSFT" })]).toEqual([true, true, false, false]);
  // The spread ticket lists spreads only, not the stock's orders.
  expect(match(spread.contract, f.order(f.draft, "WORKING", 2))).toBe(false);
});

test("an older submission receipt cannot revive a line after a newer cancellation acknowledgement", () => {
  const f = createDemoBroker();
  const submitted = { ...f.order(f.draft, "WORKING", 1), updatedAt: 10 };
  const cancelled = { ...submitted, status: "CANCELED", updatedAt: 20 };
  expect(ticketChartLevels({ editing: false, orders: [cancelled], latestOrder: submitted, colors })).toEqual([]);
  expect(ticketChartLevels({ editing: false, orders: [submitted], latestOrder: cancelled, colors })).toEqual([]);
  expect(ticketChartLevels({ editing: false, orders: [], latestOrder: submitted, colors })).toHaveLength(1);
});

test("live draft levels are read-only, follow both prices, and terminal orders disappear", () => {
  const f = createDemoBroker();
  const orders = [f.order(f.draft, "WORKING", 1), f.order({ ...f.draft, action: "SELL" }, "PARTIALLY_FILLED", 2), f.order(f.draft, "FILLED", 3)];
  const draft = { ...f.draft, orderType: "STP LMT" as const, limitPrice: 10.25, stopPrice: 10.1 };
  const levels = ticketChartLevels({ draft, editing: true, orders, avgCost: 10, position: 25, colors });
  expect(levels.slice(0, 2).map((level) => [level.value, level.dashed])).toEqual([[10.25, true], [10.1, true]]);
  expect(levels.slice(0, 2).map((level) => level.axisLabel)).toEqual(["10.25", "10.10"]);
  expect(ticketChartLevels({ draft, editing: true, orders: [], colors, priceStep: 0.005 })[0]?.axisLabel).toBe("10.250");
  expect(ticketChartLevels({ draft, editing: true, orders: [], colors, priceDecimals: 4 })[0]?.axisLabel).toBe("10.2500");
  expect(levels.every((level) => !level.editable && !level.actionable)).toBe(true);
  expect(levels.find((level) => level.label?.includes("Sell"))?.color).toBe(colors.negative);
  expect(levels.filter((level) => level.id.startsWith("order:"))).toHaveLength(2);
  expect(levels.at(-1)).toMatchObject({ label: "Average cost", axisLabel: "10.00" });
  expect(ticketChartLevels({ editing: false, orders: [], avgCost: 309.85529914, position: 3, colors }).at(-1)?.axisLabel).toBe("309.86");
  expect(ticketChartLevels({ draft: { ...draft, limitPrice: 10.26 }, editing: true, orders: [], colors })[0]?.value).toBe(10.26);
  expect(ticketChartLevels({ draft, editing: false, orders: [], colors })).toEqual([]);
  expect(ticketChartLevels({ draft: { ...draft, limitPrice: 0.00125 }, editing: true, orders: [], colors })[0]).toMatchObject({ label: "Draft limit", axisLabel: "0.00125" });
});
