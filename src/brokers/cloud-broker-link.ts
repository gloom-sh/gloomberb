import { apiClient } from "../api-client";

/**
 * A broker connection that lives in the user's Gloom Cloud account rather than
 * on this device. Some brokers allow one API connection per user, so Cloud
 * holds it once and every Gloom surface, including the user's own agents over
 * Gloom MCP, goes through it.
 */
export interface CloudBrokerLink {
  /** Whether this device has a Cloud session to make the request with. */
  isSignedIn(): boolean;
  /**
   * Calls `/brokers/{broker}{path}` with the Cloud session. Failures throw an
   * error carrying the HTTP `status`.
   */
  request<T>(
    broker: string,
    path: string,
    options?: { method?: "GET" | "POST" | "DELETE"; body?: unknown; signal?: AbortSignal },
  ): Promise<T>;
}

export const cloudBrokerLink: CloudBrokerLink = {
  isSignedIn: () => apiClient.isSignedIn(),
  request: (broker, path, options) => apiClient.brokerRequest(broker, path, options),
};
