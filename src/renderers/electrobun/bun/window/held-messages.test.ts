import { expect, test } from "bun:test";
import { createHeldMessages } from "./held-messages";

function harness(limitMs = 8_000, maxMessages = 1_000) {
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const byScript: Array<[number, string[]]> = [];
  const held = createHeldMessages({
    limitMs,
    maxMessages,
    sendByScript: (webviewId, messages) => byScript.push([webviewId, messages]),
    setTimer: (run) => {
      const id = nextTimer++;
      timers.set(id, run);
      return id;
    },
    clearTimer: (timer) => timers.delete(timer as number),
  });
  const runTimers = () => {
    for (const [id, run] of [...timers]) {
      timers.delete(id);
      run();
    }
  };
  return { held, byScript, timers, runTimers };
}

test("messages wait for the socket and go over it in order when it opens", () => {
  const { held, byScript, timers } = harness();
  expect(held.hold(1, "a")).toBe(true);
  expect(held.hold(1, "b")).toBe(true);
  expect(held.hold(2, "x")).toBe(true);
  expect(held.release(1)).toEqual(["a", "b"]);
  expect(held.release(1)).toEqual([]);
  expect(byScript).toEqual([]);
  // The other window still waits on its own clock.
  expect(timers.size).toBe(1);
});

// A page connects once: a socket that never opens would leave its window
// without a word from the app for good.
test("a socket that does not open in time gets its messages by script, and every later one", () => {
  const { held, byScript, runTimers } = harness();
  held.hold(1, "a");
  held.hold(1, "b");
  runTimers();
  expect(byScript).toEqual([[1, ["a", "b"]]]);
  expect(held.hold(1, "c")).toBe(false);
  // Once it does open, nothing is left to send over it.
  expect(held.release(1)).toEqual([]);
});

test("past the most that may wait, all of them go by script and none is dropped", () => {
  const { held, byScript, timers } = harness(8_000, 3);
  held.hold(1, "a");
  held.hold(1, "b");
  expect(held.hold(1, "c")).toBe(true);
  expect(byScript).toEqual([[1, ["a", "b", "c"]]]);
  expect(timers.size).toBe(0);
  expect(held.hold(1, "d")).toBe(false);
});
