import { expect, spyOn, test } from "bun:test";
import { debugLog } from "./debug-log";
import { logFailure } from "./log-failure";

test("rejected work retains its fallback without copying private rejection payloads", async () => {
  const source = "log-failure-test";
  const entries = debugLog.getEntries({ source }).length;
  const failure = new Error("token=private https://example.test/?secret=private /home/private/config");
  const values = await Promise.all([
    Promise.reject(failure).catch(logFailure(source, "Operation failed")),
    Promise.reject(failure).catch(logFailure(source, "Operation failed", null)),
    Promise.reject(failure).catch(logFailure(source, "Operation failed", false)),
  ]);
  expect(values).toEqual([undefined, null, false]);
  const logged = debugLog.getEntries({ source }).slice(entries);
  expect(logged).toHaveLength(3);
  expect(JSON.stringify(logged)).not.toContain("private");
  expect(logged.every((entry) => entry.data === undefined)).toBe(true);
});

test("a broken console mirror cannot replace the rejection fallback", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => { throw new Error("Broken mirror"); });
  const stop = debugLog.mirrorToConsole({ sources: ["log-failure-mirror-test"] });
  try {
    expect(logFailure("log-failure-mirror-test", "Operation failed", false)(new Error("Failed"))).toBe(false);
    expect(debugLog.getEntries({ source: "log-failure-mirror-test" })).toHaveLength(1);
  } finally {
    stop();
    warn.mockRestore();
  }
});
