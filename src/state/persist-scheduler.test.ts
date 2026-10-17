import { describe, expect, test } from "bun:test";
import { createPersistScheduler, flushPendingPersistence } from "./persist-scheduler";
import { debugLog, type LogEntry } from "../utils/debug-log";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createPersistScheduler", () => {
  test("page exit drains the latest config and session once, excluding cancelled writes", async () => {
    const saved: string[] = [];
    const config = createPersistScheduler<string>({ delayMs: 60_000, save: (value) => { saved.push(value); } });
    const session = createPersistScheduler<string>({ delayMs: 60_000, save: (value) => { saved.push(value); } });
    const cancelled = createPersistScheduler<string>({ delayMs: 60_000, save: (value) => { saved.push(value); } });
    config.schedule("old chart");
    config.schedule("percent chart");
    session.schedule("selected pane");
    cancelled.schedule("discarded");
    cancelled.cancel();
    await flushPendingPersistence();
    await flushPendingPersistence();
    expect(saved).toEqual(["percent chart", "selected pane"]);

    // Returning from a background tab must allow subsequent changes to save.
    config.schedule("index chart");
    await flushPendingPersistence();
    expect(saved).toEqual(["percent chart", "selected pane", "index chart"]);
  });

  test("coalesces scheduled saves and writes the latest value", async () => {
    const saved: number[] = [];
    const scheduler = createPersistScheduler<number>({
      delayMs: 5,
      save: (value) => saved.push(value),
    });

    scheduler.schedule(1);
    scheduler.schedule(2);
    scheduler.schedule(3);
    await delay(15);

    expect(saved).toEqual([3]);
  });

  test("serializes an immediate save after an in-flight scheduled save", async () => {
    let persisted: string | undefined;
    let releaseStaleSave: (() => void) | undefined;
    let markStaleSaveStarted: (() => void) | undefined;
    const staleSaveStarted = new Promise<void>((resolve) => {
      markStaleSaveStarted = resolve;
    });
    const staleSaveReleased = new Promise<void>((resolve) => {
      releaseStaleSave = resolve;
    });
    const scheduler = createPersistScheduler<string>({
      delayMs: 1000,
      save: async (value) => {
        if (value === "stale") {
          markStaleSaveStarted?.();
          await staleSaveReleased;
        }
        persisted = value;
      },
    });

    scheduler.schedule("stale");
    const scheduledSave = scheduler.flush();
    await staleSaveStarted;
    const completionSave = scheduler.saveImmediately("complete");
    releaseStaleSave?.();
    await Promise.all([scheduledSave, completionSave]);

    expect(persisted).toBe("complete");
  });

  test("save errors are reported without escaping timer", async () => {
    const errors: unknown[] = [];
    const scheduler = createPersistScheduler<string>({
      delayMs: 5,
      save: () => {
        throw new Error("boom");
      },
      onError: (error) => errors.push(error),
    });

    scheduler.schedule("pending");
    await delay(15);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  test("scheduled saves without an error callback log once and leave the queue usable", async () => {
    const saved: string[] = [];
    const logged: LogEntry[] = [];
    const unsubscribe = debugLog.subscribe((entry) => { if (entry.source === "persist") logged.push(entry); });
    const scheduler = createPersistScheduler<string>({
      delayMs: 60_000,
      save: (value) => {
        if (value === "failed") throw new Error("Injected write failure");
        saved.push(value);
      },
    });
    try {
      scheduler.schedule("failed");
      await scheduler.flush();
      scheduler.schedule("next");
      await scheduler.flush();
      expect(saved).toEqual(["next"]);
      expect(logged.map((entry) => entry.source)).toEqual(["persist"]);
    } finally {
      scheduler.cancel();
      unsubscribe();
    }
  });
});

for (const mode of ["timer", "immediate"] as const) test(`exit waits for an in-flight ${mode} save and changes scheduled while it is running`, async () => {
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const saved: string[] = [];
  const scheduler = createPersistScheduler<string>({
    delayMs: 0,
    save: async value => {
      if (value === "first") { start(); await held; }
      saved.push(value);
    },
  });
  if (mode === "timer") scheduler.schedule("first");
  else void scheduler.saveImmediately("first");
  await started;
  let flushed = false;
  const exit = flushPendingPersistence().then(() => { flushed = true; });
  try {
    await delay(1);
    expect(flushed).toBe(false);
    // This update was not in the initial snapshot of pending exit work.
    scheduler.schedule("last");
    release();
    await exit;
    expect(saved).toEqual(["first", "last"]);
  } finally {
    release();
    await scheduler.flush();
    await exit;
  }
});
