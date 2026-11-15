import { useCallback, useEffect, useRef, useState } from "react";
import type { apiClient } from "../../../../api-client";
import type { WaitlistProduct, WaitlistState } from "../../../../api-client/product-waitlist";
import { errorMessage } from "../../../../utils/errors";

/** The waitlist calls the tab makes; tests hand it their own. */
export type WaitlistClient = Pick<typeof apiClient, "getWaitlist" | "joinWaitlist" | "leaveWaitlist">;

export interface ProductWaitlist {
  /** Whether the signed-in account is on the list; undefined until its read answers, or signed out. */
  joined: boolean | undefined;
  /** The account's place is being read. */
  loading: boolean;
  /** Why the read failed; null otherwise. */
  error: string | null;
  /** A join or a leave on its way. */
  pending: "join" | "leave" | null;
  /** Reads the account's place again. */
  retry(): void;
  /**
   * Joins or leaves for `account`, the one the person decided as. Nothing is
   * sent when another account holds the session by now, and an answer that
   * lands after the account changed is not shown: null in both cases.
   */
  change(joined: boolean, account: string): Promise<WaitlistState | null>;
}

interface Snapshot {
  account: string | null;
  joined: boolean | undefined;
  error: string | null;
  pending: "join" | "leave" | null;
}

function fresh(account: string | null): Snapshot {
  return { account, joined: undefined, error: null, pending: null };
}

/**
 * The signed-in account's place on a product's waitlist. Everything is the
 * account's: a sign-in, a sign-out or another account starts from nothing at
 * once, and no answer for the account that left is shown for the next one.
 * A read that was already out when a join or a leave began is dropped, so it
 * cannot put back the state from before the change.
 */
export function useProductWaitlist(client: WaitlistClient, product: WaitlistProduct, account: string | null): ProductWaitlist {
  const [stored, setStored] = useState<Snapshot>(() => fresh(account));
  const [reads, setReads] = useState(0);
  const accountRef = useRef(account);
  accountRef.current = account;
  // Bumped by every change: a read that began before it answers too late.
  const changes = useRef(0);
  // The account a change is on its way for; a second press waits for it.
  const changing = useRef<string | null>(null);

  const snapshot = stored.account === account ? stored : fresh(account);
  if (snapshot !== stored) setStored(snapshot);

  const update = useCallback((forAccount: string, patch: Partial<Snapshot>) => {
    setStored((current) => (current.account === forAccount ? { ...current, ...patch } : current));
  }, []);

  useEffect(() => {
    if (!account) return;
    let live = true;
    const since = changes.current;
    const current = () => live && accountRef.current === account && changes.current === since;
    client.getWaitlist(product).then((state) => {
      if (current()) update(account, { joined: state.joined, error: null });
    }, (error: unknown) => {
      if (current()) update(account, { error: errorMessage(error) });
    });
    return () => { live = false; };
  }, [account, client, product, reads, update]);

  const retry = useCallback(() => {
    if (accountRef.current) update(accountRef.current, { error: null });
    setReads((count) => count + 1);
  }, [update]);

  const change = useCallback(async (joined: boolean, forAccount: string): Promise<WaitlistState | null> => {
    if (accountRef.current !== forAccount || changing.current === forAccount) return null;
    changing.current = forAccount;
    changes.current += 1;
    update(forAccount, { pending: joined ? "join" : "leave" });
    try {
      const state = joined ? await client.joinWaitlist(product) : await client.leaveWaitlist(product);
      if (accountRef.current !== forAccount) return null;
      update(forAccount, { joined: state.joined, error: null, pending: null });
      return state;
    } catch (error) {
      if (accountRef.current === forAccount) {
        update(forAccount, { pending: null });
        // The read this change dropped is asked again, so the state is known.
        setReads((count) => count + 1);
      }
      throw error;
    } finally {
      if (changing.current === forAccount) changing.current = null;
    }
  }, [client, product, update]);

  return {
    joined: snapshot.joined,
    loading: !!account && snapshot.joined === undefined && snapshot.error === null,
    error: snapshot.error,
    pending: snapshot.pending,
    retry,
    change,
  };
}
