import type { Quote } from "../../../types/financials";
import type { BrokerOrder, BrokerOrderClass, BrokerOrderLinkRole, BrokerOrderRequest, BrokerTradingCapabilities, BrokerTrailingUnit } from "../../../types/trading";

/**
 * Brackets, OCO pairs and trailing stops: what a broker takes, what a draft of
 * one must hold, and how the orders it becomes are listed together. The broker
 * places and runs them; nothing here makes one out of separate orders.
 */

export type LinkedFeature = BrokerOrderClass | "trailing";

const FEATURE_NAME: Record<LinkedFeature, string> = { bracket: "brackets", oco: "OCO orders", trailing: "trailing stops" };

/** Whether the broker takes a bracket, an OCO pair or a trailing stop here, and the refusal when it does not. */
export function linkedFeature(capabilities: BrokerTradingCapabilities | undefined, feature: LinkedFeature, brokerName: string): { available: boolean; reason?: string } {
  const available = feature === "trailing"
    ? !!capabilities?.orderTypes.includes("TRAIL") && !!capabilities.trailing?.length
    : !!capabilities?.orderClasses?.includes(feature);
  if (available) return { available };
  return { available, reason: `${brokerName} does not take ${FEATURE_NAME[feature]}.` };
}

/** The trailing unit a draft edits: percent once it holds one, else the amount. */
export function trailingUnit(request: Pick<BrokerOrderRequest, "trailingAmount" | "trailingPercent">): BrokerTrailingUnit {
  return "trailingPercent" in request && !("trailingAmount" in request) ? "percent" : "amount";
}

const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;

/**
 * The entry's own price an exit is measured against: its limit, or its stop,
 * or none for a market order.
 */
function entryPrice(request: BrokerOrderRequest): number | undefined {
  if (request.orderType === "LMT" || request.orderType === "STP LMT") return request.limitPrice;
  if (request.orderType === "STP") return request.stopPrice;
  return undefined;
}

/**
 * The entry's price when it rests away from the market, where it fills: a buy
 * limit under the ask or a buy stop over it, a sell the mirror. None for one
 * that trades now, or without a quote.
 */
export function restingEntryPrice(request: BrokerOrderRequest, quote: Pick<Quote, "bid" | "ask">): number | undefined {
  const buy = request.action === "BUY";
  const touch = buy ? quote.ask : quote.bid;
  if (!positive(touch)) return undefined;
  const entry = entryPrice(request);
  if (request.orderType === "LMT") return positive(entry) && (buy ? entry < touch : entry > touch) ? entry : undefined;
  if (request.orderType === "STP" || request.orderType === "STP LMT") {
    return positive(request.stopPrice) && (buy ? request.stopPrice > touch : request.stopPrice < touch) ? entry : undefined;
  }
  return undefined;
}

/**
 * Checks a draft's bracket, OCO pair or trailing stop against what the broker
 * declared, before any preview. Throws with the reason to show.
 */
