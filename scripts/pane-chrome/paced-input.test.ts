import { expect, test } from "bun:test";
import { paceInput } from "./paced-input";

test("input keeps its deadlines while acknowledgements lag, then drains every dispatch", async () => {
  let at = 0;
  const positions: number[] = [];
  const acknowledgements: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  const result = await paceInput((progress) => {
    positions.push(progress);
    const acknowledgement = Promise.withResolvers<void>();
    acknowledgements.push(acknowledgement);
    return acknowledgement.promise;
  }, {
    durationMs: 100, intervalMs: 10, now: () => at,
    wait: async (ms) => {
      at += ms;
      if (at === 100) setTimeout(() => {
        at = 125;
        for (const acknowledgement of acknowledgements) acknowledgement.resolve();
      }, 0);
    },
  });
  expect(positions).toEqual(Array.from({ length: 10 }, (_, index) => index / 10));
  expect(result).toMatchObject({ offeredMoves: 10, acknowledgedMoves: 10, skippedSlots: 0, maxPendingMoves: 10, drainMs: 25 });
});

test("a late driver skips missed slots instead of replaying their input in a burst", async () => {
  let at = 0, delayed = false;
  const offeredAt: number[] = [];
  const result = await paceInput(async () => { offeredAt.push(at); }, {
    durationMs: 100, intervalMs: 10, now: () => at,
    wait: async (ms) => {
      at += ms + (delayed ? 0 : 35);
      delayed = true;
    },
  });
  expect(offeredAt).toEqual([0, 45, 50, 60, 70, 80, 90]);
  expect(result).toMatchObject({ offeredMoves: 7, acknowledgedMoves: 7, skippedSlots: 3, maxDispatchLatenessMs: 35 });
});

test("a rejected dispatch fails the sample after outstanding input is drained", async () => {
  let at = 0, offered = 0, drained = false;
  const first = Promise.withResolvers<void>();
  const failed = paceInput(() => {
    offered += 1;
    return offered === 1 ? first.promise : Promise.reject(new Error("input refused"));
  }, {
    durationMs: 100, intervalMs: 10, now: () => at,
    wait: async (ms) => {
      at += ms;
      if (at === 100) setTimeout(() => { drained = true; first.resolve(); }, 0);
    },
  });
  await expect(failed).rejects.toThrow("Native input dispatch failed: Error: input refused");
  expect(offered).toBe(2);
  expect(drained).toBe(true);
});
