import { describe, expect, test } from "bun:test";
import { createPersistScheduler } from "./persist-scheduler";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createPersistScheduler", () => {
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

  test("flush saves immediately", async () => {
    const saved: string[] = [];
    const scheduler = createPersistScheduler<string>({
      delayMs: 1000,
      save: (value) => saved.push(value),
    });

    scheduler.schedule("pending");
    await scheduler.flush();

    expect(saved).toEqual(["pending"]);
  });

  test("cancel drops pending value", async () => {
    const saved: string[] = [];
    const scheduler = createPersistScheduler<string>({
      delayMs: 5,
      save: (value) => saved.push(value),
    });

    scheduler.schedule("pending");
    scheduler.cancel();
    await delay(15);

    expect(saved).toEqual([]);
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
});
