import { describe, expect, test } from "bun:test";
import { createOneShot, createOneShots, ONE_SHOT_COOLDOWN_MS } from "./one-shot";

function clock(start = 1_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

describe("one-shot", () => {
  test("a key held for seconds runs once, however often it repeats", () => {
    const time = clock();
    const shot = createOneShot({ now: time.now });
    let runs = 0;
    const trigger = () => {
      if (shot.refuses()) return;
      runs += 1;
      shot.end();
    };

    trigger();
    // 375 ms until the first repeat, then about thirty a second for 4 s.
    time.advance(375);
    for (let elapsed = 0; elapsed < 4_000; elapsed += 33) {
      trigger();
      time.advance(33);
    }

    expect(runs).toBe(1);
  });

  test("a separate press once the key was up for a cooldown runs again", () => {
    const time = clock();
    const shot = createOneShot({ now: time.now });

    expect(shot.refuses()).toBe(false);
    shot.end();
    time.advance(ONE_SHOT_COOLDOWN_MS - 1);
    expect(shot.refuses()).toBe(true);
    // The refusal above was a trigger: the cooldown counts from it.
    time.advance(ONE_SHOT_COOLDOWN_MS - 1);
    expect(shot.refuses()).toBe(true);
    time.advance(ONE_SHOT_COOLDOWN_MS);
    expect(shot.refuses()).toBe(false);
  });

  test("refuses while a run is in flight, however long it takes, then waits a cooldown after it", () => {
    const time = clock();
    const shot = createOneShot({ now: time.now });

    expect(shot.refuses()).toBe(false);
    shot.start();
    time.advance(5_000);
    expect(shot.refuses()).toBe(true);
    time.advance(5_000);
    shot.end();
    expect(shot.refuses()).toBe(true);
    time.advance(ONE_SHOT_COOLDOWN_MS);
    expect(shot.refuses()).toBe(false);
  });

  test("a trigger that says it is a key repeat is refused even after a long repeat delay", () => {
    const time = clock();
    const shot = createOneShot({ now: time.now });

    shot.end();
    // macOS lets the delay before a held key repeats run to nearly two seconds.
    time.advance(1_800);
    expect(shot.refuses({ repeat: true })).toBe(true);
    // The repeat was a trigger: the next one a moment later is refused too, flag or not.
    time.advance(100);
    expect(shot.refuses()).toBe(true);
    time.advance(ONE_SHOT_COOLDOWN_MS);
    expect(shot.refuses()).toBe(false);
  });

  test("a run that never ends stops blocking its action", () => {
    const time = clock();
    const shot = createOneShot({ now: time.now });

    shot.start();
    time.advance(31_000);
    expect(shot.refuses()).toBe(false);
  });

  test("an action that did not run does not start a cooldown", () => {
    const time = clock();
    const shot = createOneShot({ now: time.now });

    expect(shot.refuses()).toBe(false);
    time.advance(10);
    expect(shot.refuses()).toBe(false);
  });

  test("keeps a cooldown per action id", () => {
    const time = clock();
    const shots = createOneShots({ now: time.now });

    shots.get("close").end();
    expect(shots.get("close").refuses()).toBe(true);
    expect(shots.get("copy-screenshot").refuses()).toBe(false);
  });
});
