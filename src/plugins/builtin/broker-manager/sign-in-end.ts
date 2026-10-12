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
 * refreshed, and Gloom flags it a day before. Only that case shows anything: a
 * server that predates the flag, or a sign-in with no end in sight, adds nothing.
 */
export type SignInEnds = ReadonlyMap<string, number>;

/** When the broker ends the sign-in, if Gloom says it is time to connect again. */
export function signInEndOf(connection: Pick<SignedInBrokerConnection, "expiresAt" | "expiresSoon">): number | null {
  if (connection.expiresSoon !== true || !connection.expiresAt) return null;
  const endsAt = Date.parse(connection.expiresAt);
  return Number.isFinite(endsAt) ? endsAt : null;
}

/** The profile row's status, in the place of "Connected": "Ends Oct 10". */
export function signInEndStatus(endsAt: number, now = Date.now()): string {
  const date = formatShortDate(endsAt, { year: false });
  return endsAt > now ? tf("Ends {date}", { date }) : tf("Ended {date}", { date });
}

/** The profile detail's note: "Sign-in ends Oct 10, 2026 at 3:00 PM". */
export function signInEndNote(endsAt: number, now = Date.now()): string {
  const when = formatDetailDate(endsAt);
  return endsAt > now ? tf("Sign-in ends {when}", { when }) : tf("Sign-in ended {when}", { when });
}

/**
 * When each signed-in profile's sign-in ends, by instance id, for the profiles
 * whose broker is about to end it. Read from Gloom when the pane opens and
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
    const byInstance = new Map<string, number>();
    for (const profile of profiles) {
      const endsAt = data?.get(profile.broker);
      if (endsAt != null) byInstance.set(profile.id, endsAt);
    }
    return byInstance;
  }, [data, profiles]);
  const refresh = useCallback(() => { void reload(); }, [reload]);
  return { ends, reload: refresh };
}
