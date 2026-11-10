import { expect, test } from "bun:test";
import { shortestLegendName, wholeWordsCut } from "./legend";

test("a legend name cut short keeps whole words that tell it from the names beside it", () => {
  const hy = "US high yield OAS";
  const formula = "US high yield OAS - US corporate OAS";
  // Its first and last words where its first ones alone read as the other's ("US high..."), never "US...orate OAS".
  expect(wholeWordsCut(formula, 18, [hy])).toBe("US...corporate OAS");
  // Where no cut tells them apart, its first words.
  expect(wholeWordsCut(hy, 10, [formula])).toBe("US high...");
  // A code is one word: two formulas on one first leg keep it whole rather than show part of it.
  const ig = "FRED:BAMLH0A0HYM2 - FRED:BAMLC0A0CM";
  const cdx = "FRED:BAMLH0A0HYM2 - CAP:cdx:hy-spread";
  expect(wholeWordsCut(ig, 16, [cdx])).toBe("FRED:BAMLH0A0HYM2...");
  expect(wholeWordsCut(cdx, 40, [ig])).toBe(cdx);
});

test("a legend name on one line loses whole words, never part of one", () => {
  // CHOKE's legend at 80 columns read "Malacc".
  expect(wholeWordsCut("Malacca", 6)).toBe("Malacca");
  expect(shortestLegendName("Malacca")).toBe("Malacca");
  expect(wholeWordsCut("Bab el-Mandeb", 12)).toBe("Bab...");
  expect(wholeWordsCut("US high yield OAS", 14)).toBe("US high...OAS");
  expect(wholeWordsCut("US high yield OAS", 12)).toBe("US high...");
  expect(wholeWordsCut("US high yield OAS", 2)).toBe("US...");
  expect(wholeWordsCut("US high yield OAS", 17)).toBe("US high yield OAS");
});
