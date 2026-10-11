import type { PersistedAuthUser } from "../api-client";

/** Session persistence and realtime wiring supplied by the host's session owner. */
interface AccountSession {
  adoptSession(sessionToken: string, user: PersistedAuthUser): void;
  refreshSession(): Promise<void>;
}

// The session owner registers its singleton during module initialization, before
// any host renders an account surface. Keep the object so method calls retain
// their receiver and use the same session state as boot restoration.
export let accountSession: AccountSession;

export function registerAccountSession(session: AccountSession): void {
  accountSession = session;
}
