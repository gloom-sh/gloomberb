import type { CompositeChartLevel } from "../../../components/chart/composite/levels";
import type { ThemeColors } from "../../../theme/colors";
import type { BrokerContractRef } from "../../../types/instrument";
import type { BrokerOrder, BrokerOrderRequest } from "../../../types/trading";
import { brokerOrderKey, brokerOrderStatus, canChangeBrokerOrder } from "./orders-data";
import { canonicalExchange } from "../../../utils/exchanges";
import { optionContractIdentity } from "../../../utils/options";
import { isStrategyOrder } from "./strategy";

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
  if (held.conId !== undefined && contract.conId !== undefined) return held.conId === contract.conId;
  // An option is its OCC contract, however the broker routes it or writes its expiry.
  const option = optionContractIdentity(held);
  if (option || optionContractIdentity(contract)) return option === optionContractIdentity(contract)
    && (held.multiplier === undefined || contract.multiplier === undefined || Number(held.multiplier) === Number(contract.multiplier));
  const key = (value: BrokerContractRef) => JSON.stringify([
    value.symbol.toUpperCase(), canonicalExchange(value.exchange), value.secType, value.currency, value.lastTradeDateOrContractMonth,
    value.right, value.strike, value.multiplier, (value.localSymbol ?? value.symbol).toUpperCase(),
  ]);
  return key(held) === key(contract);
}

/** A read-only projection. No broker operation is attached to a chart level. */
export function ticketChartLevels({ draft, editing, orders, latestOrder, avgCost, position, colors, priceStep, priceDecimals }: {
  draft?: BrokerOrderRequest; editing: boolean; orders: readonly BrokerOrder[]; latestOrder?: BrokerOrder;
  avgCost?: number; position?: number; colors: ThemeColors; priceStep?: number; priceDecimals?: number;
}): CompositeChartLevel[] {
  const levels: CompositeChartLevel[] = [];
  const tickDigits = priceStep !== undefined && Number.isFinite(priceStep) && priceStep > 0
    ? (priceStep.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 18 }).split(".")[1]?.length ?? 0)
    : priceDecimals;
  const minimumFractionDigits = tickDigits !== undefined && Number.isInteger(tickDigits) && tickDigits >= 0 && tickDigits <= 18 ? tickDigits : 2;
  // An order price shows every digit it was entered with; an average is arithmetic, so it rounds to the tick (4 places below a dollar).
  const add = (id: string, value: number | undefined, label: string, color: string, dashed = false, averaged = false) => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return;
    const maximumFractionDigits = averaged ? Math.max(minimumFractionDigits, value < 1 ? 4 : 2) : Math.max(8, minimumFractionDigits);
    const axisLabel = value.toLocaleString("en-US", { minimumFractionDigits, maximumFractionDigits });
    levels.push({ id, value, axisLabel, label, color, editable: false, actionable: false, dashed });
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
    const label = `${order.action === "BUY" ? "Buy" : "Sell"} ${order.remaining} ${brokerOrderStatus(order.status) === "Partially filled" ? "partial" : "working"}`;
    const color = order.action === "SELL" ? colors.negative : colors.positive;
    add(`order:${brokerOrderKey(order)}`, order.limitPrice ?? order.stopPrice, label, color);
    if (order.orderType === "STP LMT") add(`stop:${brokerOrderKey(order)}`, order.stopPrice, `${label} stop`, color);
  }
  if (position && avgCost !== undefined) add("position:average", avgCost, "Average cost", colors.textDim, false, true);
  return levels;
}
