import { expect, test } from "bun:test";
import { createStallClocks } from "./stall-clocks";

const SPAN_MS = 300;

function deltas(read: ReturnType<typeof createStallClocks>, during: () => void) {
  const before = read();
  during();
  const after = read();
  return {
    awakeMs: after.awakeMs! - before.awakeMs!,
    threadCpuMs: after.threadCpuMs! - before.threadCpuMs!,
  };
}

// The platform's clocks come through FFI with hand-written signatures: a
// wrong one reads garbage, and every report would then call a wait busy or
// a freeze sleep. Loose bounds: a busy runner can take the thread away.
test("the platform's clocks tell a busy thread from a waiting one, and count awake time", () => {
  const read = createStallClocks();
  const first = read();
  expect(first.processCpuMs).toBeGreaterThan(0);
  if (first.awakeMs == null || first.threadCpuMs == null) {
    // No platform clocks here (an unknown system): the process's CPU time alone.
    expect(["win32", "darwin", "linux"]).not.toContain(process.platform);
    return;
  }

  const busy = deltas(read, () => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < SPAN_MS) { /* spin */ }
  });
  const waiting = deltas(read, () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SPAN_MS);
  });

  expect(busy.threadCpuMs).toBeGreaterThan(SPAN_MS / 3);
  expect(waiting.threadCpuMs).toBeLessThan(SPAN_MS / 3);
  expect(waiting.awakeMs).toBeGreaterThan(SPAN_MS * 0.8);
  expect(waiting.awakeMs).toBeLessThan(SPAN_MS * 10);
});
