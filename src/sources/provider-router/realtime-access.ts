import { apiClient, type AuthUser } from "../../api-client";

/** Whether the account receives real-time cloud quotes, and when that changes. */
export interface RealtimeCloudAccess {
  has(): boolean;
  subscribe?(listener: () => void): () => void;
}

type EntitledUser = Pick<AuthUser, "emailVerified" | "plan" | "effectivePlan" | "trialEndsAt">;

interface CurrentUserSource {
  getCurrentUser(): EntitledUser | null;
  subscribeCurrentUser(listener: () => void): () => void;
}

/** Timers past this many milliseconds fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function trialEndTime(user: EntitledUser | null | undefined): number | null {
  if (!user?.trialEndsAt) return null;
  const endsAt = new Date(user.trialEndsAt).getTime();
  return Number.isFinite(endsAt) ? endsAt : null;
}

/**
 * Real-time cloud entitlement: a verified account on the paid plan or in a
 * running trial. Same rule as the panes' plan helpers, kept free of UI code
 * so the router can use it in every build. The server enforces the real
 * entitlement; this only decides when a delayed broker yields to the cloud.
 */
export function hasRealtimeCloudEntitlement(user: EntitledUser | null | undefined, now = Date.now()): boolean {
  if (user?.emailVerified !== true) return false;
  if (user.plan === "pro") return true;
  const trialEndsAt = trialEndTime(user);
  if (trialEndsAt !== null && trialEndsAt > now) return true;
  return user.effectivePlan === "pro" && !user.trialEndsAt;
}

/**
 * The signed-in account's entitlement. Listeners hear about session changes
 * and about a trial running out, which the session itself never reports.
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
    const trialEndsAt = trialEndTime(source.getCurrentUser());
    if (trialEndsAt === null) return;
    const delay = trialEndsAt - Date.now();
    if (delay <= 0) return;
    trialTimer = setTimeout(notify, Math.min(delay + 1_000, MAX_TIMER_DELAY_MS));
    (trialTimer as { unref?: () => void }).unref?.();
  };
  function notify() {
    scheduleTrialEnd();
    for (const listener of [...listeners]) listener();
  }

  return {
    has: () => hasRealtimeCloudEntitlement(source.getCurrentUser()),
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
