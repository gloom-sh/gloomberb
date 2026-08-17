import { expect, test } from "bun:test";
import { subscribeToCloudVerification } from "./auth-transition";

test("starts sync only for an unverified session's verification transition", () => {
  let verified = false;
  const listeners = new Set<() => void>();
  const syncReasons: string[] = [];
  const stop = subscribeToCloudVerification({
    isVerified: () => verified,
    subscribeCurrentUser: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }, () => {
    syncReasons.push("session-verified");
  });

  const publish = () => {
    for (const listener of listeners) listener();
  };

  publish();
  verified = true;
  publish();
  publish();

  expect(syncReasons).toEqual(["session-verified"]);

  stop();
  verified = false;
  publish();
  verified = true;
  publish();

  expect(syncReasons).toEqual(["session-verified"]);
});
