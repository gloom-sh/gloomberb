import { afterEach, expect, test } from "bun:test";
import { createAnimationFrameDriver, createManualFrameDriver, DataFrameScheduler } from "./frame-scheduler";

const globals = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
const originalCancelRaf = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");

afterEach(() => {
  for (const [name, descriptor] of [["requestAnimationFrame", originalRaf], ["cancelAnimationFrame", originalCancelRaf]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

test("coalesces requests into frames spaced by the interval and honours not-before times", () => {
  const clock = createManualFrameDriver(100);
  const frames = new DataFrameScheduler(clock.driver);
  const runs: number[] = [];
  const task = () => runs.push(clock.driver.now());

  frames.request(task);
  frames.request(task);
  clock.advance(0);
  expect(runs).toEqual([0]);

  frames.request(task, { notBefore: 1_000 });
  clock.advance(999);
  expect(runs).toEqual([0]);
  clock.advance(1);
  expect(runs).toEqual([0, 1_000]);

  frames.request(task);
  clock.advance(50);
  expect(runs).toEqual([0, 1_000]);
  clock.advance(50);
  expect(runs).toEqual([0, 1_000, 1_100]);
  expect(clock.pending).toBe(false);
});

test("frames that set off expensive renders are spaced out, and return to full rate once cheap", () => {
  const clock = createManualFrameDriver(100);
  const frames = new DataFrameScheduler(clock.driver);
  let costMs = 80;
  const starts: number[] = [];
  const render = () => {
    starts.push(clock.driver.now());
    clock.spend(costMs);
    frames.request(render, { phase: "notify" });
  };
  const gaps = () => starts.slice(1).map((start, index) => start - starts[index]!);

  frames.request(render, { phase: "notify" });
  clock.advance(10_000);
  // An 80 ms render settles near one frame per 320 ms, a quarter of the time.
  expect(gaps()[0]).toBe(100);
  expect(gaps().at(-1)).toBeGreaterThan(300);
  expect(gaps().at(-1)).toBeLessThanOrEqual(320);

  costMs = 1;
  starts.length = 0;
  clock.advance(10_000);
  expect(gaps().at(-1)).toBe(100);
  frames.remove(render);
});

test("a hidden document that stops animation frames still drains data about once a second", async () => {
  const requested: Array<() => void> = [];
  globals.requestAnimationFrame = (callback: () => void) => requested.push(callback);
  globals.cancelAnimationFrame = () => {};
  const frames = new DataFrameScheduler(createAnimationFrameDriver(0, 30));
  let runs = 0;
  frames.request(() => { runs += 1; });

  expect(requested).toHaveLength(1);
  await Bun.sleep(10);
  expect(runs).toBe(0);
  await Bun.sleep(40);
  expect(runs).toBe(1);
  // The animation frame that finally arrives does not run the frame twice.
  requested[0]!();
  expect(runs).toBe(1);
});
