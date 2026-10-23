/**
 * The built-in adapter behind every signed-in broker profile. The connection
 * lives in the Gloom account, so a profile only names the backend broker
 * (see `profile.ts`) and every call goes to Gloom.
 * This runs wherever broker adapters run, the desktop's Bun process included,
 * so it never opens the connect dialog: failures say what to press instead.
 */
import { apiClient } from "../../api-client";
import { ApiRequestError } from "../../api-client/errors";
import { openUrl } from "../../components/ui/external-link";
import type { BrokerAdapter, BrokerConnectionStatus, BrokerPosition } from "../../types/broker";
import type { BrokerInstanceConfig } from "../../types/config";
import type { Quote } from "../../types/financials";
import type {
  BrokerAccount,
  BrokerExecution,
  BrokerOrder,
  BrokerOrderPreview,
  BrokerOrderRequest,
  BrokerPortfolioPerformance,
  BrokerTradingCapabilities,
} from "../../types/trading";
import { findSignedInBroker, refreshSignedInBrokers } from "./catalog";
import type { SignedInBroker, SignedInBrokerConnection } from "./client";
import { SIGNED_IN_BROKER_TYPE, signedInBrokerId } from "./profile";

const METHOD = "Sign in";

/**
 * The message Gloom wrote for the client. The request error's own `message`
 * has the error code appended to it, so this reads the body's field first.
 */
function writtenMessage(error: ApiRequestError): string | null {
  const written = error.details?.message;
  if (typeof written === "string" && written.trim()) return written.trim();
  const { message, code } = error;
  const text = code && message.endsWith(` ${code}`) ? message.slice(0, -(code.length + 1)) : message;
  return text.trim() || null;
}

/**
 * Why the broker ended a sign-in, as Gloom stores it, without the OAuth code
 * in front: "invalid_grant: Authorization grant has expired" reads
 * "Authorization grant has expired".
 */
function brokerReason(lastError: string | null | undefined): string | null {
  const text = lastError?.trim();
  if (!text) return null;
  const described = /^[a-z_]+:\s*(\S[\s\S]*)$/.exec(text)?.[1] ?? text;
  return described.replace(/[\s.]+$/, "").slice(0, 200) || null;
}

