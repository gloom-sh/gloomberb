import { useCallback, useState, useSyncExternalStore } from "react";
import { apiClient } from "../../../api-client";
import { cloudDisplayScope } from "../../../api-client/plan-access";
import { currentHoldingsSession, type HoldingsSession } from "./api";

/**
 * What a pane shows of 13F books is the sign-in's it was read in. The scope
 * key names that sign-in (the holdings session a read is bound to, its
 * credential's generation among it: a count, never the credential) and the
 * account and plan the pane shows it under; a read started now carries the
 * key of now, and what it shows is the pane's only while that key is.
 */
function scopeKey(session: HoldingsSession, display: string | null): string {
  return JSON.stringify([session.session, session.changes, session.credential, display]);
}

const liveScopeKey = () => scopeKey(currentHoldingsSession(), cloudDisplayScope());

/** A pane's 13F read: the sign-in it is bound to (loadFundDetail's `session`) and the key what it shows is kept under. */
interface ScopedRead {
  session: HoldingsSession;
  key: string;
}

/** Starts a pane's 13F read in the reader's sign-in now. */
export function beginScopedRead(): ScopedRead {
  const session = currentHoldingsSession();
  return { session, key: scopeKey(session, cloudDisplayScope()) };
}

/**
 * The reader's scope key, rendered again on every sign-in, credential, account
 * or plan change, a credential replaced before its account is known as well: a
 * load that depends on it reruns.
 */
export function useHoldingsScopeKey(): string {
  return useSyncExternalStore((onChange) => apiClient.subscribeCurrentUser(onChange), liveScopeKey, liveScopeKey);
}

/**
 * What a pane shows of a 13F read, kept under the key of the read that made it
 * (`show(read.key, ...)`). Under any other key it is not shown: from the first
 * render after a sign-in change, while the read that replaces it is out, and
 * when that read fails. A part a read sends after the reader's key moved on is
 * dropped, never kept for later.
 */
export function useScopedShown<T>(key: string): readonly [T | null, (readKey: string, next: (current: T | null) => T | null) => void] {
  const [state, setState] = useState<{ key: string; value: T } | null>(null);
  const show = useCallback((readKey: string, next: (current: T | null) => T | null) => {
    if (readKey !== liveScopeKey()) return;
    setState((current) => {
      const value = next(current?.key === readKey ? current.value : null);
      return value == null ? null : { key: readKey, value };
    });
  }, []);
  return [state?.key === key ? state.value : null, show] as const;
}
