import {
  setBrokerRemoteClient,
  type BrokerRemoteClient,
} from "../../../brokers/remote-broker-adapter";
import {
  BROKER_CAPABILITY_ID,
  type BrokerQuoteEvent,
  type BrokerRemoteEvent,
  type BrokerStatusEvent,
} from "../../../capabilities";
import type { BrokerConnectionStatus } from "../../../types/broker";
import { backendRequest, subscribeBackendCapability } from "./backend-rpc";
import { unpackQuoteEvents } from "../shared/quote-event-batch";

const statuses = new Map<string, BrokerConnectionStatus>();
const statusSubscriptions = new Map<string, StatusSubscription>();
const STATUS_SUBSCRIPTION_TEARDOWN_DELAY_MS = 250;
let nextSubscriptionId = 1;

type StatusSubscription = {
  listeners: Set<() => void>;
  dispose: () => void;
  teardownTimer: ReturnType<typeof setTimeout> | null;
};

function isBrokerStatusEvent(event: BrokerRemoteEvent): event is BrokerStatusEvent {
  return event.kind === "status";
}

function isBrokerQuoteEvent(event: BrokerRemoteEvent): event is BrokerQuoteEvent {
  return event.kind === "quote";
}

function invokeBrokerCapability<T>(operationId: string, payload: unknown): Promise<T> {
  return backendRequest<T>("capability.invoke", {
    capabilityId: BROKER_CAPABILITY_ID,
    operationId,
    payload,
  });
}

function disposeStatusSubscription(instanceId: string, entry: StatusSubscription): void {
  if (statusSubscriptions.get(instanceId) !== entry) return;
  entry.dispose();
  if (entry.teardownTimer) clearTimeout(entry.teardownTimer);
  statusSubscriptions.delete(instanceId);
}

function getStatusSubscription(instanceId: string): StatusSubscription {
  const current = statusSubscriptions.get(instanceId);
  if (current) return current;

  const entry: StatusSubscription = {
    listeners: new Set(),
    dispose: () => {},
    teardownTimer: null,
  };
  statusSubscriptions.set(instanceId, entry);
  entry.dispose = subscribeBackendCapability({
    subscriptionId: `broker-status:${instanceId}:${nextSubscriptionId++}`,
    capabilityId: BROKER_CAPABILITY_ID,
    operationId: "status",
    payload: { instanceId },
    onEvent: (message) => {
      const event = message as BrokerRemoteEvent;
      if (!isBrokerStatusEvent(event)) return;
      statuses.set(event.instanceId, event.status);
      for (const listener of entry.listeners) {
        listener();
      }
    },
    onError: (error) => {
      disposeStatusSubscription(instanceId, entry);
      console.error("Failed to subscribe to broker status", error);
    },
  });

  return entry;
}

const client: BrokerRemoteClient = {
  invoke(operationInstanceId, operation, args = []) {
    return invokeBrokerCapability("invoke", {
      instanceId: operationInstanceId,
      operation,
      args,
    });
  },

  getStatus(instanceId) {
    return statuses.get(instanceId) ?? null;
  },

  subscribeStatus(instanceId, listener) {
    const entry = getStatusSubscription(instanceId);
    if (entry.teardownTimer) {
      clearTimeout(entry.teardownTimer);
      entry.teardownTimer = null;
    }
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size > 0 || entry.teardownTimer) return;
      entry.teardownTimer = setTimeout(() => {
        entry.teardownTimer = null;
        if (entry.listeners.size === 0) {
          disposeStatusSubscription(instanceId, entry);
        }
      }, STATUS_SUBSCRIPTION_TEARDOWN_DELAY_MS);
    };
  },

  subscribeQuotes(instanceId, targets, onQuote) {
    return subscribeBackendCapability({
      subscriptionId: `broker-quotes:${instanceId}:${nextSubscriptionId++}`,
      capabilityId: BROKER_CAPABILITY_ID,
      operationId: "quotes",
      payload: { instanceId, targets },
      onEvent: (message) => {
        for (const event of unpackQuoteEvents(message).events as BrokerRemoteEvent[]) {
          if (isBrokerQuoteEvent(event)) onQuote(event.target, event.quote);
        }
      },
      onError: (error) => console.error("Failed to subscribe to broker quotes", error),
    });
  },

  async removeInstance(instanceId) {
    await invokeBrokerCapability("removeInstance", { instanceId });
    statuses.delete(instanceId);
  },

  async destroyAll() {
    await invokeBrokerCapability("destroyAll", {});
    statuses.clear();
  },
};

export function installElectrobunBrokerRemoteClient(): void {
  setBrokerRemoteClient(client);
}
