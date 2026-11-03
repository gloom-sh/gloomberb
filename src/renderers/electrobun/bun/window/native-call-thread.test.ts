import { expect, test } from "bun:test";
import { startNativeCallThread, type NativeCallThreadFailure, type UnstartedNativeCall } from "./native-call-thread";

const LIBC = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";

/** A `struct timespec` of `ms`, the bytes `nanosleep` reads. */
function timespec(ms: number): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setBigInt64(0, BigInt(Math.floor(ms / 1000)), true);
  view.setBigInt64(8, BigInt((ms % 1000) * 1_000_000), true);
  return bytes;
}

// The call blocks its thread, as a context menu's does on Windows until the
// menu closes; this thread's timers keep firing on time meanwhile, and the
// calls run one after the other, in order.
test.skipIf(process.platform === "win32")("a call that blocks runs on its own thread, one at a time", async () => {
  const done: number[] = [];
  const thread = startNativeCallThread(LIBC, "nanosleep", { onCallDone: (ms) => done.push(ms) });
  expect(thread).not.toBeNull();
  try {
    const startedAt = performance.now();
    expect(thread!.call(timespec(300), null, () => {})).toBe(true);
    expect(thread!.call(timespec(300), null, () => {})).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(50);

    let latest = 0;
    let previous = performance.now();
    while (done.length < 2 && performance.now() - startedAt < 5_000) {
      await Bun.sleep(20);
      const current = performance.now();
      latest = Math.max(latest, current - previous);
      previous = current;
    }
    expect(done).toHaveLength(2);
    expect(done.every((ms) => ms >= 290)).toBe(true);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(590);
    expect(latest).toBeLessThan(150);
  } finally {
    thread?.close();
  }
});

async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  for (let waited = 0; !condition() && waited < ms; waited += 20) await Bun.sleep(20);
}

// A menu asked for while the thread was still opening the library would be
// lost when it fails to: it comes back for the caller to show itself.
test("a library the thread cannot open gives back the calls it took", async () => {
  const failures: Array<[NativeCallThreadFailure, UnstartedNativeCall[]]> = [];
  const replayed: string[] = [];
  const thread = startNativeCallThread("/nonexistent/libnothing.so", "nothing", { onFailure: (...failure) => failures.push(failure) });
  expect(thread).not.toBeNull();
  expect(thread!.call(new Uint8Array(1), null, () => replayed.push("first"))).toBe(true);
  expect(thread!.call(new Uint8Array(1), null, () => replayed.push("second"))).toBe(true);
  await waitFor(() => failures.length > 0);
  expect(failures.map(([failure, unstarted]) => [failure, unstarted.length])).toEqual([["open-failed", 2]]);
  for (const call of failures[0]![1]) call.replay();
  expect(replayed).toEqual(["first", "second"]);
  expect(thread!.call(new Uint8Array(1), null, () => {})).toBe(false);
});

// A call that never returns would hold every later one behind it for good.
test.skipIf(process.platform === "win32")("a call past its limit stops the thread and gives back the calls behind it", async () => {
  const failures: Array<[NativeCallThreadFailure, UnstartedNativeCall[]]> = [];
  const thread = startNativeCallThread(LIBC, "nanosleep", { callLimitMs: 200, onFailure: (...failure) => failures.push(failure) });
  expect(thread).not.toBeNull();
  const startedAt = performance.now();
  thread!.call(timespec(2_000), null, () => {});
  thread!.call(timespec(10), null, () => {});
  await waitFor(() => failures.length > 0);
  // Given up near the limit, not when the long call returned, and without waiting for it.
  expect(performance.now() - startedAt).toBeLessThan(1_500);
  expect(failures.map(([failure, unstarted]) => [failure, unstarted.length])).toEqual([["stuck", 1]]);
  expect(thread!.call(timespec(10), null, () => {})).toBe(false);
});
