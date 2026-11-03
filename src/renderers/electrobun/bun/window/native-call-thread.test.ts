import { expect, test } from "bun:test";
import { startNativeCallThread } from "./native-call-thread";

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
    expect(thread!.call(timespec(300), null)).toBe(true);
    expect(thread!.call(timespec(300), null)).toBe(true);
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

test("a library the thread cannot open fails once, and the caller makes its calls itself", async () => {
  const failures: string[] = [];
  const thread = startNativeCallThread("/nonexistent/libnothing.so", "nothing", { onFailure: (reason) => failures.push(reason) });
  expect(thread).not.toBeNull();
  for (let waited = 0; failures.length === 0 && waited < 5_000; waited += 20) await Bun.sleep(20);
  expect(failures).toHaveLength(1);
  expect(thread!.call(new Uint8Array(1), null)).toBe(false);
});
