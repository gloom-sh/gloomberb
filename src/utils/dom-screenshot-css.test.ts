import { expect, test } from "bun:test";
import { imageLayerRect, parseBoxShadows, parseLinearGradient } from "./dom-screenshot-css";

test("a dashed legend cue keeps its hard dash edges along the whole line", () => {
  // Chrome's computed form of the cue: double-position stops, 13px period.
  const orange = "rgb(245, 165, 36)";
  const gradient = parseLinearGradient(
    `repeating-linear-gradient(to right, ${orange} 0px 7px, rgba(0, 0, 0, 0) 7px 13px)`,
    32,
    4,
  )!;
  expect([gradient.x0, gradient.y0, gradient.x1, gradient.y1].map((value) => Math.round(value))).toEqual([0, 2, 32, 2]);
  expect(gradient.stops.every((stop, index, stops) => index === 0 || stop.offset >= stops[index - 1]!.offset)).toBe(true);
  // At hard stops the later stop wins, as on a canvas gradient.
  const colorAt = (px: number) => gradient.stops.filter((stop) => stop.offset * 32 <= px).at(-1)!.color;
  expect([0.5, 6.5, 7.5, 12.5, 13.5, 19.5, 20.5, 26.5, 31.5].map((px) => colorAt(px) === orange))
    .toEqual([true, true, false, false, true, true, false, true, true]);
});

test("gradient stops without positions share the gaps, and angles set the line", () => {
  const gradient = parseLinearGradient("linear-gradient(90deg, red, color(srgb 0 1 0 / 0.5) 75%, blue)", 200, 10)!;
  expect(gradient.stops).toEqual([
    { color: "red", offset: 0 },
    { color: "color(srgb 0 1 0 / 0.5)", offset: 0.75 },
    { color: "blue", offset: 1 },
  ]);
  // No direction means top to bottom.
  const vertical = parseLinearGradient("linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))", 10, 40)!;
  expect([vertical.x0, vertical.y0, vertical.x1, vertical.y1].map((value) => Math.round(value))).toEqual([5, 0, 5, 40]);
  expect(parseLinearGradient("radial-gradient(red, blue)", 10, 10)).toBeNull();
});

test("box shadows parse in either colour order, with commas inside colours", () => {
  expect(parseBoxShadows("color(srgb 0.8 0.8 0.8 / 0.12) 0px -1px 0px 0px inset, rgb(1, 2, 3) 0px 0px 0px 2px")).toEqual([
    { color: "color(srgb 0.8 0.8 0.8 / 0.12)", x: 0, y: -1, blur: 0, spread: 0, inset: true },
    { color: "rgb(1, 2, 3)", x: 0, y: 0, blur: 0, spread: 2, inset: false },
  ]);
  expect(parseBoxShadows("inset 0px 0px 0px 1px rgba(255, 255, 255, 0.5)")).toEqual([
    { color: "rgba(255, 255, 255, 0.5)", x: 0, y: 0, blur: 0, spread: 1, inset: true },
  ]);
});

test("a contained mask icon is centred at the image's aspect", () => {
  const area = { x: 10, y: 20, width: 40, height: 20 };
  expect(imageLayerRect(area, { width: 16, height: 16 }, "contain", "50% 50%")).toEqual({ x: 20, y: 20, width: 20, height: 20 });
  expect(imageLayerRect(area, { width: 16, height: 16 }, "12px 12px", "50% 50%")).toEqual({ x: 24, y: 24, width: 12, height: 12 });
});
