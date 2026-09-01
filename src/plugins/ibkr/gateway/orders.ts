import {
  OrderAction,
  OrderType,
  TimeInForce,
  type Contract,
  type Order,
  type OrderState,
} from "@stoqey/ib";
import type { BrokerContractRef } from "../../../types/instrument";
import type { BrokerOrder, BrokerOrderRequest } from "../../../types/trading";

export interface OpenIbkrOrder {
  orderId: number;
  contract: Contract;
  order: Order;
  orderState: OrderState;
  orderStatus?: {
    status: string;
    filled: number;
    remaining: number;
    avgFillPrice: number;
  };
}

export function openIbkrOrderToBrokerOrder(
  openOrder: OpenIbkrOrder,
  brokerInstanceId: string | undefined,
  contractToRef: (contract: Contract) => BrokerContractRef,
): BrokerOrder {
  return {
    orderId: openOrder.orderId,
    brokerInstanceId,
    accountId: openOrder.order.account,
    status: openOrder.orderStatus?.status || openOrder.orderState.status || "Unknown",
    action: (openOrder.order.action || "BUY") as BrokerOrder["action"],
    orderType: openOrder.order.orderType || "",
    quantity: openOrder.order.totalQuantity ?? 0,
    filled: openOrder.orderStatus?.filled ?? 0,
    remaining: openOrder.orderStatus?.remaining ?? openOrder.order.totalQuantity ?? 0,
    avgFillPrice: openOrder.orderStatus?.avgFillPrice,
    limitPrice: openOrder.order.lmtPrice,
    stopPrice: openOrder.order.auxPrice,
    tif: openOrder.order.tif,
    warningText: openOrder.orderState.warningText,
    updatedAt: Date.now(),
    contract: contractToRef(openOrder.contract),
  };
}

export function buildIbkrOrder(request: BrokerOrderRequest, whatIf: boolean): Order {
  return {
    account: request.accountId,
    action: request.action === "BUY" ? OrderAction.BUY : OrderAction.SELL,
    totalQuantity: request.quantity,
    orderType: request.orderType as OrderType,
    lmtPrice: request.limitPrice,
    auxPrice: request.stopPrice,
    tif: (request.tif ?? TimeInForce.DAY) as typeof TimeInForce[keyof typeof TimeInForce],
    outsideRth: request.outsideRth ?? false,
    whatIf,
    transmit: true,
  };
}
