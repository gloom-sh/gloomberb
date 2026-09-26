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
import type {
  BrokerAccount,
  BrokerExecution,
  BrokerOrder,
  BrokerOrderRequest,
  BrokerPortfolioPerformance,
} from "../../types/trading";
import { findSignedInBroker, refreshSignedInBrokers } from "./catalog";
import type { SignedInBroker, SignedInBrokerConnection } from "./client";
import { SIGNED_IN_BROKER_TYPE, signedInBrokerId } from "./profile";

const METHOD = "Sign in";

/** What to tell the user when Gloom answers a broker call with an error. */
export function describeSignedInBrokerError(error: unknown, brokerName: string): string {
  const status = error instanceof ApiRequestError ? error.status : undefined;
  if (status === 401) return `Sign in to Gloom first, then connect ${brokerName}.`;
  if (status === 404 || status === 409) return `${brokerName} needs you to sign in again. Press Connect in Brokers.`;
  if (status === 502) return `${brokerName} is not responding. Try again shortly.`;
  return error instanceof Error && error.message ? error.message : String(error);
}

function isUnsupported(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 422;
}

type BrokerRequest = <T>(
  broker: string,
  path: string,
  options?: { method?: "GET" | "POST" | "DELETE"; body?: unknown },
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

  const brokerName = (instance: BrokerInstanceConfig) =>
    deps.findBroker(signedInBrokerId(instance))?.name ?? instance.label;

  const setStatus = (instance: BrokerInstanceConfig, state: "connected" | "error", message?: string) => {
    statuses.set(instance.id, { state, message, mode: METHOD, updatedAt: deps.now() });
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

  /** A route the broker does not offer (422) is an empty answer, not a failure. */
  const getOptional = <T>(instance: BrokerInstanceConfig, path: string, fallback: T) =>
    track(instance, () => get<T>(instance, path).catch((error) => {
      if (isUnsupported(error)) return fallback;
      throw error;
    }));

  const snapshot = (instance: BrokerInstanceConfig) =>
    track(instance, () => get<PortfolioSnapshot>(instance, "/snapshot"));

  /** Checks an order against what the broker takes, before Gloom sees it. */
  const checkOrder = async (instance: BrokerInstanceConfig, request: BrokerOrderRequest) => {
    const id = signedInBrokerId(instance);
    let broker = deps.findBroker(id);
    if (!broker) {
      await deps.refreshBrokers();
      broker = deps.findBroker(id);
    }
    const name = broker?.name ?? instance.label;
    const orders = broker?.capabilities.orders;
    if (!orders) throw new Error(`${name} does not take orders from Gloom.`);
    if (!orders.types.includes(request.orderType)) {
      throw new Error(`${name} does not take ${request.orderType} orders from Gloom.`);
    }
    if (!(request.quantity > 0)) throw new Error("Quantity must be positive.");
    const needsLimit = request.orderType === "LMT" || request.orderType === "STP LMT";
    if (needsLimit && !(typeof request.limitPrice === "number" && request.limitPrice > 0)) {
      throw new Error("A limit order needs a limit price.");
    }
    return { name, mode: orders.mode };
  };

  return {
    id: SIGNED_IN_BROKER_TYPE,
    name: "Signed-in broker",
    configSchema: [],

    async validate() {
      return true;
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

    listOpenOrders(instance) {
      return getOptional<BrokerOrder[]>(instance, "/orders", []);
    },

    async previewOrder(instance, request) {
      const { name, mode } = await checkOrder(instance, request);
      return mode === "review" ? { warningText: `${name} opens this order for you to review and submit.` } : {};
    },

    async placeOrder(instance, request) {
      const { name } = await checkOrder(instance, request);
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

    async modifyOrder(instance) {
      const name = brokerName(instance);
      throw new Error(`Orders sent to ${name} are managed in ${name}.`);
    },

    async cancelOrder(instance) {
      const name = brokerName(instance);
      throw new Error(`Orders sent to ${name} are managed in ${name}.`);
    },

    async connect(instance) {
      await track(instance, async () => {
        const connection = await get<SignedInBrokerConnection>(instance, "");
        if (connection.status !== "connected") {
          throw new Error(`Press Connect in Brokers to sign in to ${brokerName(instance)}.`);
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
