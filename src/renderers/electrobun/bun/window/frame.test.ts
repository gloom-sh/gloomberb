import { describe, expect, test } from "bun:test";
import {
  MAIN_WINDOW_MIN_SIZE,
  constrainWindowFrame,
  normalizeWindowFrameWithMinimum,
} from "./frame";

describe("electrobun window frames", () => {
  test("normalizes partial resize events without clamping usable small windows", () => {
    const frame = normalizeWindowFrameWithMinimum(
      { width: 720 },
      { x: 10, y: 20, width: 1200, height: 800 },
      MAIN_WINDOW_MIN_SIZE,
    );

    expect(frame).toEqual({
      x: 10,
      y: 20,
      width: 720,
      height: 800,
    });
  });

  test("clamps only tiny frames to the emergency minimum size", () => {
    expect(constrainWindowFrame(
      { x: 0, y: 0, width: 400, height: 300 },
      MAIN_WINDOW_MIN_SIZE,
    )).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 400,
    });
  });
});
