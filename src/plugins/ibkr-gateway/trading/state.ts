import { useSyncExternalStore } from "react";
import type { TickerRecord } from "../../../types/ticker";
import type { BrokerContractRef, InstrumentSearchResult } from "../../../types/instrument";
import type { BrokerOrder, BrokerOrderPreview, BrokerOrderRequest } from "../../../types/trading";

export interface TradeTicketState {
  draft: BrokerOrderRequest;
  brokerInstanceId?: string;
  brokerLabel?: string;
  editingOrderId?: number;
  contractName?: string;
  contractExchange?: string;
  preview: BrokerOrderPreview | null;
  busy: boolean;
  lastError?: string;
  lastInfo?: string;
  /** When true, lastInfo is a success message (rendered in positive color). */
  isSuccess?: boolean;
}

export interface TradingPaneState {
  brokerInstanceId?: string;
  brokerLabel?: string;
  accountId?: string;
  selectedOpenOrderIndex: number;
  busy: boolean;
  lastError?: string;
  lastInfo?: string;
  tickets: Record<string, TradeTicketState>;
}

const DEFAULT_DRAFT: BrokerOrderRequest = {
  action: "BUY",
  orderType: "MKT",
  quantity: 1,
  tif: "DAY",
  outsideRth: false,
  contract: {
    brokerId: "ibkr",
    symbol: "",
    exchange: "SMART",
    currency: "USD",
    secType: "STK",
  },
};

const DEFAULT_TRADE_TICKET: TradeTicketState = {
  draft: DEFAULT_DRAFT,
  preview: null,
  busy: false,
};

