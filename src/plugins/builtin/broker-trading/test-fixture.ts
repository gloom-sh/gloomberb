import type { BrokerAdapter, BrokerPosition } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { Quote } from "../../../types/financials";
import type { BrokerAccount, BrokerExecution, BrokerOrder, BrokerOrderPreview, BrokerOrderRequest } from "../../../types/trading";

/** Synthetic, in-memory broker for tests and disposable screenshot profiles only. */
export type DemoOrderOutcome = "working" | "partial" | "filled" | "rejected" | "unknown";
export interface DemoBrokerOptions {
  mode?: "simulation" | "live" | "both";
  enabled?: boolean;
  connected?: boolean;
  outcome?: DemoOrderOutcome;
  quoteAgeMs?: number;
  previewError?: string;
  now?: () => number;
  seedOrders?: boolean;
}

export const DEMO_SIM_ACCOUNT = "demo-simulation";
export const DEMO_LIVE_ACCOUNT = "demo-live";
export const DEMO_BROKER_ID = "demo-broker";

export function demoContract(symbol = "AAPL", instanceId = "demo-simulation-profile") {
  return { brokerId: DEMO_BROKER_ID, brokerInstanceId: instanceId, symbol, secType: "STK", exchange: "NASDAQ", currency: "USD" };
}

