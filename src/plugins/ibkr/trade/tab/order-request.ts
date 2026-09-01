import type { BrokerInstanceConfig } from "../../../../types/config";
import type { TickerRecord } from "../../../../types/ticker";
import type { BrokerOrderRequest } from "../../../../types/trading";
import { isGatewayConfigured, type IbkrConfig } from "../../config";
import { setTradeTicketMessage, type TradeTicketState } from "../../trading/state";
import { isLimitOrder, isStopOrder } from "../utils";

export function buildTradeOrderRequest({
  currentAccountId,
  gatewayRequiredMessage,
  isGatewayMode,
  normalizedConfig,
  selectedInstance,
  symbol,
  ticketState,
  ticker,
}: {
  currentAccountId?: string;
  gatewayRequiredMessage: string;
  isGatewayMode: boolean;
  normalizedConfig: IbkrConfig | null;
  selectedInstance?: BrokerInstanceConfig;
  symbol: string | null;
  ticketState: TradeTicketState;
  ticker: TickerRecord | null;
}): BrokerOrderRequest | null {
  if (!symbol || !ticker) return null;
  if (!selectedInstance || !normalizedConfig || !isGatewayMode || !isGatewayConfigured(selectedInstance.config)) {
    setTradeTicketMessage(symbol, undefined, gatewayRequiredMessage, ticker);
    return null;
  }
  if (!ticketState.draft.contract.symbol) {
    setTradeTicketMessage(symbol, undefined, "Choose a contract before previewing an order.", ticker);
    return null;
  }
  if (!currentAccountId) {
    setTradeTicketMessage(symbol, undefined, "Select an IBKR account before trading.", ticker);
    return null;
  }

  const request: BrokerOrderRequest = {
    ...ticketState.draft,
    brokerInstanceId: selectedInstance.id,
    accountId: currentAccountId,
    contract: {
      ...ticketState.draft.contract,
      brokerId: "ibkr",
      brokerInstanceId: ticketState.draft.contract.brokerInstanceId ?? selectedInstance.id,
    },
  };
  if (request.quantity <= 0) {
    setTradeTicketMessage(symbol, undefined, "Quantity must be greater than zero.", ticker);
    return null;
  }
  if (isLimitOrder(request.orderType) && request.limitPrice == null) {
    setTradeTicketMessage(symbol, undefined, "Limit orders require a limit price.", ticker);
    return null;
  }
  if (isStopOrder(request.orderType) && request.stopPrice == null) {
    setTradeTicketMessage(symbol, undefined, "Stop orders require a stop price.", ticker);
    return null;
  }
  return request;
}
