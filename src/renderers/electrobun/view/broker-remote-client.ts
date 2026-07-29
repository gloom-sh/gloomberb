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
import { backendRequest, onCapabilityEvent } from "./backend-rpc";

const statuses = new Map<string, BrokerConnectionStatus>();
const statusSubscriptions = new Map<string, StatusSubscription>();
const STATUS_SUBSCRIPTION_TEARDOWN_DELAY_MS = 250;
let nextSubscriptionId = 1;

type StatusSubscription = {
  subscriptionId: string;
  listeners: Set<() => void>;
  disposeEvents: () => void;
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

async function subscribeBrokerCapability(
  subscriptionId: string,
  operationId: string,
  payload: unknown,
): Promise<void> {
  await backendRequest("capability.subscribe", {
    subscriptionId,
    capabilityId: BROKER_CAPABILITY_ID,
    operationId,
    payload,
  });
}

function disposeStatusSubscription(instanceId: string, entry: StatusSubscription): void {
  if (statusSubscriptions.get(instanceId) !== entry) return;
  entry.disposeEvents();
  if (entry.teardownTimer) clearTimeout(entry.teardownTimer);
  statusSubscriptions.delete(instanceId);
  void backendRequest("capability.unsubscribe", { subscriptionId: entry.subscriptionId }).catch(() => {});
}

function getStatusSubscription(instanceId: string): StatusSubscription {
  const current = statusSubscriptions.get(instanceId);
  if (current) return current;

  const subscriptionId = `broker-status:${instanceId}:${nextSubscriptionId++}`;
  const entry: StatusSubscription = {
    subscriptionId,
    listeners: new Set(),
    disposeEvents: () => {},
    teardownTimer: null,
  };
  entry.disposeEvents = onCapabilityEvent(subscriptionId, (message) => {
    const event = message.event as BrokerRemoteEvent;
    if (!isBrokerStatusEvent(event)) return;
    statuses.set(event.instanceId, event.status);
    for (const listener of entry.listeners) {
      listener();
    }
  });
  statusSubscriptions.set(instanceId, entry);

  void subscribeBrokerCapability(subscriptionId, "status", { instanceId }).catch((error) => {
    disposeStatusSubscription(instanceId, entry);
    console.error("Failed to subscribe to broker status", error);
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
    const subscriptionId = `broker-quotes:${instanceId}:${nextSubscriptionId++}`;
    const disposeEvents = onCapabilityEvent(subscriptionId, (message) => {
      const event = message.event as BrokerRemoteEvent;
      if (!isBrokerQuoteEvent(event)) return;
      onQuote(event.target, event.quote);
    });
    void subscribeBrokerCapability(subscriptionId, "quotes", { instanceId, targets }).catch((error) => {
      disposeEvents();
      console.error("Failed to subscribe to broker quotes", error);
    });
    return () => {
      disposeEvents();
      void backendRequest("capability.unsubscribe", { subscriptionId }).catch(() => {});
    };
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
