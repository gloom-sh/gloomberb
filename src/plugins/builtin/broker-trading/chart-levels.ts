import type { CompositeChartLevel } from "../../../components/chart/composite/levels";
import type { ThemeColors } from "../../../theme/colors";
import type { BrokerContractRef } from "../../../types/instrument";
import type { BrokerOrder, BrokerOrderRequest, BrokerTradingCapabilities } from "../../../types/trading";
import { brokerOrderKey, brokerOrderStatus, canChangeBrokerOrder, ticketEditingPriceStep, withLatestOrder } from "./orders-data";
import { sameBrokerContract } from "../../../utils/instrument-identity";
import { isStrategyOrder } from "./strategy";
import { linkRoleName } from "./linked-orders";

export function ticketOrderMatches(order: Pick<BrokerOrder, "accountId" | "brokerInstanceId" | "contract" | "legs">, contract: BrokerContractRef, profileId: string, accountId?: string): boolean {
  if (!accountId || order.accountId !== accountId || order.brokerInstanceId && order.brokerInstanceId !== profileId
    || order.contract.brokerInstanceId && order.contract.brokerInstanceId !== profileId || order.contract.brokerId !== contract.brokerId) return false;
  const held = order.contract;
  // A spread is its underlying's order: the stock's ticket and a spread ticket on it both list it.
  const spreadTicket = contract.secType?.toUpperCase() === "BAG";
  if (isStrategyOrder(order) || spreadTicket) {
    return isStrategyOrder(order) && held.symbol.trim().toUpperCase() === contract.symbol.trim().toUpperCase()
      && (spreadTicket || !contract.secType || ["STK", "ETF"].includes(contract.secType.toUpperCase()));
  }
  return sameBrokerContract(held, contract);
}

/**
 * A price from the chart on the broker's tick, or the ticket's editing step, so the ticket reviews it as shown. Never
 * under one tick: a line dragged to the bottom of the chart is not a price of zero.
 */
export function chartPriceOnTick(value: number, priceStep?: number, priceDecimals?: number): number {
  const step = priceStep !== undefined && Number.isFinite(priceStep) && priceStep > 0 ? priceStep : ticketEditingPriceStep(Math.max(value, 0), priceDecimals);
  const decimals = Math.min(18, step.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 18 }).split(".")[1]?.length ?? 0);
  return Number((Math.max(1, Math.round(value / step)) * step).toFixed(decimals));
}

/** The orders the chart draws: the broker's list with the ticket's latest word on one merged in. */
export function ticketLineOrders(orders: readonly BrokerOrder[], latestOrder?: BrokerOrder): readonly BrokerOrder[] {
  return latestOrder ? withLatestOrder(orders, latestOrder) : orders;
}

/**
 * Whether a working order's line moves on the chart: the broker changes this order, and it is neither still being
 * acknowledged nor already being replaced.
 */
export function orderLineMoves(order: BrokerOrder, allowed: Pick<BrokerTradingCapabilities, "enabled" | "modify"> | undefined): boolean {
  return !!allowed?.enabled && !!allowed.modify && canChangeBrokerOrder(order) && !["Replacing", "Submitted"].includes(brokerOrderStatus(order.status));
}

/** Which ticket price each draft level shows, by level id. */
export const TICKET_LEVEL_FIELDS = {
  "ticket:limit": "limitPrice", "ticket:stop": "stopPrice", "ticket:take-profit": "takeProfitPrice", "ticket:stop-loss": "stopLossPrice",
} as const satisfies Record<string, keyof BrokerOrderRequest>;

/** The order a working order's level belongs to, and the price it shows. */
export function orderLevelTarget(id: string, orders: readonly BrokerOrder[]): { order: BrokerOrder; field: "limitPrice" | "stopPrice" } | undefined {
  const [kind, ...rest] = id.split(":");
  if (kind !== "order" && kind !== "stop") return undefined;
  const key = rest.join(":");
  const order = orders.find((value) => brokerOrderKey(value) === key);
  if (!order) return undefined;
  return { order, field: kind === "stop" || order.orderType === "STP" ? "stopPrice" : "limitPrice" };
}

/**
 * The ticket's draft and this account's working orders as chart levels. Levels hold no broker operation: a moved
 * draft level changes the draft, and a moved order level opens that order's change in the ticket, for its review.
 * `movable` says which working orders' lines move (the broker changes them, and the ticket is free to).
 * While an order is being changed, a dashed line shows the changed price, and its own line stays where the broker
 * holds it until the change is confirmed.
 */
