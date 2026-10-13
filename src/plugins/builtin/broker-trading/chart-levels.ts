import type { CompositeChartLevel } from "../../../components/chart/composite/levels";
import type { ThemeColors } from "../../../theme/colors";
import type { BrokerContractRef } from "../../../types/instrument";
import type { BrokerOrder, BrokerOrderRequest } from "../../../types/trading";
import { brokerOrderKey, brokerOrderStatus, canChangeBrokerOrder } from "./orders-data";
import { canonicalExchange } from "../../../utils/exchanges";

export function ticketOrderMatches(order: Pick<BrokerOrder, "accountId" | "brokerInstanceId" | "contract">, contract: BrokerContractRef, profileId: string, accountId?: string): boolean {
  if (!accountId || order.accountId !== accountId || order.brokerInstanceId && order.brokerInstanceId !== profileId
    || order.contract.brokerInstanceId && order.contract.brokerInstanceId !== profileId || order.contract.brokerId !== contract.brokerId) return false;
  const held = order.contract;
  if (held.conId !== undefined && contract.conId !== undefined) return held.conId === contract.conId;
  const key = (value: BrokerContractRef) => JSON.stringify([
    value.symbol.toUpperCase(), canonicalExchange(value.exchange), value.secType, value.currency, value.lastTradeDateOrContractMonth,
    value.right, value.strike, value.multiplier, (value.localSymbol ?? value.symbol).toUpperCase(),
  ]);
  return key(held) === key(contract);
}

/** A read-only projection. No broker operation is attached to a chart level. */
export function ticketChartLevels({ draft, editing, orders, latestOrder, avgCost, position, colors }: {
  draft?: BrokerOrderRequest; editing: boolean; orders: readonly BrokerOrder[]; latestOrder?: BrokerOrder;
  avgCost?: number; position?: number; colors: ThemeColors;
}): CompositeChartLevel[] {
  const levels: CompositeChartLevel[] = [];
  const add = (id: string, value: number | undefined, label: string, color: string, dashed = false) => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return;
    levels.push({ id, value, label: `${label} · ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`, color, editable: false, actionable: false, dashed });
  };
  if (draft && editing) {
    const color = draft.action === "SELL" ? colors.negative : colors.positive;
    if (["LMT", "STP LMT"].includes(draft.orderType)) add("ticket:limit", draft.limitPrice, "Draft limit", color, true);
    if (["STP", "STP LMT"].includes(draft.orderType)) add("ticket:stop", draft.stopPrice, "Draft stop", color, true);
  }
  const resultKey = latestOrder && brokerOrderKey(latestOrder);
  const existing = resultKey ? orders.find((order) => brokerOrderKey(order) === resultKey) : undefined;
  const projected = latestOrder && (!existing || existing.updatedAt <= latestOrder.updatedAt)
    ? [...orders.filter((order) => brokerOrderKey(order) !== resultKey), latestOrder] : orders;
  for (const order of projected) {
    if (!canChangeBrokerOrder(order)) continue;
    const label = `${order.action === "BUY" ? "Buy" : "Sell"} ${order.remaining} · ${brokerOrderStatus(order.status) === "Partially filled" ? "partial" : "working"}`;
    const color = order.action === "SELL" ? colors.negative : colors.positive;
    add(`order:${brokerOrderKey(order)}`, order.limitPrice ?? order.stopPrice, label, color);
    if (order.orderType === "STP LMT") add(`stop:${brokerOrderKey(order)}`, order.stopPrice, `${label} stop`, color);
  }
  if (position && avgCost !== undefined) add("position:average", avgCost, "Average cost", colors.textDim);
  return levels;
}
