import { afterEach, expect, jest, test } from "bun:test";
import {
  ConnectionHealthRegistry,
  GLOOM_CLOUD_SOCKET_CONNECTION_ID,
  registerGloomCloudConnectionSources,
} from "../core/connection-health";
import { followDataServiceHealth, QUOTE_STREAM_DOWN_GRACE_MS } from "./connection-follow";

afterEach(() => jest.useRealTimers());

function follow() {
  const health = new ConnectionHealthRegistry();
  registerGloomCloudConnectionSources(health);
  const calls: string[] = [];
  const stop = followDataServiceHealth(health, {
    reloadAfterOutage: () => calls.push("reload"),
    setQuoteStreamDown: (since) => calls.push(since == null ? "live" : "down"),
  });
  const stream = (state: "connecting" | "open" | "closed" | "error" | "idle") => health.reportSocketState(GLOOM_CLOUD_SOCKET_CONNECTION_ID, state);
  return { calls, stop, stream };
}

// A server restart closes the stream and reopens it at once: prices must not
// flash stale for it. A stream that failed (no answer) has already been
// waited out, and reads stale at once.
test("a stream that closes reads stale only past the grace, one that failed at once, and both live again on open", () => {
  jest.useFakeTimers();
  const { calls, stop, stream } = follow();
  try {
    stream("connecting");
    stream("error");
    // Never open yet: there are no streamed prices to call stale.
    expect(calls.filter((call) => call === "down")).toEqual([]);

    stream("open");
    calls.length = 0;
    stream("closed");
    stream("connecting");
    jest.advanceTimersByTime(QUOTE_STREAM_DOWN_GRACE_MS - 1);
    stream("open");
    jest.advanceTimersByTime(QUOTE_STREAM_DOWN_GRACE_MS);
    expect(calls).not.toContain("down");

    calls.length = 0;
    stream("closed");
    jest.advanceTimersByTime(QUOTE_STREAM_DOWN_GRACE_MS);
    expect(calls).toEqual(["down"]);
    stream("open");
    expect(calls).toEqual(["down", "live"]);

    calls.length = 0;
    stream("error");
    expect(calls).toEqual(["down"]);
    // Closed on purpose (signed out, nothing left to stream): nothing is down.
    stream("idle");
    expect(calls).toEqual(["down", "live"]);
  } finally {
    stop();
  }
});
