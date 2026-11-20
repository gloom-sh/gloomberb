import { apiClient } from "../api-client";
import { cloudDisplayScope } from "../api-client/plan-access";
import { hasProAccess } from "../api-client/plan-rules";
import type { NewsSessionSignal } from "./aggregator";

export function cloudNewsSnapshotScope(): string | null {
  if (apiClient.isChangingSession() || apiClient.isCookieIdentityUnavailable()) return null;
  const user = apiClient.getCurrentUser();
  if (user && apiClient.getConfirmedDisplayUser() !== user) return null;
  return cloudDisplayScope();
}

/**
 * What decides which news Gloom Cloud answers with: whether requests carry a
 * session, whose it is, and whether that account has real-time news. Changes
 * when the session is restored at launch, on sign-in and sign-out, and when
 * the plan changes.
 */
export const cloudNewsSession: NewsSessionSignal = {
  key() {
    const user = apiClient.getCurrentUser();
    return [
      apiClient.hasSessionCredential() ? "session" : "none",
      user?.id ?? "",
      hasProAccess(user) ? "realtime" : "delayed",
    ].join(":");
  },
  subscribe: (listener) => apiClient.subscribeCurrentUser(listener),
};