let state: TradingPaneState = {
  selectedOpenOrderIndex: 0,
  busy: false,
  tickets: {},
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function normalizeContract(ticker: TickerRecord): BrokerContractRef {
  const brokerContract = ticker.metadata.broker_contracts?.find((contract) => contract.brokerId === "ibkr")
    ?? ticker.metadata.broker_contracts?.[0];
  if (brokerContract) return brokerContract;

  return {
    brokerId: "ibkr",
    symbol: ticker.metadata.ticker,
    localSymbol: ticker.metadata.ticker,
    secType: ticker.metadata.assetCategory || "STK",
    exchange: ticker.metadata.exchange || "SMART",
    primaryExchange: ticker.metadata.exchange || undefined,
    currency: ticker.metadata.currency || "USD",
  };
}

function replaceDraft(nextDraft: BrokerOrderRequest): BrokerOrderRequest {
  return {
    ...nextDraft,
    tif: nextDraft.tif || "DAY",
    outsideRth: nextDraft.outsideRth ?? false,
  };
}

function createDefaultTradeTicket(ticker?: TickerRecord | null): TradeTicketState {
  if (!ticker) return DEFAULT_TRADE_TICKET;
  const contract = normalizeContract(ticker);
  return {
    draft: replaceDraft({
      ...DEFAULT_DRAFT,
      brokerInstanceId: contract.brokerInstanceId,
      contract,
    }),
    brokerInstanceId: contract.brokerInstanceId,
    contractName: ticker.metadata.name,
    contractExchange: ticker.metadata.exchange,
    preview: null,
    busy: false,
  };
}

function updateTicketState(
  symbol: string,
  ticker: TickerRecord | null | undefined,
  updater: (current: TradeTicketState) => TradeTicketState,
): void {
  const current = getTradeTicketState(symbol, ticker);
  state = {
    ...state,
    tickets: {
      ...state.tickets,
      [symbol]: updater(current),
    },
  };
  emit();
}

export function updateTradeTicketState(
  symbol: string,
  ticker: TickerRecord | null | undefined,
  updater: (current: TradeTicketState) => TradeTicketState,
): void {
  updateTicketState(symbol, ticker, updater);
}

function subscribeTradingPane(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTradingPaneState(): TradingPaneState {
  return state;
}

export function useTradingPaneState(): TradingPaneState {
  return useSyncExternalStore(subscribeTradingPane, getTradingPaneState);
}

export function updateTradingPaneState(
  updater: Partial<TradingPaneState> | ((current: TradingPaneState) => TradingPaneState),
): void {
  state = typeof updater === "function" ? updater(state) : { ...state, ...updater };
  emit();
}

export function setTradingBusy(busy: boolean): void {
  updateTradingPaneState({ busy });
}

export function setTradingMessage(lastInfo?: string, lastError?: string): void {
  updateTradingPaneState({ lastInfo, lastError });
}

export function getTradeTicketState(symbol?: string | null, ticker?: TickerRecord | null): TradeTicketState {
  if (!symbol) return createDefaultTradeTicket(ticker);
  return state.tickets[symbol] ?? createDefaultTradeTicket(ticker);
}

export function setTradeTicketBusy(symbol: string, busy: boolean, ticker?: TickerRecord | null): void {
  updateTicketState(symbol, ticker, (current) => ({ ...current, busy }));
}

export function setTradeTicketMessage(
  symbol: string,
  lastInfo: string | undefined,
  lastError: string | undefined,
  ticker?: TickerRecord | null,
  isSuccess?: boolean,
): void {
  updateTicketState(symbol, ticker, (current) => ({ ...current, lastInfo, lastError, isSuccess: isSuccess ?? false }));
}

export function setTradeTicketDraft(
  symbol: string,
  patch: Partial<BrokerOrderRequest>,
  ticker?: TickerRecord | null,
): void {
  updateTicketState(symbol, ticker, (current) => ({
    ...current,
    draft: replaceDraft({
      ...current.draft,
      ...patch,
      contract: patch.contract ? { ...current.draft.contract, ...patch.contract } : current.draft.contract,
    }),
    brokerInstanceId: patch.brokerInstanceId ?? current.brokerInstanceId,
    preview: null,
    lastError: undefined,
    lastInfo: undefined,
  }));
}

export function setTradeTicketInstrument(
  symbol: string,
  result: InstrumentSearchResult,
  ticker?: TickerRecord | null,
): void {
  const contract = result.brokerContract ?? {
    brokerId: "ibkr",
    brokerInstanceId: result.brokerInstanceId,
    symbol: result.symbol,
    localSymbol: result.symbol,
    exchange: result.exchange || "SMART",
    primaryExchange: result.primaryExchange,
    currency: result.currency || "USD",
    secType: result.type || "STK",
  };

  updateTicketState(symbol, ticker, (current) => ({
    ...current,
    draft: replaceDraft({
      ...current.draft,
      brokerInstanceId: result.brokerInstanceId ?? contract.brokerInstanceId,
      contract,
    }),
    brokerInstanceId: result.brokerInstanceId ?? contract.brokerInstanceId,
    brokerLabel: result.brokerLabel ?? current.brokerLabel,
    contractName: result.name,
    contractExchange: result.exchange,
    preview: null,
    editingOrderId: undefined,
    lastError: undefined,
    lastInfo: undefined,
  }));
}

export function prefillTradeFromTicker(ticker: TickerRecord, action: BrokerOrderRequest["action"]): void {
  const contract = normalizeContract(ticker);
  updateTicketState(ticker.metadata.ticker, ticker, (current) => ({
    ...current,
    draft: replaceDraft({
      ...current.draft,
      action,
      brokerInstanceId: contract.brokerInstanceId,
      contract,
    }),
    brokerInstanceId: contract.brokerInstanceId ?? current.brokerInstanceId,
    contractName: ticker.metadata.name,
    contractExchange: ticker.metadata.exchange,
    preview: null,
    editingOrderId: undefined,
    lastError: undefined,
    lastInfo: undefined,
  }));
}

export function loadOrderIntoDraft(symbol: string, order: BrokerOrder, ticker?: TickerRecord | null): void {
  updateTicketState(symbol, ticker, (current) => ({
    ...current,
    draft: replaceDraft({
      ...current.draft,
      brokerInstanceId: order.brokerInstanceId ?? order.contract.brokerInstanceId,
      accountId: order.accountId,
      action: order.action,
      orderType: order.orderType as BrokerOrderRequest["orderType"],
      quantity: order.remaining || order.quantity,
      limitPrice: order.limitPrice,
      stopPrice: order.stopPrice,
      tif: order.tif || current.draft.tif,
      contract: order.contract,
    }),
    brokerInstanceId: order.brokerInstanceId ?? order.contract.brokerInstanceId ?? current.brokerInstanceId,
    editingOrderId: order.orderId,
    preview: null,
    lastInfo: `Loaded order ${order.orderId} for review.`,
    lastError: undefined,
  }));
}

export function setTradeTicketPreview(
  symbol: string,
  preview: BrokerOrderPreview | null,
  ticker?: TickerRecord | null,
): void {
  updateTicketState(symbol, ticker, (current) => ({ ...current, preview, lastError: undefined }));
}

export function clearTradingDraft(symbol?: string): void {
  if (symbol) {
    const nextTickets = { ...state.tickets };
    delete nextTickets[symbol];
    updateTradingPaneState({ tickets: nextTickets });
    return;
  }
  updateTradingPaneState({
    brokerInstanceId: undefined,
    brokerLabel: undefined,
    accountId: undefined,
    tickets: {},
    selectedOpenOrderIndex: 0,
    lastError: undefined,
    lastInfo: undefined,
  });
}

export function removeBrokerInstanceFromTradingState(instanceId: string): void {
  updateTradingPaneState((current) => {
    const nextTickets = Object.fromEntries(Object.entries(current.tickets).map(([symbol, ticket]) => {
      if (
        ticket.brokerInstanceId !== instanceId
        && ticket.draft.brokerInstanceId !== instanceId
        && ticket.draft.contract.brokerInstanceId !== instanceId
      ) {
        return [symbol, ticket];
      }
      return [symbol, {
        ...ticket,
        brokerInstanceId: undefined,
        brokerLabel: ticket.brokerInstanceId === instanceId ? undefined : ticket.brokerLabel,
        editingOrderId: undefined,
        preview: null,
        draft: replaceDraft({
          ...ticket.draft,
          brokerInstanceId: ticket.draft.brokerInstanceId === instanceId ? undefined : ticket.draft.brokerInstanceId,
          accountId: undefined,
          contract: {
            ...ticket.draft.contract,
            brokerInstanceId: ticket.draft.contract.brokerInstanceId === instanceId ? undefined : ticket.draft.contract.brokerInstanceId,
          },
        }),
      }];
    }));

    return {
      ...current,
      brokerInstanceId: current.brokerInstanceId === instanceId ? undefined : current.brokerInstanceId,
      brokerLabel: current.brokerInstanceId === instanceId ? undefined : current.brokerLabel,
      accountId: current.brokerInstanceId === instanceId ? undefined : current.accountId,
      tickets: nextTickets,
    };
  });
}
