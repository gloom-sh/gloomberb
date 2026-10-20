import { expect, test } from "bun:test";
import { matchesNumberStep, stepNumber, wholeNumberStep } from "./number-step";

test("decimal steps do not accumulate binary drift and snap off-grid edits in the requested direction", () => {
  let value = "0.1";
  for (let i = 0; i < 100; i++) value = stepNumber(value, 1, 0.01)!;
  expect(value).toBe("1.1");
  expect(stepNumber("336.5", -1, 0.01)).toBe("336.49");
  expect(stepNumber("1.234", 1, 0.05)).toBe("1.25");
  expect(stepNumber("1.234", -1, 0.05)).toBe("1.2");
  expect(stepNumber("1e-8", 1, 1e-8)).toBe("0.00000002");
  expect(stepNumber("1.", 1, 0.01)).toBe("1.01");
});

test("bounds stay on the increment grid, invalid input and unrepresentable changes are not guessed", () => {
  expect(stepNumber("", 1, 0.25, 0.3)).toBe("0.5");
  expect(stepNumber("1", 1, 1, 1, 1.9)).toBeUndefined();
  expect(stepNumber("0.5", -1, 0.25, 0.3)).toBeUndefined();
  expect(stepNumber("", 1, 1, 1, 0)).toBeUndefined();
  expect(stepNumber("10", 1, 1, 1, 5)).toBeUndefined();
  for (const value of [".", "Infinity", "abc", "1e1000"]) expect(stepNumber(value, 1, 0.01)).toBeUndefined();
  for (const step of [0, -1, NaN, Infinity]) expect(stepNumber("1", 1, step)).toBeUndefined();
  expect(stepNumber("9007199254740992", 1, 1)).toBeUndefined();
});

test("broker increments are exact, including the whole-quantity intersection", () => {
  expect(matchesNumberStep(0.3, 0.1)).toBe(true);
  expect(matchesNumberStep(1.23, 0.05)).toBe(false);
  expect(matchesNumberStep(10.00000000001, 1)).toBe(false);
  expect(wholeNumberStep(0.25)).toBe(1);
  expect(wholeNumberStep(1.5)).toBe(3);
  expect(wholeNumberStep(2.5)).toBe(5);
});
