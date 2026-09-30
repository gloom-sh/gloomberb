import { expect, test } from "bun:test";
import { ratioBarGlyphs } from "./ratio-bar";

test("rounds a ratio to the nearest half cell and never overflows the width", () => {
  expect(ratioBarGlyphs(1, 20)).toBe("█".repeat(20));
  expect(ratioBarGlyphs(0.5, 20)).toBe("█".repeat(10));
  expect(ratioBarGlyphs(0.525, 20)).toBe(`${"█".repeat(10)}▌`);
  expect(ratioBarGlyphs(0.99, 20)).toBe("█".repeat(20));
  expect(ratioBarGlyphs(2, 20)).toBe("█".repeat(20));
});

test("keeps a nonzero ratio visible instead of rounding it away", () => {
  expect(ratioBarGlyphs(0.001, 20)).toBe("▌");
  expect(ratioBarGlyphs(0.001, 20, { resolution: "eighth" })).toBe("▏");
  expect(ratioBarGlyphs(0, 20)).toBe("");
  expect(ratioBarGlyphs(-0.5, 20)).toBe("");
  expect(ratioBarGlyphs(Number.NaN, 20)).toBe("");
  expect(ratioBarGlyphs(0.5, 0)).toBe("");
});

test("mirrors a bar that grows from the end, which has only half cells", () => {
  expect(ratioBarGlyphs(0.525, 20, { align: "end" })).toBe(`▐${"█".repeat(10)}`);
  expect(ratioBarGlyphs(0.33, 10, { align: "end", resolution: "eighth" })).toBe(`▐${"█".repeat(3)}`);
});

test("draws the partial cell in eighths when asked", () => {
  expect(ratioBarGlyphs(0.33, 10, { resolution: "eighth" })).toBe(`${"█".repeat(3)}▎`);
  expect(ratioBarGlyphs(0.399, 10, { resolution: "eighth" })).toBe("█".repeat(4));
});