export function checkLinkedOrder(request: BrokerOrderRequest, capabilities: BrokerTradingCapabilities, brokerName: string, checkPrice: (value: number, label: string) => void): void {
  const buy = request.action === "BUY";
  const trailing = request.orderType === "TRAIL";
  if (!trailing && (request.trailingAmount !== undefined || request.trailingPercent !== undefined)) throw new Error("Remove the trailing distance for this order type.");
  if (trailing) {
    const feature = linkedFeature(capabilities, "trailing", brokerName);
    if (!feature.available) throw new Error(feature.reason);
    const unit = trailingUnit(request);
    if ((request.trailingAmount !== undefined) === (request.trailingPercent !== undefined)) throw new Error("Enter the trailing distance in price or in percent.");
    if (!capabilities.trailing?.includes(unit)) throw new Error(unit === "percent" ? `${brokerName} takes a trailing stop in price, not percent.` : `${brokerName} takes a trailing stop in percent, not price.`);
    const distance = unit === "percent" ? request.trailingPercent : request.trailingAmount;
    if (!positive(distance) || unit === "percent" && distance >= 100) throw new Error("Enter a valid trailing distance.");
    if (unit === "amount") checkPrice(distance, "trailing");
  }
  const exits = request.takeProfitPrice !== undefined || request.stopLossPrice !== undefined;
  if (!request.orderClass) {
    if (exits) throw new Error("Remove the take profit and stop loss, or make the order a bracket.");
    return;
  }
  const feature = linkedFeature(capabilities, request.orderClass, brokerName);
  if (!feature.available) throw new Error(feature.reason);
  if (request.legs?.length) throw new Error("A spread cannot carry a bracket or an OCO pair.");
  if (request.orderClass === "oco") {
    if (request.orderType !== "LMT") throw new Error("An OCO pair is a limit and a stop.");
    if (request.takeProfitPrice !== undefined) throw new Error("An OCO pair is a limit and a stop, with no take profit.");
    if (!positive(request.stopLossPrice)) throw new Error("Enter a valid stop price.");
    checkPrice(request.stopLossPrice, "stop");
    // A sell pair exits a long: a limit above, a stop below. A buy pair is the mirror.
    if (positive(request.limitPrice) && (buy ? request.limitPrice >= request.stopLossPrice : request.limitPrice <= request.stopLossPrice)) {
      throw new Error(buy ? "A buy OCO's limit sits below its stop." : "A sell OCO's limit sits above its stop.");
    }
    return;
  }
  if (!["MKT", "LMT", "STP", "STP LMT"].includes(request.orderType)) throw new Error("A bracket's entry is a market, limit or stop order.");
  if (!positive(request.takeProfitPrice) && !positive(request.stopLossPrice)) throw new Error("Enter a take profit, a stop loss or both.");
  for (const [value, label] of [[request.takeProfitPrice, "take profit"], [request.stopLossPrice, "stop loss"]] as const) {
    if (value === undefined) continue;
    if (!positive(value)) throw new Error(`Enter a valid ${label} price.`);
    checkPrice(value, label);
  }
  // A buy's take profit sells above where it bought and its stop loss below; a sell's the mirror.
  const entry = entryPrice(request);
  const above = (value: number, than: number) => buy ? value > than : value < than;
  if (positive(entry) && positive(request.takeProfitPrice) && !above(request.takeProfitPrice, entry)) throw new Error(buy ? "The take profit must be above the entry." : "The take profit must be below the entry.");
  if (positive(entry) && positive(request.stopLossPrice) && !above(entry, request.stopLossPrice)) throw new Error(buy ? "The stop loss must be below the entry." : "The stop loss must be above the entry.");
  if (positive(request.takeProfitPrice) && positive(request.stopLossPrice) && !above(request.takeProfitPrice, request.stopLossPrice)) {
    throw new Error(buy ? "The take profit must be above the stop loss." : "The take profit must be below the stop loss.");
  }
}

export const linkRoleName: Record<BrokerOrderLinkRole, string> = { entry: "Entry", takeProfit: "Take profit", stopLoss: "Stop loss" };
/** Beside a price in a one-line row. */
export const linkRoleShort: Record<BrokerOrderLinkRole, string> = { entry: "", takeProfit: "TP", stopLoss: "SL" };

/** "Trailing $1.50", "Trailing 2%": a trailing stop's distance. */
export function trailingText(order: Pick<BrokerOrder, "trailingAmount" | "trailingPercent">, money: (value: number) => string): string {
  if (positive(order.trailingPercent)) return `Trailing ${order.trailingPercent.toLocaleString("en-US", { maximumFractionDigits: 4 })}%`;
  return positive(order.trailingAmount) ? `Trailing ${money(order.trailingAmount)}` : "Trailing";
}

const ROLE_ORDER: Record<BrokerOrderLinkRole, number> = { entry: 0, takeProfit: 1, stopLoss: 2 };

/**
 * Orders as a list shows them: newest first, with each group's orders
 * together where its newest one sits, the entry before its take profit and
 * stop loss. `child` marks an exit listed under its entry.
 */
export function linkedOrderRows<T extends Pick<BrokerOrder, "linkGroup" | "linkRole" | "accountId">>(orders: readonly T[]): Array<{ order: T; child: boolean }> {
  const groups = new Map<string, T[]>();
  for (const order of orders) {
    if (!order.linkGroup) continue;
    const key = `${order.accountId ?? ""}:${order.linkGroup}`;
    groups.set(key, [...groups.get(key) ?? [], order]);
  }
  const rows: Array<{ order: T; child: boolean }> = [];
  const placed = new Set<string>();
  for (const order of orders) {
    const key = order.linkGroup ? `${order.accountId ?? ""}:${order.linkGroup}` : undefined;
    const group = key ? groups.get(key) : undefined;
    if (!key || !group || group.length < 2) { rows.push({ order, child: false }); continue; }
    if (placed.has(key)) continue;
    placed.add(key);
    const sorted = [...group].sort((a, b) => ROLE_ORDER[a.linkRole ?? "entry"] - ROLE_ORDER[b.linkRole ?? "entry"]);
    const entry = sorted.some((item) => item.linkRole === "entry");
    for (const item of sorted) rows.push({ order: item, child: entry && item.linkRole !== "entry" });
  }
  return rows;
}
