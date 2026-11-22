import { expect, test } from "bun:test";
import type { BrokerOrder, BrokerTradingCapabilities } from "../../../types/trading";
import { accountTradingCapabilities, changesAlone, groupCancelLine, linkedOrderRows } from "./linked-orders";

test("a bracket lists where its newest order sits, the entry above its exits, whatever order the broker sends", () => {
  const order = (id: string, accountId: string, linkGroup?: string, linkRole?: "entry" | "takeProfit" | "stopLoss") => ({ id, accountId, linkGroup, linkRole });
  const rows = linkedOrderRows([
    order("plain", "a"), order("stop", "a", "g1", "stopLoss"), order("other-account", "b", "g1", "entry"), order("entry", "a", "g1", "entry"),
    order("target", "a", "g1", "takeProfit"), order("oco-stop", "a", "g2", "stopLoss"), order("oco-limit", "a", "g2", "takeProfit"),
  ]);
  expect(rows.map((row) => `${row.order.id}${row.child ? " (child)" : ""}`)).toEqual([
    "plain", "entry", "target (child)", "stop (child)", "other-account", "oco-limit", "oco-stop",
  ]);
});

test("an account adds the brackets and OCO pairs its own brokerage runs to the broker's, for that account alone", () => {
  const caps: BrokerTradingCapabilities = { enabled: true, orderTypes: ["LMT"], tif: ["DAY"] };
  expect(accountTradingCapabilities(caps, { orderClasses: ["bracket", "oco"] }).orderClasses).toEqual(["bracket", "oco"]);
  const oco: BrokerTradingCapabilities = { ...caps, orderClasses: ["oco"] };
  expect(accountTradingCapabilities(oco, { orderClasses: ["bracket", "oco"] }).orderClasses).toEqual(["oco", "bracket"]);
  // An account that names none, or none chosen, leaves the broker's as they are.
  expect(accountTradingCapabilities(caps, {})).toBe(caps);
  expect(accountTradingCapabilities(caps, undefined)).toBe(caps);
  expect(accountTradingCapabilities(undefined, { orderClasses: ["bracket"] })).toBeUndefined();
});

test("a cancel of one order of a group the broker cancels as one names the group's other working orders", () => {
  const order = (orderId: number, linkRole: BrokerOrder["linkRole"], status = "WORKING", linkGroup = "g1", accountId = "a"): BrokerOrder => ({
    orderId, brokerOrderId: `b${orderId}`, accountId, status, action: "SELL", orderType: "LMT", quantity: 3, filled: 0, remaining: 3,
    updatedAt: 0, contract: { brokerId: "x", symbol: "AAPL" }, linkGroup, linkRole,
  });
  const entry = order(1, "entry"), profit = order(2, "takeProfit"), loss = order(3, "stopLoss");
  const group = { linkedOrders: "group" } as const;
  expect(groupCancelLine(loss, [loss, profit, entry], group)).toBe("Also cancels its entry and take profit.");
  expect(groupCancelLine(entry, [entry, profit, loss], group)).toBe("Also cancels its take profit and stop loss.");
  // An ended order, another group's or another account's goes on its own course.
  expect(groupCancelLine(profit, [entry, profit, { ...loss, status: "CANCELLED" }, order(4, "stopLoss", "WORKING", "g2"), order(5, "stopLoss", "WORKING", "g1", "b")], group))
    .toBe("Also cancels its entry.");
  expect(groupCancelLine(profit, [profit], group)).toBeUndefined();
  // A broker that cancels each alone, or an order of no group, takes nothing else.
  expect(groupCancelLine(loss, [entry, profit, loss], { linkedOrders: "each" })).toBeUndefined();
  expect(groupCancelLine(loss, [entry, profit, loss], undefined)).toBeUndefined();
  expect(groupCancelLine({ ...loss, linkGroup: undefined }, [entry, profit, loss], group)).toBeUndefined();
  expect([changesAlone(loss, group), changesAlone(loss, {}), changesAlone({}, group)]).toEqual([false, true, true]);
});
