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

test("a riding task joins the first frame that is due, sets one off only at its limit, and holds no data back", () => {
  const clock = createManualFrameDriver(100);
  const frames = new DataFrameScheduler(clock.driver);
  const runs: string[] = [];
  const quote = () => runs.push(`quote@${clock.driver.now()}`);
  const wake = () => runs.push(`wake@${clock.driver.now()}`);

  frames.request(quote);
  clock.advance(0);
  // Due at 150, it waits for the quote frame at 220 instead of taking a frame of its own.
  frames.request(wake, { phase: "notify", notBefore: 150, rideUntil: 250 });
  clock.advance(220);
  frames.request(quote);
  clock.advance(0);
  expect(runs).toEqual(["quote@0", "quote@220", "wake@220"]);

  // With no data it goes alone at its limit, and that frame does not delay the quote right after it.
  frames.request(wake, { phase: "notify", notBefore: 400, rideUntil: 500 });
  clock.advance(280);
  frames.request(quote);
  clock.advance(0);
  expect(runs.slice(3)).toEqual(["wake@500", "quote@500"]);
  expect(clock.pending).toBe(false);
});

test("a task requested twice keeps the earlier times, and stops riding once any request does not ride", () => {
  const clock = createManualFrameDriver(100);
  const frames = new DataFrameScheduler(clock.driver);
  const runs: string[] = [];
  const quote = () => runs.push(`quote@${clock.driver.now()}`);
  const wake = () => runs.push(`wake@${clock.driver.now()}`);
  const ride = (notBefore: number, rideUntil?: number) => frames.request(wake, { phase: "notify", notBefore, rideUntil });

  // The earlier start: it rides a quote frame due before the later one.
  ride(150, 300);
  ride(100, 200);
  clock.advance(120);
  frames.request(quote);
  clock.advance(0);
  expect(runs).toEqual(["quote@120", "wake@120"]);

  // The earlier limit: with no quotes, it goes alone at that one.
  ride(250, 400);
  ride(300, 350);
  clock.advance(229);
  expect(runs).toHaveLength(2);
  clock.advance(1);
  expect(runs.slice(2)).toEqual(["wake@350"]);

  // Asked for once without riding, it sets its frame off at that time, and the
  // frame spaces the next one like any frame that carries data.
  ride(400, 600);
  ride(450);
  clock.advance(100);
  frames.request(quote);
  clock.advance(99);
  expect(runs.slice(3)).toEqual(["wake@450"]);
  clock.advance(1);
  expect(runs.slice(3)).toEqual(["wake@450", "quote@550"]);
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
