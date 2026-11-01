import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createManualFrameDriver, createTimerFrameDriver, installMarketDataFrameDriver, marketDataFrames } from "../../../market-data/frame-scheduler";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { useThrottledMemo } from "./use-throttled-memo";

const tui = createOpenTuiTestHarness();
const clock = createManualFrameDriver(100);
let renders: number[] = [];
let setInput: ((value: number) => void) | null = null;
let setScale: ((value: number) => void) | null = null;

function Harness() {
  const [input, update] = useState(1);
  const [scale, updateScale] = useState(10);
  setInput = update;
  setScale = updateScale;
  const total = useThrottledMemo(() => input * scale, [input], [scale], 1_000);
  renders.push(total);
  return <text>{String(total)}</text>;
}

beforeEach(() => {
  installMarketDataFrameDriver(clock.driver);
  renders = [];
});
afterEach(() => {
  installMarketDataFrameDriver(createTimerFrameDriver(0));
  setInput = null;
  setScale = null;
});

test("a quote inside the interval catches up once, with the first data frame after it or a frame later on its own", async () => {
  await tui.render(<Harness />, { width: 8, height: 1 });
  await act(async () => clock.advance(1_000));
  await act(async () => setInput!(2));
  await act(async () => clock.advance(200));
  await act(async () => setInput!(3));
  // Both changes waited for the interval; the second rendered with the first's stale total.
  expect(renders).toEqual([10, 20, 20]);

  await act(async () => clock.advance(850));
  expect(renders).toEqual([10, 20, 20]);
  await act(async () => {
    marketDataFrames.request(() => {}, { phase: "notify" });
    clock.advance(0);
  });
  expect(renders).toEqual([10, 20, 20, 30]);

  await act(async () => setInput!(4));
  await act(async () => clock.advance(1_099));
  expect(renders.at(-1)).toBe(30);
  await act(async () => clock.advance(1));
  expect(renders.at(-1)).toBe(40);
  expect(clock.pending).toBe(false);
});

test("a render that catches up first drops the trailing one", async () => {
  await tui.render(<Harness />, { width: 8, height: 1 });
  await act(async () => setInput!(2));
  // A setting change recomputes at once, with the newer quote too.
  await act(async () => setScale!(100));
  expect(renders).toEqual([10, 10, 200]);
  await act(async () => clock.advance(1_000));
  expect(renders).toEqual([10, 10, 200]);
  expect(clock.pending).toBe(false);
});
