import { expect, test } from "bun:test";
import { fitAxisLabels, hitTestLevel, levelVectors, paintLevels, roundLevelValue, writeLevelText, type ProjectedLevel } from "./levels";

const level = (id: string, yRatio: number, editable = true): ProjectedLevel => ({
  level: { id, value: 100 - yRatio * 10, color: "#f5a524", editable, actionable: editable },
  yRatio,
});

test("a level placed by pointer rounds to what its axis can tell apart", () => {
  expect(roundLevelValue(230.44718, { min: 226, max: 233 })).toBe(230.45);
  expect(roundLevelValue(1.0856349, { min: 1.08, max: 1.09 })).toBe(1.08563);
  expect(roundLevelValue(64321.7, { min: 60_000, max: 70_000 })).toBe(64322);
});

test("the pointer grabs the nearest level within its slack, a drawn one before an alert", () => {
  const levels = [level("alert", 0.5, false), level("drawn", 0.5), level("far", 0.9)];
  expect(hitTestLevel(levels, 0.51, 0.03)?.id).toBe("drawn");
  expect(hitTestLevel(levels, 0.7, 0.03)).toBeNull();
});

test("text levels fill only blank cells so the marks stay readable", () => {
  const lines = writeLevelText(["  ·  ", " •█· ", "     "], [level("drawn", 0.5), level("alert", 1, false)], null);
  expect(lines).toEqual(["  ·  ", "─•█──", "┄┄┄┄┄"]);
});

test("a dashed external level uses the same clipped segments in vector and Kitty paths", () => {
  const ghost = level("ghost", 0.5, false); ghost.level.dashed = true;
  const vectors = levelVectors([ghost], null);
  expect(vectors.length).toBeGreaterThan(1);
  expect(vectors.every((shape, index) => shape.points[0]!.x >= 0 && shape.points[1]!.x <= 1 && (!index || vectors[index - 1]!.points[1]!.x < shape.points[0]!.x))).toBe(true);
  const base = { width: 960, height: 10, pixels: new Uint8Array(960 * 10 * 4) };
  const result = paintLevels(base, [ghost], null);
  expect(base.pixels.every((value) => value === 0)).toBe(true);
  const alpha = (x: number) => result.pixels[(5 * 960 + x) * 4 + 3];
  expect(alpha(3)).toBeGreaterThan(0);
  expect(alpha(16)).toBe(0);
  expect(alpha(23)).toBeGreaterThan(0);
});

test("close levels keep their lines but only the labels with a row beside the last price and each other", () => {
  const labels = [{ id: "picked", row: 5.5 }, { id: "near", row: 6.1 }, { id: "on-price", row: 11.3 }, { id: "clear", row: 7.8 }];
  const shown = fitAxisLabels(labels, [{ id: "last", row: 11 }], (label) => label.row);
  expect(shown.map((label) => label.id)).toEqual(["picked", "clear"]);
});
