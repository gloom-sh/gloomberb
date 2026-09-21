import { describe, expect, test } from "bun:test";
import { isSqliteBusyError, trySqliteBusyOperation, withSqliteBusyRetry } from "./retry";
import { debugLog } from "../../utils/debug-log";

function createBusyError(): Error & { code: string; errno: number } {
  const error = new Error("database is locked") as Error & { code: string; errno: number };
  error.code = "SQLITE_BUSY";
  error.errno = 5;
  return error;
}

describe("sqlite busy retry", () => {
  test("recognizes Bun SQLite busy errors", () => {
    expect(isSqliteBusyError(createBusyError())).toBe(true);
    expect(isSqliteBusyError(new Error("other failure"))).toBe(false);
  });

  // A contended statement parks the whole app inside SQLite's busy handler.
  // The freeze is invisible unless the statement that caused it is named.
  test("reports a statement that blocked the app", () => {
    const entries: Array<{ source: string; message: string; data?: unknown }> = [];
    const unsubscribe = debugLog.subscribe((entry) => { entries.push(entry); });
    try {
      withSqliteBusyRetry("save cached resource", () => {
        const until = Date.now() + 60;
        while (Date.now() < until) { /* stand in for a lock wait */ }
        return "ok";
      }, { attempts: 1 });
    } finally {
      unsubscribe();
    }

    const blocked = entries.find((entry) => entry.message === "sqlite.blocked");
    expect(blocked?.source).toBe("perf");
    expect(blocked?.data).toMatchObject({ operation: "save cached resource", attempts: 1 });
  });

  test("retries busy errors until the operation succeeds", () => {
    let attempts = 0;

    const result = withSqliteBusyRetry("test retry", () => {
      attempts += 1;
      if (attempts < 3) throw createBusyError();
      return "ok";
    }, {
      attempts: 3,
      initialDelayMs: 0,
      maxDelayMs: 0,
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("stops after the configured busy retry attempts", () => {
    let attempts = 0;

    expect(() => withSqliteBusyRetry("test exhaustion", () => {
      attempts += 1;
      throw createBusyError();
    }, {
      attempts: 2,
      initialDelayMs: 0,
      maxDelayMs: 0,
    })).toThrow("database is locked");

    expect(attempts).toBe(2);
  });

  test("optional operations only swallow exhausted busy errors", () => {
    const result = trySqliteBusyOperation("optional busy", () => {
      throw createBusyError();
    }, {
      attempts: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
    });

    expect(result).toBeNull();
    expect(() => trySqliteBusyOperation("optional non-busy", () => {
      throw new Error("not sqlite");
    })).toThrow("not sqlite");
  });
});
