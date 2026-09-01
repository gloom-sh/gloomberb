import { EventName, type Contract, type Order, type OrderState } from "@stoqey/ib";
import type { BrokerContractRef } from "../../../types/instrument";
import type { BrokerOrder, BrokerOrderPreview, BrokerOrderRequest } from "../../../types/trading";
import type { IbkrGatewayConfig } from "./types";
import { buildIbkrOrder } from "./orders";

const ORDER_ACK_TIMEOUT_MS = 10_000;

function previewIbkrOrder({
  rawApi,
  orderId,
  contract,
  order,
}: {
  rawApi: any;
  orderId: number;
  contract: Contract;
  order: Order;
}): Promise<BrokerOrderPreview> {
  return new Promise<BrokerOrderPreview>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while previewing order"));
    }, ORDER_ACK_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeoutId);
      rawApi.off(EventName.openOrder, onOpenOrder);
      rawApi.off(EventName.error, onError);
    };

    const onOpenOrder = (incomingOrderId: number, _contract: Contract, _order: Order, orderState: OrderState) => {
      if (incomingOrderId !== orderId) return;
      cleanup();
      resolve({
        initMarginBefore: orderState.initMarginBefore,
        initMarginAfter: orderState.initMarginAfter,
        maintMarginBefore: orderState.maintMarginBefore,
        maintMarginAfter: orderState.maintMarginAfter,
        equityWithLoanBefore: orderState.equityWithLoanBefore,
        equityWithLoanAfter: orderState.equityWithLoanAfter,
        commission: orderState.commission,
        commissionCurrency: orderState.commissionCurrency,
        warningText: orderState.warningText,
      });
    };

    const onError = (error: Error, code: number, reqId: number) => {
      if (reqId !== orderId) return;
      cleanup();
      reject(new Error(error.message || `IBKR error ${code}`));
    };

    rawApi.on(EventName.openOrder, onOpenOrder);
    rawApi.on(EventName.error, onError);
    rawApi.placeOrder(orderId, contract, order);
  });
}

function waitForIbkrOrderAcknowledgement({
  rawApi,
  orderId,
  contract,
  order,
  timeoutMessage,
}: {
  rawApi: any;
  orderId: number;
  contract: Contract;
  order: Order;
  timeoutMessage: string;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, ORDER_ACK_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeoutId);
      rawApi.off(EventName.openOrder, onOpenOrder);
      rawApi.off(EventName.orderStatus, onOrderStatus);
      rawApi.off(EventName.error, onError);
    };

    const onOpenOrder = (incomingOrderId: number) => {
      if (incomingOrderId !== orderId) return;
      cleanup();
      resolve();
    };

    const onOrderStatus = (incomingOrderId: number) => {
      if (incomingOrderId !== orderId) return;
      cleanup();
      resolve();
    };

    const onError = (error: Error, code: number, reqId: number) => {
      if (reqId !== orderId) return;
      cleanup();
      reject(new Error(error.message || `IBKR error ${code}`));
    };

    rawApi.on(EventName.openOrder, onOpenOrder);
    rawApi.on(EventName.orderStatus, onOrderStatus);
    rawApi.on(EventName.error, onError);
    rawApi.placeOrder(orderId, contract, order);
  });
}

function buildSubmittedOrderFallback(
  orderId: number,
  brokerInstanceId: string | undefined,
  request: BrokerOrderRequest,
): BrokerOrder {
  return {
    orderId,
    brokerInstanceId,
    accountId: request.accountId,
    status: "Submitted",
    action: request.action,
    orderType: request.orderType,
    quantity: request.quantity,
    filled: 0,
    remaining: request.quantity,
    limitPrice: request.limitPrice,
    stopPrice: request.stopPrice,
    tif: request.tif,
    updatedAt: Date.now(),
    contract: request.contract,
  };
}

export interface IbkrOrderWorkflowContext {
  brokerInstanceId?: string;
  cancelOrder: (orderId: number) => void;
  connect: (config: IbkrGatewayConfig) => Promise<void>;
  getNextValidOrderId: () => Promise<number>;
  getRawApi: () => any;
  listOpenOrders: (config: IbkrGatewayConfig) => Promise<BrokerOrder[]>;
  resolveContract: (
    ticker: string,
    exchange: string,
    instrument: BrokerContractRef | null,
  ) => Promise<Contract>;
}

export async function previewNativeIbkrOrder(
  context: IbkrOrderWorkflowContext,
  config: IbkrGatewayConfig,
  request: BrokerOrderRequest,
): Promise<BrokerOrderPreview> {
  await context.connect(config);
  const contract = await context.resolveContract(request.contract.symbol, request.contract.exchange || "", request.contract);
  const rawApi = context.getRawApi();
  const orderId = await context.getNextValidOrderId();
  const order = buildIbkrOrder(request, true);

  return previewIbkrOrder({ rawApi, orderId, contract, order });
}

export async function placeNativeIbkrOrder(
  context: IbkrOrderWorkflowContext,
  config: IbkrGatewayConfig,
  request: BrokerOrderRequest,
): Promise<BrokerOrder> {
  await context.connect(config);
  const contract = await context.resolveContract(request.contract.symbol, request.contract.exchange || "", request.contract);
  const order = buildIbkrOrder(request, false);
  const rawApi = context.getRawApi();
  const orderId = await context.getNextValidOrderId();

  await waitForIbkrOrderAcknowledgement({
    rawApi,
    orderId,
    contract,
    order,
    timeoutMessage: "Timed out waiting for order acknowledgement",
  });

  const openOrders = await context.listOpenOrders(config);
  return openOrders.find((openOrder) => openOrder.orderId === orderId)
    ?? buildSubmittedOrderFallback(orderId, context.brokerInstanceId, request);
}

export async function modifyNativeIbkrOrder(
  context: IbkrOrderWorkflowContext,
  config: IbkrGatewayConfig,
  orderId: number,
  request: BrokerOrderRequest,
): Promise<BrokerOrder> {
  await context.connect(config);
  const contract = await context.resolveContract(request.contract.symbol, request.contract.exchange || "", request.contract);
  const rawApi = context.getRawApi();
  const order = buildIbkrOrder({ ...request }, false);

  await waitForIbkrOrderAcknowledgement({
    rawApi,
    orderId,
    contract,
    order,
    timeoutMessage: "Timed out waiting for order modification acknowledgement",
  });

  const openOrders = await context.listOpenOrders(config);
  return openOrders.find((openOrder) => openOrder.orderId === orderId)
    ?? buildSubmittedOrderFallback(orderId, context.brokerInstanceId, request);
}

export async function cancelNativeIbkrOrder(
  context: IbkrOrderWorkflowContext,
  config: IbkrGatewayConfig,
  orderId: number,
): Promise<void> {
  await context.connect(config);
  context.cancelOrder(orderId);
  await context.listOpenOrders(config);
}
