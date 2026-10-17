import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { debugLog } from "./debug-log";
import { logFailure } from "./log-failure";

afterEach(() => setSystemTime());

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
  expect(logged).toHaveLength(1);
  expect(JSON.stringify(logged)).not.toContain("private");
  expect(logged.every((entry) => entry.data === undefined)).toBe(true);
});

test("failure windows are shared by source and message, count repeats, and do not slide", () => {
  const source = "log-failure-window-test";
  const start = 1_800_000_000_000;
  const fallback = { retained: true };
  setSystemTime(start);
  expect(logFailure(source, "Operation failed", fallback)(null)).toBe(fallback);
  for (let repeat = 1; repeat <= 100; repeat++) {
    setSystemTime(start + repeat * 299);
    expect(logFailure(source, "Operation failed", fallback)(null)).toBe(fallback);
  }
  logFailure(source, "Other operation failed")(null);
  logFailure(`${source}-other`, "Operation failed")(null);
  expect(debugLog.getEntries({ source })).toHaveLength(2);
  expect(debugLog.getEntries({ source: `${source}-other` })).toHaveLength(1);

  setSystemTime(start + 30_000);
  logFailure(source, "Operation failed")(null);
  const entries = debugLog.getEntries({ source });
  expect(entries).toHaveLength(3);
  expect(entries[2]!.message).toEndWith("(suppressed repeats: 100)");

  setSystemTime(start + 60_000);
  logFailure(source, "Operation failed")(null);
  expect(debugLog.getEntries({ source }).at(-1)!.message).toBe(entries[0]!.message);
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
