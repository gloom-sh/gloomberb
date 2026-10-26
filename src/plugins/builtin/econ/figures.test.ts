import { expect, test } from "bun:test";
import { colors } from "../../../theme/colors";
import { actualColor } from "./calendar-model";
import { econRowFigures, parseEconFigure } from "./figures";

test("a drawn figure reads back as its number, unit and scale, every digit exact", () => {
  expect(parseEconFigure("3%")).toEqual({ value: 3, unit: "%", scale: 1 });
  expect(parseEconFigure("-0.17%")).toEqual({ value: -0.17, unit: "%", scale: 1 });
  expect(parseEconFigure("50.9")).toEqual({ value: 50.9, unit: "", scale: 1 });
  expect(parseEconFigure("30.3K")).toEqual({ value: 30300, unit: "", scale: 1000 });
  expect(parseEconFigure("-4.1M bbl")).toEqual({ value: -4_100_000, unit: "bbl", scale: 1_000_000 });
  expect(parseEconFigure("0.987M b/d")).toEqual({ value: 987_000, unit: "b/d", scale: 1_000_000 });
  expect(parseEconFigure("3674B")).toEqual({ value: 3_674_000_000_000, unit: "", scale: 1e9 });
  expect(parseEconFigure("-0.26T")).toEqual({ value: -260_000_000_000, unit: "", scale: 1e12 });
  expect(parseEconFigure("77 Bcf")).toEqual({ value: 77, unit: "Bcf", scale: 1 });
  // Never a negative zero, which a spreadsheet and JSON.stringify would both write as it is.
  expect(Object.is(parseEconFigure("-0M b/d")!.value, 0)).toBe(true);
});

test("the figures the app reads are numbers in an export too: grouped thousands, a lower-case scale, a decimal comma", () => {
  expect(parseEconFigure("1,250")).toEqual({ value: 1250, unit: "", scale: 1 });
  expect(parseEconFigure("-1,250,000.5")).toEqual({ value: -1_250_000.5, unit: "", scale: 1 });
  expect(parseEconFigure("30k")).toEqual({ value: 30000, unit: "", scale: 1000 });
  expect(parseEconFigure("1,5%")).toEqual({ value: 1.5, unit: "%", scale: 1 });
  expect(parseEconFigure("+2.5%")).toEqual({ value: 2.5, unit: "%", scale: 1 });
  expect(parseEconFigure("\u22120.4%")).toEqual({ value: -0.4, unit: "%", scale: 1 });
  // The colour of an actual against its forecast reads them the same way.
  expect(actualColor("1,250", "1,100")).toBe(colors.positive);
  expect(actualColor("30k", "40k")).toBe(colors.negative);
});

test("text that is not one figure is no number", () => {
  for (const text of ["<1.25%", "", "  ", null, undefined, "n/a", "1.2-1.5%", "3% y/y"]) expect(parseEconFigure(text)).toBeNull();
});

test("a row's figures share its unit and scale, and one in another unit is not passed off as one of them", () => {
  expect(econRowFigures({ actual: "30.3K", forecast: "19.4K", prior: "-27.8K" })).toEqual({ actual: 30300, forecast: 19400, prior: -27800, unit: null, scale: 1000 });
  // The unit and scale are those of the first figure the row has.
  expect(econRowFigures({ actual: null, forecast: "-0.987M bbl", prior: "0.5M bbl" })).toEqual({ actual: null, forecast: -987_000, prior: 500_000, unit: "bbl", scale: 1_000_000 });
  expect(econRowFigures({ actual: "3%", forecast: "30K", prior: "2.9%" })).toEqual({ actual: 3, forecast: null, prior: 2.9, unit: "%", scale: 1 });
  expect(econRowFigures({ actual: null, forecast: "<1.25%", prior: "0.5%" })).toMatchObject({ forecast: null, prior: 0.5, unit: "%" });
  // Each figure is multiplied out by its own scale, so mixed scales are still exact; `scale` is the first one's.
  expect(econRowFigures({ actual: "950K", forecast: "1.2M", prior: "1,250" })).toEqual({ actual: 950_000, forecast: 1_200_000, prior: 1250, unit: null, scale: 1000 });
  expect(econRowFigures({})).toEqual({ actual: null, forecast: null, prior: null, unit: null, scale: null });
});