/** What to tell the user when Gloom answers a broker call with an error. */
function describeSignedInBrokerError(error: unknown, brokerName: string): string {
  const status = error instanceof ApiRequestError ? error.status : undefined;
  if (status === 401) return `Sign in to Gloom first, then connect ${brokerName}.`;
  const signInAgain = `${brokerName} needs you to sign in again. Press Connect in Brokers.`;
  // A sign-in the broker ended says why, in Gloom's words.
  if (status === 409) return (error instanceof ApiRequestError && writtenMessage(error)) || signInAgain;
  if (status === 404) return signInAgain;
  if (status === 502) return `${brokerName} is not responding. Try again shortly.`;
  // A refused order or a busy broker says why without its error code.
  if (error instanceof ApiRequestError && (status === 403 || status === 422 || status === 503)) {
    return writtenMessage(error) ?? error.message;
  }
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Gloom answered an order action and nothing was placed, changed or
 * cancelled: the broker refused it, its check lapsed, trading is not granted,
 * the broker was too busy to take it, or the sign-in has to be renewed. A
 * 502 or a lost answer may have reached the broker, so it is not one.
 */
function refusedOrderAction(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  return error.status !== undefined && error.status >= 400 && error.status < 500 || error.status === 503;
}

/** A sign-in that ended or was never made, as opposed to a refused order: the profile's status says so. */
function signInLost(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  return error.status === 401 || error.status === 404 || error.status === 409 && error.code === "reauth_required";
}

function refused(message: string): Error {
  return Object.assign(new Error(message), { refused: true });
}

/** The broker does not offer this. A broker tool that failed is also a 422, but a failure. */
function isUnsupported(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 422 && error.code === "unsupported";
}

type BrokerRequest = <T>(
  broker: string,
  path: string,
  options?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
) => Promise<T>;

export interface SignedInBrokerAdapterDeps {
  request: BrokerRequest;
  findBroker(brokerId: string): SignedInBroker | null;
  refreshBrokers(): Promise<void>;
  openUrl(url: string): void;
  now(): number;
}

interface PortfolioSnapshot {
  accounts: BrokerAccount[];
  positions: BrokerPosition[];
  fetchedAt?: number;
}

/** Gloom's answer to a direct-mode order, before the user confirms it. */
interface DirectOrderPreview {
  status: "preview";
  previewId: string;
  expiresAt: string;
  impact: {
    source: "broker" | "unavailable";
    sourceLabel: string;
    currency?: string;
    estimatedCost?: number;
    cashBefore?: number;
    cashAfter?: number;
    commission?: number;
    fees?: number;
    disclosure: string;
  };
}

interface PlacedOrder { status: "placed"; order: BrokerOrder }

/** The quote a direct-mode broker gives the ticket. */
interface SignedInBrokerQuote {
  symbol: string;
  name?: string;
  currency?: string;
  price: number;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  lastTradePrice?: number;
  lastUpdated: number;
  dataSource: "live" | "delayed";
}

/** The same order always keys the same, whatever order its fields arrive in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The ticket's fields, without the profile's own, as Gloom checks and places the order. */
function orderBody(request: BrokerOrderRequest): BrokerOrderRequest {
  const { brokerInstanceId: _profile, ...body } = request;
  const { brokerInstanceId: _contractProfile, ...contract } = body.contract;
  return { ...body, contract };
}

const DIRECT_TIF = ["DAY"];

export function createSignedInBrokerAdapter(overrides: Partial<SignedInBrokerAdapterDeps> = {}): BrokerAdapter {
  const deps: SignedInBrokerAdapterDeps = {
    request: (broker, path, options) => apiClient.brokerRequest(broker, path, options),
    findBroker: findSignedInBroker,
    refreshBrokers: () => refreshSignedInBrokers(),
    openUrl,
    now: () => Date.now(),
    ...overrides,
  };
  const statuses = new Map<string, BrokerConnectionStatus>();
  const listeners = new Map<string, Set<() => void>>();
  /** Whether each profile's sign-in granted trading, as its last connect read it. */
  const canTrade = new Map<string, boolean>();
  /** Direct mode: the check the user is reviewing, per profile, by the exact order it was for. */
  const previews = new Map<string, { order: string; previewId: string; expiresAt: number }>();
  /** Direct mode: the broker's own id behind each order number the app holds, per profile. */
  const handles = new Map<string, Map<number, { accountId: string; brokerOrderId: string }>>();

  const brokerName = (instance: BrokerInstanceConfig) =>
    deps.findBroker(signedInBrokerId(instance))?.name ?? instance.label;

  /** The broker's direct-mode orders, or null for one that keeps orders for review or takes none. */
  const directOrders = (instance: BrokerInstanceConfig) => {
    const orders = deps.findBroker(signedInBrokerId(instance))?.capabilities.orders;
    return orders && orders.mode === "direct" ? orders : null;
  };

  const setStatus = (instance: BrokerInstanceConfig, state: "connected" | "error", message?: string) => {
    statuses.set(instance.id, {
      state, message, mode: METHOD, updatedAt: deps.now(),
      // A direct-mode broker says per quote whether it is real-time.
      ...(directOrders(instance) ? { quoteData: "realtime" as const } : {}),
    });
    for (const listener of listeners.get(instance.id) ?? []) listener();
  };

  /** Runs one call and records how it went, so the Brokers pane shows the last result. */
  const track = async <T>(instance: BrokerInstanceConfig, run: () => Promise<T>): Promise<T> => {
    try {
      const result = await run();
      setStatus(instance, "connected");
      return result;
    } catch (error) {
      const message = describeSignedInBrokerError(error, brokerName(instance));
      setStatus(instance, "error", message);
      throw new Error(message);
    }
  };

  const get = <T>(instance: BrokerInstanceConfig, path: string) =>
    deps.request<T>(signedInBrokerId(instance), path);

  /** A route the broker does not offer is an empty answer, not a failure. */
  const getOptional = <T>(instance: BrokerInstanceConfig, path: string, fallback: T) =>
    track(instance, () => get<T>(instance, path).catch((error) => {
      if (isUnsupported(error)) return fallback;
      throw error;
    }));

  const snapshot = (instance: BrokerInstanceConfig) =>
    track(instance, () => get<PortfolioSnapshot>(instance, "/snapshot"));

  /**
   * An order as the app holds it: this profile's, under this adapter, and
   * remembered by its number so a change or cancel can name it to the broker.
   */
  const ownOrder = (instance: BrokerInstanceConfig, order: BrokerOrder): BrokerOrder => {
    if (order.brokerOrderId && order.accountId) {
      const known = handles.get(instance.id) ?? new Map();
      known.set(order.orderId, { accountId: order.accountId, brokerOrderId: order.brokerOrderId });
      handles.set(instance.id, known);
    }
    return { ...order, brokerInstanceId: instance.id, contract: { ...order.contract, brokerId: SIGNED_IN_BROKER_TYPE, brokerInstanceId: instance.id } };
  };

  /**
   * One order action. A refusal leaves the profile's status alone (the
   * broker is fine; the order is not) and is marked refused; a sign-in that
   * ended shows on the profile as any failed call does.
   */
  const orderAction = async <T>(instance: BrokerInstanceConfig, run: () => Promise<T>): Promise<T> => {
    try {
      const result = await run();
      setStatus(instance, "connected");
      return result;
    } catch (error) {
      const message = describeSignedInBrokerError(error, brokerName(instance));
      if (signInLost(error)) setStatus(instance, "error", message);
      throw refusedOrderAction(error) ? refused(message) : new Error(message);
    }
  };

  /** The broker's id for an order number; nothing is sent when it cannot be found. */
  const brokerOrderHandle = async (instance: BrokerInstanceConfig, orderId: number) => {
    const known = handles.get(instance.id)?.get(orderId);
    if (known) return known;
    try {
      for (const order of await get<BrokerOrder[]>(instance, "/orders")) ownOrder(instance, order);
    } catch (error) {
      throw refused(describeSignedInBrokerError(error, brokerName(instance)));
    }
    const found = handles.get(instance.id)?.get(orderId);
    if (!found) throw refused("This order is no longer listed. Refresh your orders.");
    return found;
  };

  /** Checks an order against what the broker takes, before Gloom sees it: a failure sent nothing. */
  const checkOrder = async (instance: BrokerInstanceConfig, request: BrokerOrderRequest) => {
    const id = signedInBrokerId(instance);
    let broker = deps.findBroker(id);
    if (!broker) {
      await deps.refreshBrokers();
      broker = deps.findBroker(id);
    }
    const name = broker?.name ?? instance.label;
    const orders = broker?.capabilities.orders;
    if (!orders) throw refused(`${name} does not take orders from Gloom.`);
    if (!orders.types.includes(request.orderType)) {
      throw refused(`${name} does not take ${request.orderType} orders from Gloom.`);
    }
    // A server that does not say it takes a bracket, an OCO pair or a trailing stop would drop its fields and place a bare
    // order: never send one it has not named.
    if (!request.orderClass && (request.takeProfitPrice !== undefined || request.stopLossPrice !== undefined)) {
      throw refused("A take profit or stop loss needs a bracket or OCO order.");
    }
    if (request.orderClass && !orders.orderClasses?.includes(request.orderClass)) {
      throw refused(`${name} does not take ${request.orderClass === "oco" ? "OCO" : "bracket"} orders from Gloom.`);
    }
    if (request.orderType === "TRAIL" && !orders.trailing?.includes(request.trailingPercent !== undefined ? "percent" : "amount")) {
      throw refused(`${name} does not take this trailing stop from Gloom.`);
    }
    if (!(request.quantity > 0)) throw refused("Quantity must be positive.");
    const needsLimit = request.orderType === "LMT" || request.orderType === "STP LMT";
    if (needsLimit && !(typeof request.limitPrice === "number" && request.limitPrice > 0)) {
      throw refused("A limit order needs a limit price.");
    }
    return { name, mode: orders.mode };
  };

  return {
    id: SIGNED_IN_BROKER_TYPE,
    name: "Signed-in broker",
    configSchema: [],
    // A signed-in broker's quotes come through Gloom and count against the broker's allowance.
    ticketQuotesOnly: true,

    async validate() {
      return true;
    },

    // Nothing to save: the profile only names the broker. Onboarding asks every adapter.
    getPersistedConfigUpdate() {
      return null;
    },

    async importPortfolioSnapshot(instance) {
      const { accounts, positions } = await snapshot(instance);
      return { accounts, positions };
    },

    async importPositions(instance) {
      return (await snapshot(instance)).positions;
    },

    async listAccounts(instance) {
      return (await snapshot(instance)).accounts;
    },

    getPortfolioPerformance(instance, accountId) {
      return getOptional<BrokerPortfolioPerformance | null>(
        instance,
        `/performance?accountId=${encodeURIComponent(accountId)}`,
        null,
      );
    },

    listExecutions(instance) {
      return getOptional<BrokerExecution[]>(instance, "/executions?period=DAYS_90", []);
    },

    async listOpenOrders(instance) {
      return (await getOptional<BrokerOrder[]>(instance, "/orders", [])).map((order) => ownOrder(instance, order));
    },

    async previewOrder(instance, request) {
      const { name, mode } = await checkOrder(instance, request);
      if (mode === "review") return { warningText: `${name} opens this order for you to review and submit.` };
      const answer = await orderAction(instance, () => deps.request<DirectOrderPreview>(
        signedInBrokerId(instance),
        "/orders",
        { method: "POST", body: orderBody(request) },
      ));
      previews.set(instance.id, { order: canonical(orderBody(request)), previewId: answer.previewId, expiresAt: Date.parse(answer.expiresAt) });
      const { impact } = answer;
      const preview: BrokerOrderPreview = {
        impactSource: impact.source,
        impactSourceLabel: impact.sourceLabel,
        disclosure: impact.disclosure,
        currency: impact.currency,
        estimatedCost: impact.estimatedCost,
        commission: impact.commission,
        commissionCurrency: impact.commission === undefined ? undefined : impact.currency,
        fees: impact.fees,
        cashBefore: impact.cashBefore,
        cashAfter: impact.cashAfter,
      };
      return Object.fromEntries(Object.entries(preview).filter(([, value]) => value !== undefined)) as BrokerOrderPreview;
    },

    async placeOrder(instance, request) {
      const { name, mode } = await checkOrder(instance, request);
      if (mode === "direct") {
        // Only the order the user reviewed, while its check stands.
        const preview = previews.get(instance.id);
        if (!preview || preview.order !== canonical(orderBody(request)) || !(preview.expiresAt > deps.now())) {
          throw refused("Review this order again before placing it.");
        }
        const placed = await orderAction(instance, () => deps.request<PlacedOrder>(
          signedInBrokerId(instance),
          "/orders",
          { method: "POST", body: { ...orderBody(request), previewId: preview.previewId } },
        ));
        previews.delete(instance.id);
        return ownOrder(instance, placed.order);
      }
      const placed = await track(instance, () => deps.request<{ status: string; id: string; reviewUrl: string }>(
        signedInBrokerId(instance),
        "/orders",
        { method: "POST", body: request },
      ));
      if (placed.reviewUrl) deps.openUrl(placed.reviewUrl);
      return {
        orderId: 0,
        brokerInstanceId: instance.id,
        accountId: request.accountId,
        status: "PendingReview",
        action: request.action,
        orderType: request.orderType,
        quantity: request.quantity,
        filled: 0,
        remaining: request.quantity,
        limitPrice: request.limitPrice,
        stopPrice: request.stopPrice,
        tif: request.tif,
        warningText: `Review and submit this order in ${name}.`,
        reviewUrl: placed.reviewUrl,
        updatedAt: deps.now(),
        contract: request.contract,
      };
    },

    async modifyOrder(instance, orderId, request) {
      const { name, mode } = await checkOrder(instance, request);
      if (mode !== "direct") throw refused(`Orders sent to ${name} are managed in ${name}.`);
      const handle = await brokerOrderHandle(instance, orderId);
      const changed = await orderAction(instance, () => deps.request<PlacedOrder>(
        signedInBrokerId(instance),
        `/orders/${encodeURIComponent(handle.brokerOrderId)}`,
        { method: "PUT", body: { ...orderBody(request), accountId: handle.accountId } },
      ));
      return ownOrder(instance, changed.order);
    },

    async cancelOrder(instance, orderId) {
      const name = brokerName(instance);
      if (!directOrders(instance)) throw refused(`Orders sent to ${name} are managed in ${name}.`);
      const handle = await brokerOrderHandle(instance, orderId);
      await orderAction(instance, () => deps.request<{ cancelled: boolean }>(
        signedInBrokerId(instance),
        `/orders/${encodeURIComponent(handle.brokerOrderId)}?accountId=${encodeURIComponent(handle.accountId)}`,
        { method: "DELETE" },
      ));
    },

    /**
     * Direct mode only: what the ticket offers. Trading needs the profile
     * switched on and a sign-in that granted it; the broker's linked
     * account may still be read-only, which its check then says.
     */
    getTradingCapabilities(instance) {
      const name = brokerName(instance);
      const orders = directOrders(instance);
      if (!orders) {
        return { enabled: false, disabledReason: `${name} does not take orders from the ticket.`, orderTypes: [], tif: [] };
      }
      const granted = canTrade.get(instance.id) === true;
      const switchedOn = instance.config.tradingEnabled === true;
      const capabilities: BrokerTradingCapabilities = {
        enabled: granted && switchedOn,
        orderTypes: [...orders.types],
        tif: orders.tif?.length ? [...orders.tif] : DIRECT_TIF,
        ...(orders.orderClasses?.length ? { orderClasses: [...orders.orderClasses] } : {}),
        ...(orders.trailing?.length ? { trailing: [...orders.trailing] } : {}),
        minQuantity: 1,
        quantityStep: 1,
        modify: true,
        cancel: true,
        executionKind: "order-summaries",
      };
      if (!granted) capabilities.disabledReason = `${name} is connected read-only. Connect it again in Brokers to allow trading.`;
      else if (!switchedOn) capabilities.disabledReason = "Trading is off for this profile.";
      return capabilities;
    },

    getTradingConfigUpdate(_instance, enabled) {
      return { tradingEnabled: enabled };
    },

    // The ticket's quote. A symbol the broker cannot price, or its request
    // allowance spent, is the ticket's to say; only a lost sign-in is the profile's.
    async getQuote(ticker, instance) {
      const id = signedInBrokerId(instance);
      if (!directOrders(instance)) throw new Error(`${brokerName(instance)} gives no quotes to the ticket.`);
      const answer = await orderAction(instance, () => deps.request<SignedInBrokerQuote>(
        id,
        `/quote?symbol=${encodeURIComponent(ticker.trim().toUpperCase())}`,
      ));
      const quote: Quote = {
        symbol: answer.symbol,
        name: answer.name,
        price: answer.price,
        bid: answer.bid,
        ask: answer.ask,
        bidSize: answer.bidSize,
        askSize: answer.askSize,
        currency: answer.currency ?? "USD",
        // The broker gives no prior close: no change to show.
        change: Number.NaN,
        changePercent: Number.NaN,
        changeBasis: "none",
        lastUpdated: answer.lastUpdated,
        receivedAt: deps.now(),
        dataSource: answer.dataSource,
        delivery: "poll",
        providerId: id,
      };
      return quote;
    },

    async connect(instance) {
      await track(instance, async () => {
        const connection = await get<SignedInBrokerConnection>(instance, "");
        canTrade.set(instance.id, connection.status === "connected" && connection.canTrade === true);
        if (connection.status !== "connected") {
          const name = brokerName(instance);
          const reason = brokerReason(connection.lastError);
          throw new Error(reason
            ? `${name} needs you to sign in again: ${reason}. Press Connect in Brokers.`
            : `Press Connect in Brokers to sign in to ${name}.`);
        }
      });
    },

    // The connection is shared by every device and agent, so this device lets go of nothing.
    async disconnect() {},

    getStatus(instance) {
      return statuses.get(instance.id) ?? { state: "disconnected", mode: METHOD, updatedAt: 0 };
    },

    subscribeStatus(instance, listener) {
      const set = listeners.get(instance.id) ?? new Set();
      set.add(listener);
      listeners.set(instance.id, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(instance.id);
      };
    },

    canStreamQuotes() {
      return false;
    },

    // Renaming a profile keeps the broker it names.
    fromConfigValues(_values, previous) {
      return { ...(previous?.config ?? {}) };
    },

    describeInstance(instance) {
      return { brokerName: brokerName(instance), method: METHOD };
    },

    portfolioBrokerId(instance) {
      return signedInBrokerId(instance) || instance.brokerType;
    },
  };
}

export const signedInBrokerAdapter = createSignedInBrokerAdapter();