export function ticketChartLevels({ draft, editing, orders, latestOrder, modifying, movable, avgCost, position, colors, priceStep, priceDecimals }: {
  draft?: BrokerOrderRequest; editing: boolean; orders: readonly BrokerOrder[]; latestOrder?: BrokerOrder;
  modifying?: BrokerOrder; movable?: (order: BrokerOrder) => boolean;
  avgCost?: number; position?: number; colors: ThemeColors; priceStep?: number; priceDecimals?: number;
}): CompositeChartLevel[] {
  const levels: CompositeChartLevel[] = [];
  // The broker's tick, or the ticket's editing step: a cent, a hundredth of a cent below a dollar. Accepted
  // decimals are a limit, not a tick: five of them do not make $719.60745 an average anyone reads.
  const tick = (value: number) => priceStep !== undefined && Number.isFinite(priceStep) && priceStep > 0 ? priceStep : ticketEditingPriceStep(value, priceDecimals);
  // An order price shows every digit it was entered with; an average is arithmetic, so it rounds to the tick.
  const add = (id: string, value: number | undefined, label: string, color: string, dashed = false, averaged = false, moves = false) => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return;
    const minimumFractionDigits = Math.min(18, tick(value).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 18 }).split(".")[1]?.length ?? 0);
    const maximumFractionDigits = averaged ? minimumFractionDigits : Math.max(8, minimumFractionDigits);
    const axisLabel = value.toLocaleString("en-US", { minimumFractionDigits, maximumFractionDigits });
    levels.push({ id, value, axisLabel, label, color, editable: moves, draggable: moves, actionable: false, dashed });
  };
  const changing = modifying && editing && draft ? brokerOrderKey(modifying) : undefined;
  if (draft && editing && !changing) {
    const color = draft.action === "SELL" ? colors.negative : colors.positive;
    // A bracket's exits trade the other way; an OCO's stop is its own side's.
    const exitColor = draft.action === "SELL" ? colors.positive : colors.negative;
    if (["LMT", "STP LMT"].includes(draft.orderType)) add("ticket:limit", draft.limitPrice, "Draft limit", color, true, false, true);
    if (["STP", "STP LMT"].includes(draft.orderType)) add("ticket:stop", draft.stopPrice, "Draft stop", color, true, false, true);
    if (draft.orderClass === "oco") add("ticket:stop-loss", draft.stopLossPrice, "Draft stop", color, true, false, true);
    if (draft.orderClass === "bracket") {
      add("ticket:take-profit", draft.takeProfitPrice, "Draft take profit", exitColor, true, false, true);
      add("ticket:stop-loss", draft.stopLossPrice, "Draft stop loss", exitColor, true, false, true);
    }
  }
  for (const order of ticketLineOrders(orders, latestOrder)) {
    if (!canChangeBrokerOrder(order)) continue;
    const state = ({ "Partially filled": "partial", Replacing: "replacing" } as Record<string, string>)[brokerOrderStatus(order.status)];
    // A bracket's exit or a trailing stop says what it is; a plain order says how it stands.
    const kind = order.linkRole && order.linkRole !== "entry" ? linkRoleName[order.linkRole].toLowerCase() : order.orderType === "TRAIL" ? "trailing" : undefined;
    const label = `${order.action === "BUY" ? "Buy" : "Sell"} ${order.remaining} ${[kind, state].filter(Boolean).join(" ") || "working"}`;
    const color = order.action === "SELL" ? colors.negative : colors.positive;
    const key = brokerOrderKey(order);
    // The order being changed shows where it is going, dashed, as a draft does, and moves on from there. Its own
    // line stays put: nothing has reached the broker until the change is reviewed and confirmed.
    if (key === changing && draft) {
      const change = `${order.action === "BUY" ? "Buy" : "Sell"} ${order.remaining} change`;
      add(`held:${key}`, order.limitPrice ?? order.stopPrice, label, color);
      if (order.orderType === "STP LMT") add(`held-stop:${key}`, order.stopPrice, `${label} stop`, color);
      add(`order:${key}`, order.orderType === "STP" ? draft.stopPrice : draft.limitPrice, change, color, true, false, true);
      if (order.orderType === "STP LMT") add(`stop:${key}`, draft.stopPrice, `${change} stop`, color, true, false, true);
      continue;
    }
    // A trailing stop's trigger is the broker's to move.
    const moves = order.orderType !== "TRAIL" && !isStrategyOrder(order) && (movable?.(order) ?? false);
    add(`order:${key}`, order.limitPrice ?? order.stopPrice, label, color, false, false, moves);
    if (order.orderType === "STP LMT") add(`stop:${key}`, order.stopPrice, `${label} stop`, color, false, false, moves);
  }
  if (position && avgCost !== undefined) add("position:average", avgCost, "Average cost", colors.textDim, false, true);
  return levels;
}
