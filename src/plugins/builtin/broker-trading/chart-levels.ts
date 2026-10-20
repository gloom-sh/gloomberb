import type { CompositeChartLevel } from "../../../components/chart/composite/levels";
import type { ThemeColors } from "../../../theme/colors";
import type { BrokerContractRef } from "../../../types/instrument";
import type { BrokerOrder, BrokerOrderRequest } from "../../../types/trading";
import { brokerOrderKey, brokerOrderStatus, canChangeBrokerOrder, ticketEditingPriceStep, withLatestOrder } from "./orders-data";
import { sameBrokerContract } from "../../../utils/instrument-identity";
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
  return sameBrokerContract(held, contract);
}

/** A read-only projection. No broker operation is attached to a chart level. */
export function ticketChartLevels({ draft, editing, orders, latestOrder, avgCost, position, colors, priceStep, priceDecimals }: {
  draft?: BrokerOrderRequest; editing: boolean; orders: readonly BrokerOrder[]; latestOrder?: BrokerOrder;
  avgCost?: number; position?: number; colors: ThemeColors; priceStep?: number; priceDecimals?: number;
}): CompositeChartLevel[] {
  const levels: CompositeChartLevel[] = [];
  // The broker's tick, or the ticket's editing step: a cent, a hundredth of a cent below a dollar. Accepted
  // decimals are a limit, not a tick: five of them do not make $719.60745 an average anyone reads.
  const tick = (value: number) => priceStep !== undefined && Number.isFinite(priceStep) && priceStep > 0 ? priceStep : ticketEditingPriceStep(value, priceDecimals);
  // An order price shows every digit it was entered with; an average is arithmetic, so it rounds to the tick.
  const add = (id: string, value: number | undefined, label: string, color: string, dashed = false, averaged = false) => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return;
    const minimumFractionDigits = Math.min(18, tick(value).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 18 }).split(".")[1]?.length ?? 0);
    const maximumFractionDigits = averaged ? minimumFractionDigits : Math.max(8, minimumFractionDigits);
    const axisLabel = value.toLocaleString("en-US", { minimumFractionDigits, maximumFractionDigits });
    levels.push({ id, value, axisLabel, label, color, editable: false, actionable: false, dashed });
  };
  if (draft && editing) {
    const color = draft.action === "SELL" ? colors.negative : colors.positive;
    if (["LMT", "STP LMT"].includes(draft.orderType)) add("ticket:limit", draft.limitPrice, "Draft limit", color, true);
    if (["STP", "STP LMT"].includes(draft.orderType)) add("ticket:stop", draft.stopPrice, "Draft stop", color, true);
  }
  const projected = latestOrder ? withLatestOrder(orders, latestOrder) : orders;
  for (const order of projected) {
    if (!canChangeBrokerOrder(order)) continue;
    const label = `${order.action === "BUY" ? "Buy" : "Sell"} ${order.remaining} ${({ "Partially filled": "partial", Replacing: "replacing" } as Record<string, string>)[brokerOrderStatus(order.status)] ?? "working"}`;
    const color = order.action === "SELL" ? colors.negative : colors.positive;
    add(`order:${brokerOrderKey(order)}`, order.limitPrice ?? order.stopPrice, label, color);
    if (order.orderType === "STP LMT") add(`stop:${brokerOrderKey(order)}`, order.stopPrice, `${label} stop`, color);
  }
  if (position && avgCost !== undefined) add("position:average", avgCost, "Average cost", colors.textDim, false, true);
  return levels;
}
