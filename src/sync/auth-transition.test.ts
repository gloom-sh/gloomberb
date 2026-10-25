import { expect, test } from "bun:test";
import { subscribeToCloudVerification } from "./auth-transition";

test("restoring and refreshing a session preserves its baseline; switching accounts resets before syncing", () => {
  let account: string | null = null;
  let verified = false;
  const sessionIdentity = {};
  const listeners = new Set<() => void>();
  const events: string[] = [];
  const stop = subscribeToCloudVerification({
    getCurrentUser: () => account ? { id: account } : null,
    getVerifiedSessionIdentity: () => verified ? sessionIdentity : null,
    subscribeCurrentUser: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }, () => { events.push(`sync:${account}`); }, () => { events.push("reset"); });

  const publish = () => {
    for (const listener of listeners) listener();
  };

  publish();
  account = "account-a";
  publish();
  verified = true;
  publish();
  publish();
  expect(events).toEqual(["sync:account-a"]);

  // Some auth surfaces replace a verified user directly; others sign out first.
  account = "account-b";
  publish();
  publish();
  expect(events).toEqual(["sync:account-a", "reset", "sync:account-b"]);
  account = null;
  verified = false;
  publish();
  publish();
  account = "account-c";
  verified = true;
  publish();
  expect(events).toEqual(["sync:account-a", "reset", "sync:account-b", "reset", "sync:account-c"]);

  stop();
  account = "account-d";
  publish();
  expect(events).toHaveLength(5);
});
