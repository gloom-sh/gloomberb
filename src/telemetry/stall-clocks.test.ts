import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processActivityDelta } from "../utils/stall-process-activity";
import { createStallClocks } from "./stall-clocks";
import { readWindowsTimeoutClock } from "./windows-time";

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

test.skipIf(process.platform !== "win32")("Windows counters see process I/O and faults, with correctly sized native buffers", () => {
  const dir = mkdtempSync(join(tmpdir(), "gloom-process-counters-"));
  try {
    const read = createStallClocks();
    const before = read().processActivity;
    const bytes = Buffer.alloc(16 * 1024 * 1024, 0x42);
    const path = join(dir, "sample.bin");
    writeFileSync(path, bytes);
    expect(readFileSync(path).byteLength).toBe(bytes.byteLength);
    const delta = processActivityDelta(before, read().processActivity);
    expect(delta?.pageFaults).toBeGreaterThan(0);
    const io = delta?.io;
    if (!io || typeof io === "string") throw new Error(`Windows I/O counters did not advance: ${io}`);
    expect(io.readOps).toBeGreaterThan(0);
    expect(io.writeOps).toBeGreaterThan(0);
    expect(io.readBytes).toBeGreaterThanOrEqual(bytes.byteLength);
    expect(io.writeBytes).toBeGreaterThanOrEqual(bytes.byteLength);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("Windows elapsed and awake clocks both advance while the process waits awake", () => {
  const before = readWindowsTimeoutClock();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SPAN_MS);
  const after = readWindowsTimeoutClock();
  if (!before || !after) throw new Error("Could not read paired Windows timeout clocks");
  const elapsed = after.elapsedMs - before.elapsedMs;
  const awake = after.awakeMs - before.awakeMs;
  expect(elapsed).toBeGreaterThan(SPAN_MS * 0.8);
  expect(awake).toBeGreaterThan(SPAN_MS * 0.8);
  expect(Math.abs(elapsed - awake)).toBeLessThan(100);
  expect(Math.abs(elapsed - (after.wallMs - before.wallMs))).toBeLessThan(100);
});
