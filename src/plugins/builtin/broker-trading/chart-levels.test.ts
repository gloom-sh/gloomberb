import { expect, test } from "bun:test";
import { getThemeColors } from "../../../theme/colors";
import { chartPriceOnTick, orderLevelTarget, orderLineMoves, ticketChartLevels, ticketLineOrders, ticketOrderMatches } from "./chart-levels";
import { createDemoBroker } from "./test-fixture";
import { researchTradeMatches } from "../shared/research-trading";
import { brokerOrderKey, orderEstimatePrice } from "./orders-data";

const colors = getThemeColors("white");
test("chart overlays require the same listing or exact broker instrument", () => {
  const f = createDemoBroker();
  const trade = { levels: [], contract: f.draft.contract };
  expect(researchTradeMatches(trade, null)).toBe(false);
  expect(researchTradeMatches(trade, { symbol: "AAPL:XNAS" })).toBe(true);
  expect(researchTradeMatches(trade, { symbol: "AAPL", exchange: "LSE" })).toBe(false);
  expect(researchTradeMatches(trade, { symbol: "OTHER", exchange: "NASDAQ" })).toBe(false);
  // A routed share (Aries files every share on SMART) is on its listing's chart, and on no other listing.
  const routed = { ...trade, contract: { ...f.draft.contract, exchange: "SMART" } };
  expect(researchTradeMatches(routed, { symbol: "AAPL:XNAS", exchange: "NASDAQ" })).toBe(true);
  expect(researchTradeMatches({ ...routed, contract: { ...routed.contract, primaryExchange: "LSE" } }, { symbol: "AAPL", exchange: "NASDAQ" })).toBe(false);
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
  // Routed SMART and filed as a stock, it is the same share as a listing picked in search or an ETF's ticket.
  const routed = { ...order, contract: { ...order.contract, exchange: "SMART", primaryExchange: undefined } };
  expect(match({ ...routed })).toBe(true);
  expect(ticketOrderMatches(routed, { ...f.draft.contract, exchange: undefined, primaryExchange: "NASDAQ", secType: "ETF" }, f.instance.id, f.draft.accountId)).toBe(true);
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

test("draft levels follow both prices and move, working orders move only where they can change, and terminal orders disappear", () => {
  const f = createDemoBroker();
  const orders = [f.order(f.draft, "WORKING", 1), f.order({ ...f.draft, action: "SELL" }, "PARTIALLY_FILLED", 2), f.order(f.draft, "FILLED", 3)];
  const draft = { ...f.draft, orderType: "STP LMT" as const, limitPrice: 10.25, stopPrice: 10.1 };
  const levels = ticketChartLevels({ draft, editing: true, orders, avgCost: 10, position: 25, colors });
  expect(levels.slice(0, 2).map((level) => [level.value, level.dashed])).toEqual([[10.25, true], [10.1, true]]);
  expect(levels.slice(0, 2).map((level) => level.axisLabel)).toEqual(["10.25", "10.10"]);
  expect(ticketChartLevels({ draft, editing: true, orders: [], colors, priceStep: 0.005 })[0]?.axisLabel).toBe("10.250");
  // Five accepted decimals are a limit, not a tick: the labels keep to cents.
  expect(ticketChartLevels({ draft, editing: true, orders: [], colors, priceDecimals: 5, avgCost: 719.60745, position: 21 }).map((level) => level.axisLabel)).toEqual(["10.25", "10.10", "719.61"]);
  // The draft's lines drag; an order's only where it can change, and never the average or a trailing stop's trigger.
  expect(levels.map((level) => [level.id.split(":")[0], !!level.editable && !!level.draggable])).toEqual([["ticket", true], ["ticket", true], ["order", false], ["order", false], ["position", false]]);
  expect(levels.every((level) => !level.actionable)).toBe(true);
  const trail = f.order({ ...f.draft, orderType: "TRAIL", limitPrice: undefined, stopPrice: 9.5, trailingAmount: 0.5 }, "WORKING", 4);
  const movable = ticketChartLevels({ editing: false, orders: [...orders, trail], colors, movable: (order) => order.action === "BUY" });
  expect(movable.map((level) => [level.label, !!level.draggable])).toEqual([["Buy 10 working", true], ["Sell 6 partial", false], ["Buy 10 trailing", false]]);
  // An order the broker is still acknowledging or already replacing keeps its line until it works again.
  const changes = { enabled: true, modify: true };
  const statuses = ["WORKING", "PARTIALLY_FILLED", "PENDING_NEW", "PENDING_REPLACE"].map((status) => orderLineMoves(f.order(f.draft, status, 5), changes));
  expect(statuses).toEqual([true, true, false, false]);
  expect(orderLineMoves(orders[0]!, { enabled: true, modify: false })).toBe(false);
  expect(levels.find((level) => level.label?.includes("Sell"))?.color).toBe(colors.negative);
  expect(levels.filter((level) => level.id.startsWith("order:"))).toHaveLength(2);
  expect(levels.at(-1)).toMatchObject({ label: "Average cost", axisLabel: "10.00" });
  expect(ticketChartLevels({ editing: false, orders: [], avgCost: 309.85529914, position: 3, colors }).at(-1)?.axisLabel).toBe("309.86");
  expect(ticketChartLevels({ draft: { ...draft, limitPrice: 10.26 }, editing: true, orders: [], colors })[0]?.value).toBe(10.26);
  expect(ticketChartLevels({ draft, editing: false, orders: [], colors })).toEqual([]);
  expect(ticketChartLevels({ draft: { ...draft, limitPrice: 0.00125 }, editing: true, orders: [], colors })[0]).toMatchObject({ label: "Draft limit", axisLabel: "0.00125" });
});

test("a replacement in flight stands for the listed original, which takes over again if it is newer", () => {
  const f = createDemoBroker();
  const original = { ...f.order({ ...f.draft, limitPrice: 700 }, "PENDING_REPLACE", 9), updatedAt: 2 };
  // Aries gives the replacement a new broker ID; the handle stays.
  const replacement = { ...original, brokerOrderId: "replacement", status: "NEW", limitPrice: 701, updatedAt: 1 };
  const prices = (orders: typeof original[]) => ticketChartLevels({ editing: false, orders, latestOrder: replacement, colors }).map((level) => level.value);
  expect(prices([original])).toEqual([701]);
  // A drag on that line finds the order it was drawn from, under its new ID and at its new terms: only in the
  // merged list, never the broker's list from before the change.
  const line = ticketChartLevels({ editing: false, orders: [original], latestOrder: replacement, colors })[0]!;
  expect(orderLevelTarget(line.id, [original])).toBeUndefined();
  expect(orderLevelTarget(line.id, ticketLineOrders([original], replacement))?.order).toMatchObject({ brokerOrderId: "replacement", limitPrice: 701 });
  // Refused, the original is listed working again.
  expect(prices([{ ...original, status: "NEW", updatedAt: 3 }])).toEqual([700]);
});

test("a market order is estimated at the side of the book it takes, a limit or stop at its own price", () => {
  const quote = { price: 100, bid: 99.5, ask: 100.5 };
  expect(orderEstimatePrice({ orderType: "MKT", action: "BUY", limitPrice: 90 }, quote)).toBe(100.5);
  expect(orderEstimatePrice({ orderType: "MKT", action: "SELL" }, quote)).toBe(99.5);
  expect(orderEstimatePrice({ orderType: "MKT", action: "BUY" }, { price: 100, bid: 99.5, ask: 0 })).toBe(100);
  expect(orderEstimatePrice({ orderType: "LMT", action: "BUY", limitPrice: 98 }, quote)).toBe(98);
  expect(orderEstimatePrice({ orderType: "STP", action: "SELL", stopPrice: 95, limitPrice: 90 }, quote)).toBe(95);
});

test("an order being changed keeps the line the broker holds and moves a dashed change line, with no second draft line", () => {
  const f = createDemoBroker();
  const order = f.order({ ...f.draft, orderType: "STP LMT", limitPrice: 10.25, stopPrice: 10.1 }, "WORKING", 1);
  const draft = { ...f.draft, orderType: "STP LMT" as const, limitPrice: 10.4, stopPrice: 10.3 };
  const levels = ticketChartLevels({ draft, editing: true, orders: [order], modifying: order, colors });
  const key = brokerOrderKey(order);
  expect(levels.map((level) => [level.id, level.value, level.label, level.dashed, level.draggable])).toEqual([
    [`held:${key}`, 10.25, "Buy 10 working", false, false], [`held-stop:${key}`, 10.1, "Buy 10 working stop", false, false],
    [`order:${key}`, 10.4, "Buy 10 change", true, true], [`stop:${key}`, 10.3, "Buy 10 change stop", true, true]]);
  expect(orderLevelTarget(levels[0]!.id, [order])).toBeUndefined();
  expect(orderLevelTarget(levels[2]!.id, [order])).toMatchObject({ field: "limitPrice" });
  expect(orderLevelTarget(levels[3]!.id, [order])).toMatchObject({ field: "stopPrice" });
  expect(orderLevelTarget("ticket:limit", [order])).toBeUndefined();
  // A price from the chart lands on the tick the ticket reviews, and never under one tick, however low the line went.
  expect([chartPriceOnTick(336.437), chartPriceOnTick(0.123456), chartPriceOnTick(10.12, 0.05)]).toEqual([336.44, 0.1235, 10.1]);
  expect([chartPriceOnTick(0.01, 0.05), chartPriceOnTick(-3, 0.05), chartPriceOnTick(0), chartPriceOnTick(-0.5)]).toEqual([0.05, 0.05, 0.01, 0.01]);
});
