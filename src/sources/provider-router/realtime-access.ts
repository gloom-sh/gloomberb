import { apiClient } from "../../api-client";
import { hasProAccess, resolveTrialEndsAt, type PlanAccessUser } from "../../api-client/plan-rules";

/** Whether the account receives real-time cloud quotes, and when that changes. */
export interface RealtimeCloudAccess {
  has(): boolean;
  subscribe?(listener: () => void): () => void;
}

interface CurrentUserSource {
  getCurrentUser(): PlanAccessUser | null;
  subscribeCurrentUser(listener: () => void): () => void;
}

/** Timers past this many milliseconds fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * The signed-in account's real-time cloud entitlement, by the same plan rule
 * the panes show. The server enforces the real entitlement; this only decides
 * when a delayed broker yields to the cloud. Listeners hear about session
 * changes and about a trial running out, which the session itself never reports.
 */
export function createSignedInRealtimeCloudAccess(source: CurrentUserSource = apiClient): RealtimeCloudAccess {
  const listeners = new Set<() => void>();
  let unsubscribeUser: (() => void) | null = null;
  let trialTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTrialTimer = () => {
    if (trialTimer !== null) clearTimeout(trialTimer);
    trialTimer = null;
  };
  const scheduleTrialEnd = () => {
    clearTrialTimer();
    const trialEndsAt = resolveTrialEndsAt(source.getCurrentUser());
    if (trialEndsAt === null) return;
    const delay = trialEndsAt.getTime() - Date.now();
    if (delay <= 0) return;
    trialTimer = setTimeout(notify, Math.min(delay + 1_000, MAX_TIMER_DELAY_MS));
    (trialTimer as { unref?: () => void }).unref?.();
  };
  function notify() {
    scheduleTrialEnd();
    for (const listener of [...listeners]) listener();
  }

  return {
    has: () => hasProAccess(source.getCurrentUser()),
    subscribe(listener) {
      listeners.add(listener);
      if (!unsubscribeUser) {
        unsubscribeUser = source.subscribeCurrentUser(notify);
        scheduleTrialEnd();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        unsubscribeUser?.();
        unsubscribeUser = null;
        clearTrialTimer();
      };
    },
  };
}
