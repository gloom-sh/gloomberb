import { useCallback, useMemo, useSyncExternalStore } from "react";
import { apiClient } from "../../../api-client";
import { fetchSignedInBrokerConnection, type SignedInBrokerConnection } from "../../../brokers/signed-in/client";
import { isSignedInBrokerProfile, signedInBrokerId } from "../../../brokers/signed-in/profile";
import { tf } from "../../../i18n";
import { useAsyncResource } from "../../../react/async-resource";
import type { BrokerInstanceConfig } from "../../../types/config";
import { formatDetailDate, formatShortDate } from "../../../utils/datetime-format";

/**
 * Some brokers end a sign-in on their own clock, however often it was
 * refreshed (IBKR: seven days after consent). While such a sign-in is live the
 * pane always says when it ends, and Connect renews it early; Gloom flags the
 * last stretch (`soon`), when it is time to renew. A broker with no such
 * clock, or a sign-in that is not live, has no end to show.
 */
export interface SignInEnd {
  endsAt: number;
  /** Gloom says it is time to renew: within its warning window, or past the end. */
  soon: boolean;
}

export type SignInEnds = ReadonlyMap<string, SignInEnd>;

/** When the broker ends the live sign-in, and whether Gloom says to renew it now. */
export function signInEndOf(connection: Pick<SignedInBrokerConnection, "expiresAt" | "expiresSoon">): SignInEnd | null {
  if (!connection.expiresAt) return null;
  const endsAt = Date.parse(connection.expiresAt);
  return Number.isFinite(endsAt) ? { endsAt, soon: connection.expiresSoon === true } : null;
}

/** The profile row's status, in the place of "Connected": "Ends Oct 10". */
export function signInEndStatus(endsAt: number, now = Date.now()): string {
  const date = formatShortDate(endsAt, { year: false });
  return endsAt > now ? tf("Ends {date}", { date }) : tf("Ended {date}", { date });
}

/** The profile detail's note: "Sign-in ends Oct 10, 2026 at 3:00 PM EDT". */
export function signInEndNote(endsAt: number, now = Date.now()): string {
  const when = formatDetailDate(endsAt);
  return endsAt > now ? tf("Sign-in ends {when}", { when }) : tf("Sign-in ended {when}", { when });
}

/**
 * When each signed-in profile's sign-in ends, by instance id, for the profiles
 * whose broker ends it on a clock. Read from Gloom when the pane opens and
 * after a connect or sync; a failed read is the same as nothing to say.
 */
export function useSignInEnds(
  instances: readonly BrokerInstanceConfig[],
): { ends: SignInEnds; reload: () => void } {
  const profiles = useMemo(
    () => instances.flatMap((instance) => isSignedInBrokerProfile(instance) && instance.enabled !== false
      ? [{ id: instance.id, broker: signedInBrokerId(instance) }]
      : []),
    [instances],
  );
  // One read per broker, however many profiles name it.
  const brokers = useMemo(() => [...new Set(profiles.map((profile) => profile.broker).filter(Boolean))].sort(), [profiles]);
  const brokerKey = brokers.join(",");
  const signedIn = useSyncExternalStore(
    (listener) => apiClient.subscribeCurrentUser(listener),
    () => apiClient.isSignedIn(),
    () => apiClient.isSignedIn(),
  );
  const loader = useMemo(() => brokerKey && signedIn
    ? async () => {
      const reads = await Promise.all(brokerKey.split(",").map(async (broker) => {
        try {
          return [broker, signInEndOf(await fetchSignedInBrokerConnection(broker))] as const;
        } catch {
          return [broker, null] as const;
        }
      }));
      return new Map(reads);
    }
    : null, [brokerKey, signedIn]);
  const { data, reload } = useAsyncResource(loader, { keepPreviousData: true });

  const ends = useMemo<SignInEnds>(() => {
    const byInstance = new Map<string, SignInEnd>();
    for (const profile of profiles) {
      const end = data?.get(profile.broker);
      if (end) byInstance.set(profile.id, end);
    }
    return byInstance;
  }, [data, profiles]);
  const refresh = useCallback(() => { reload(); }, [reload]);
  return { ends, reload: refresh };
}
