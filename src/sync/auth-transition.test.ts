import { expect, test } from "bun:test";
import { subscribeToCloudVerification } from "./auth-transition";

test("suspension retains merge history until a different account is verified", () => {
  let account: string | null = null;
  let verified = false;
  const sessionIdentity = {};
  const listeners = new Set<() => void>();
  const events: string[] = [];
  const stop = subscribeToCloudVerification({
    getCurrentUser: () => account ? { id: account } : null,
    isSignedIn: () => account !== null,
    getVerifiedSessionIdentity: () => verified ? sessionIdentity : null,
    subscribeCurrentUser: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }, () => { events.push(`sync:${account}`); },
  (id) => { events.push(`reset:${id}`); }, () => { events.push("suspend"); });
  const publish = () => { for (const listener of listeners) listener(); };

  publish();
  account = "account-a";
  publish();
  verified = true;
  publish();
  publish();
  expect(events.splice(0)).toEqual(["sync:account-a"]);

  account = null;
  verified = false;
  publish();
  publish();
  expect(events.splice(0)).toEqual(["suspend"]);
  account = "account-a";
  verified = true;
  publish();
  expect(events.splice(0)).toEqual(["sync:account-a"]);

  // An unconfirmed replacement cannot discard the previous account's edits.
  verified = false;
  account = "account-b";
  publish();
  expect(events.splice(0)).toEqual(["suspend"]);
  verified = true;
  publish();
  publish();
  expect(events.splice(0)).toEqual(["reset:account-b", "sync:account-b"]);

  // Some auth surfaces replace a verified user without a sign-out event.
  account = "account-c";
  publish();
  expect(events.splice(0)).toEqual(["reset:account-c", "sync:account-c"]);
  stop();
  account = "account-d";
  publish();
  expect(events).toEqual([]);
});
