import { expect, test } from "bun:test";
import { hitTestLevel, roundLevelValue, writeLevelText, type ProjectedLevel } from "./levels";

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