export function createDemoBroker(options: DemoBrokerOptions = {}) {
  const now = options.now ?? Date.now;
  const mode = options.mode ?? "simulation";
  const instance: BrokerInstanceConfig = {
    id: `demo-${mode}-profile`, brokerType: DEMO_BROKER_ID,
    label: mode === "live" ? "Demo Broker (LIVE)" : "Demo Broker (simulation)",
    enabled: true,
    config: { tradingEnabled: options.enabled ?? true, accountMode: mode, synthetic: true },
  };
  const calls: Array<{ method: string; request?: BrokerOrderRequest; orderId?: number }> = [];
  let connected = options.connected ?? true;
  let outcome: DemoOrderOutcome = options.outcome ?? "working";
  let nextOrderId = 100;
  const orderBook = new Map<number, BrokerOrder>();
  const executions: BrokerExecution[] = [];
  const account = (live: boolean): BrokerAccount => ({
    accountId: live ? DEMO_LIVE_ACCOUNT : DEMO_SIM_ACCOUNT,
    name: live ? "Demo Broker (LIVE)" : "Demo Broker (simulation)",
    tradingMode: live ? "live" : "simulation", accountType: "Cash", currency: "USD", updatedAt: now(),
    netLiquidation: 53_240.50, totalCashValue: 24_600, buyingPower: 24_600,
    availableFunds: 24_600, grossPositionValue: 28_640.50,
  });
  const accounts = () => mode === "both" ? [account(false), account(true)] : [account(mode === "live")];
  const contract = demoContract("AAPL", instance.id);
  const defaultAccount = mode === "live" ? DEMO_LIVE_ACCOUNT : DEMO_SIM_ACCOUNT;
  const draft: BrokerOrderRequest = {
    brokerInstanceId: instance.id, accountId: defaultAccount, contract,
    action: "BUY", orderType: "LMT", quantity: 10, limitPrice: 336.50, tif: "DAY", outsideRth: false,
  };
  const quote = (symbol = "AAPL"): Quote => ({
    symbol, name: symbol === "AAPL" ? "Apple Inc." : "Synthetic security", providerId: DEMO_BROKER_ID,
    price: 336.42, bid: 336.40, ask: 336.50, bidSize: 200, askSize: 300,
    currency: "USD", change: 1.20, changePercent: 0.36, previousClose: 335.22,
    volume: 34_600_000, lastUpdated: now() - (options.quoteAgeMs ?? 15 * 60_000),
    lastTradeTime: now() - (options.quoteAgeMs ?? 15 * 60_000), receivedAt: now(),
    dataSource: "delayed", delivery: "poll", marketState: "REGULAR", sessionConfidence: "explicit",
  });
  const positions = (): BrokerPosition[] => accounts().map((value) => ({
    ticker: "AAPL", exchange: "NASDAQ", shares: 25, avgCost: 321.20, currency: "USD",
    accountId: value.accountId, assetCategory: "STK", markPrice: 336.42,
    marketValue: 8410.50, unrealizedPnl: 380.50, side: "long", brokerContract: contract,
  }));
  const order = (request: BrokerOrderRequest, status = "WORKING", id = nextOrderId++): BrokerOrder => ({
    orderId: id, brokerOrderId: `demo-order-${id}`, brokerInstanceId: instance.id,
    accountId: request.accountId, status, action: request.action, orderType: request.orderType,
    quantity: request.quantity, filled: status === "PARTIALLY_FILLED" ? 4 : status === "FILLED" ? request.quantity : 0,
    remaining: status === "PARTIALLY_FILLED" ? request.quantity - 4 : status === "FILLED" ? 0 : request.quantity,
    avgFillPrice: ["PARTIALLY_FILLED", "FILLED"].includes(status) ? 336.45 : undefined,
    limitPrice: request.limitPrice, stopPrice: request.stopPrice, tif: request.tif,
    updatedAt: now(), contract: request.contract,
    warningText: status === "REJECTED" ? "Insufficient buying power. Reduce the quantity and review again." : undefined,
  });
  const guard = (profile: BrokerInstanceConfig, request?: BrokerOrderRequest) => {
    if (!connected) throw new Error("Demo Broker is disconnected. Reconnect in Brokers.");
    if (!profile.config.tradingEnabled) throw new Error("Trading is off. Enable trading in Brokers before continuing.");
    if (request && !accounts().some((value) => value.accountId === request.accountId)) throw new Error("Choose an account before continuing.");
  };
  const preview = (request: BrokerOrderRequest): BrokerOrderPreview => {
    const value = request.quantity * (request.limitPrice ?? request.stopPrice ?? quote().ask!);
    const fees = 0.35;
    return {
      currency: "USD", estimatedCost: value, commission: 0, commissionCurrency: "USD", fees,
      buyingPowerBefore: 24_600, buyingPowerAfter: 24_600 - value - fees, buyingPowerImpact: value + fees,
      warnings: [], errors: options.previewError ? [options.previewError] : value > 24_600 ? ["Insufficient buying power. Reduce the quantity."] : [],
    };
  };
  if (options.seedOrders !== false) {
    const first = order(draft);
    first.updatedAt = now() - 120_000;
    orderBook.set(first.orderId, first);
    const second = order({ ...draft, quantity: 10, action: "SELL", limitPrice: 340 }, "PARTIALLY_FILLED");
    second.updatedAt = now() - 420_000;
    orderBook.set(second.orderId, second);
    executions.push({
      execId: "demo-fill-1", orderId: second.orderId, brokerOrderId: second.brokerOrderId,
      brokerInstanceId: instance.id, accountId: defaultAccount, side: "SELL", shares: 4,
      price: 340, time: now() - 360_000, exchange: "NASDAQ", commission: 0, commissionCurrency: "USD", contract,
    });
  }
  const adapter: BrokerAdapter = {
    id: DEMO_BROKER_ID, name: "Demo Broker",
    configSchema: [],
    async validate() { return connected; },
    async connect() { connected = true; },
    async disconnect() { connected = false; },
    getStatus() { return { state: connected ? "connected" : "disconnected", quoteData: "delayed", updatedAt: now() }; },
    async listAccounts() { calls.push({ method: "listAccounts" }); return accounts(); },
    async importPositions() { calls.push({ method: "importPositions" }); return positions(); },
    async importPortfolioSnapshot() { return { accounts: accounts(), positions: positions() }; },
    async getQuote(symbol) { calls.push({ method: "getQuote" }); if (!connected) throw new Error("Demo Broker is disconnected."); return quote(symbol); },
    getTradingCapabilities(profile) {
      return {
        enabled: profile.config.tradingEnabled === true,
        disabledReason: profile.config.tradingEnabled ? undefined : "Trading is off for this profile.",
        orderTypes: ["MKT", "LMT", "STP", "STP LMT"], tif: ["DAY", "GTC"],
        extendedHours: true, fractionalQuantity: true, minQuantity: 0.001, quantityStep: 0.001,
        priceDecimals: 2, modify: true, cancel: true, executionKind: "fills",
      };
    },
    getTradingConfigUpdate(_profile, enabled) { return { tradingEnabled: enabled }; },
    async previewOrder(profile, request) {
      guard(profile, request); calls.push({ method: "previewOrder", request: structuredClone(request) }); return preview(request);
    },
    async placeOrder(profile, request) {
      guard(profile, request); calls.push({ method: "placeOrder", request: structuredClone(request) });
      if (outcome === "unknown") throw new Error("The connection ended before the broker confirmed the order. Refresh to reconcile its status.");
      const status = ({ working: "WORKING", partial: "PARTIALLY_FILLED", filled: "FILLED", rejected: "REJECTED" } as const)[outcome];
      const result = order(request, status);
      orderBook.set(result.orderId, result);
      return structuredClone(result);
    },
    async modifyOrder(profile, orderId, request) {
      guard(profile, request); calls.push({ method: "modifyOrder", orderId, request: structuredClone(request) });
      if (!orderBook.has(orderId)) throw new Error("This demo order is no longer open.");
      if (outcome === "unknown") throw new Error("The replacement outcome is unknown. Refresh to reconcile the order.");
      const result = order(request, "WORKING", orderId);
      orderBook.set(orderId, result);
      return structuredClone(result);
    },
    async cancelOrder(profile, orderId) {
      guard(profile); calls.push({ method: "cancelOrder", orderId });
      const result = orderBook.get(orderId);
      if (!result) throw new Error("This demo order is no longer open.");
      if (outcome === "unknown") throw new Error("The cancellation outcome is unknown. Refresh to reconcile the order.");
      orderBook.set(orderId, { ...result, status: "PENDING_CANCEL", updatedAt: now() });
    },
    async listOpenOrders() {
      calls.push({ method: "listOpenOrders" });
      return structuredClone([...orderBook.values()].filter((value) => !["FILLED", "REJECTED", "CANCELED"].includes(value.status)));
    },
    async listExecutions() { calls.push({ method: "listExecutions" }); return structuredClone(executions); },
  };
  return {
    adapter, instance, accounts, quote, positions, draft, preview, order, calls,
    setOutcome(value: DemoOrderOutcome) { outcome = value; },
    setConnected(value: boolean) { connected = value; },
    setTradingEnabled(value: boolean) { instance.config.tradingEnabled = value; },
    seedOrder(value: BrokerOrder) { orderBook.set(value.orderId, structuredClone(value)); },
  };
}
