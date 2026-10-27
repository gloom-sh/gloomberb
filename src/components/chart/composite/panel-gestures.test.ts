import { describe, expect, test } from "bun:test";
import { PAN_COAST_DECAY_MS, panCoastStep, panReleaseVelocity } from "./panel-gestures";

describe("pan coasting", () => {
  test("throws at the speed of the drag's last moments, and not at all once the pointer rested", () => {
    const samples = [{ at: 0, x: 0 }, { at: 400, x: 10 }, { at: 450, x: 20 }, { at: 500, x: 40 }];
    expect(panReleaseVelocity(samples, 500)).toBeCloseTo(0.3, 6);
    // Held still for 150 ms before letting go: nothing recent enough to measure.
    expect(panReleaseVelocity(samples, 650)).toBe(0);
  });

  test("covers the same distance however the frames fall, and slows by e per decay time", () => {
    const whole = panCoastStep(1, 120);
    let speed = 1;
    let cells = 0;
    for (const elapsed of [16, 16, 40, 8, 40]) {
      const step = panCoastStep(speed, elapsed);
      cells += step.cells;
      speed = step.velocity;
    }
    expect(cells).toBeCloseTo(whole.cells, 9);
    expect(speed).toBeCloseTo(whole.velocity, 9);
    expect(panCoastStep(1, PAN_COAST_DECAY_MS).velocity).toBeCloseTo(Math.exp(-1), 9);
  });
});
