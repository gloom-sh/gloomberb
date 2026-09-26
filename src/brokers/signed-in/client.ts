/**
 * Gloom Cloud's broker connections, under `/brokers`. Brokers whose connection
 * Cloud holds ("signed-in brokers") are described by the backend, so a new one
 * appears here without an app release.
 */
import { apiClient } from "../../api-client";
import type { BrokerOrderType } from "../../types/trading";

export interface SignedInBrokerCapabilities {
  history: boolean;
  executions: boolean;
  orders: false | { mode: "review" | "direct"; types: BrokerOrderType[] };
  /** Connecting Gloom replaces this broker's link to other AI apps. */
  singleConnection: boolean;
  /** Shown before connecting, e.g. an account the user must create first. */
  signupNote?: string;
}

export interface SignedInBroker {
  id: string;
  name: string;
  capabilities: SignedInBrokerCapabilities;
}

export interface SignedInBrokerConnection {
  broker: string;
  status: "connected" | "reauth_required" | "not_connected";
  scopes: string[];
  canTrade: boolean;
  accountIds: string[];
  connectedAt: string | null;
  refreshedAt: string | null;
  syncedAt: string | null;
}

/** Public: the list does not depend on the user, so Add Broker can show it signed out. */
export function listSignedInBrokers(): Promise<{ connectors: SignedInBroker[] }> {
  return apiClient.brokerRequest("connectors", "");
}

export function fetchSignedInBrokerConnection(brokerId: string): Promise<SignedInBrokerConnection> {
  return apiClient.brokerRequest(brokerId, "");
}

export function startSignedInBrokerConnect(
  brokerId: string,
  write: boolean,
): Promise<{ connectUrl: string; code: string; expiresAt: string }> {
  return apiClient.brokerRequest(brokerId, "/connect", { method: "POST", body: { write } });
}

export function disconnectSignedInBroker(brokerId: string): Promise<{ disconnected: boolean }> {
  return apiClient.brokerRequest(brokerId, "", { method: "DELETE" });
}
