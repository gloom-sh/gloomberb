/**
 * Gloom Cloud's broker connections, under `/brokers`. Brokers whose connection
 * Cloud holds ("signed-in brokers") are described by the backend, so a new one
 * appears here without an app release.
 */
import { apiClient } from "../../api-client";
import type { BrokerOrderType } from "../../types/trading";

interface SignedInBrokerCapabilities {
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
  /**
   * When the broker ends this sign-in on its own clock, however often it was
   * refreshed. Set only while connected and only for a broker that does so.
   * The three fields below are absent from a Gloom server that predates them.
   */
  expiresAt?: string | null;
  /** Within a day of `expiresAt`, or past it: time to connect again. */
  expiresSoon?: boolean;
  /** Why the broker ended the sign-in, in its own words. Null while connected. */
  lastError?: string | null;
}

/** Public: the list does not depend on the user, so Add Broker can show it signed out. */
export function listSignedInBrokers(): Promise<{ connectors: SignedInBroker[] }> {
  return apiClient.brokerRequest("connectors", "");
}

export function fetchSignedInBrokerConnection(brokerId: string): Promise<SignedInBrokerConnection> {
  return apiClient.brokerRequest(brokerId, "");
}

/**
 * Opens a connect ticket. This app shows no code: it asks for a ticket that
 * only the account's own Gloom session in the browser can continue. A Cloud
 * that predates that still answers with a code, which the dialog then shows.
 */
export function startSignedInBrokerConnect(
  brokerId: string,
  write: boolean,
): Promise<{ connectUrl: string; code?: string | null; expiresAt: string }> {
  return apiClient.brokerRequest(brokerId, "/connect", { method: "POST", body: { write, code: false } });
}

export function disconnectSignedInBroker(brokerId: string): Promise<{ disconnected: boolean }> {
  return apiClient.brokerRequest(brokerId, "", { method: "DELETE" });
}
