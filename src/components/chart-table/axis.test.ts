import { expect, test } from "bun:test";
import { compositeAxisTagFormatter, compositeAxisTicks } from "../chart/composite/format";
import { compositeAxisLabelWidth } from "../chart/composite/panel-labels";
import type { CompositeAxisDomain } from "../chart/composite/types";
import { formatBpAxis, formatCompactAxis, formatPercentAxis } from "./axis";

test("compact ticks share one unit and take their decimals from the plotted range", () => {
  const domain = (min: number, max: number) => ({ min, max }) as CompositeAxisDomain;
  expect(formatCompactAxis(0, domain(0, 125e9))).toBe("0");
  expect(formatCompactAxis(50e9, domain(0, 125e9))).toBe("50B");
  expect(formatCompactAxis(91.2e9, domain(91e9, 92e9))).toBe("91.2B");
  expect(formatCompactAxis(91.25e9, domain(91e9, 91.5e9))).toBe("91.25B");
  expect(formatCompactAxis(750e6, domain(0, 900e6))).toBe("750M");
  // A mirrored axis (puts below zero) picks its unit from the larger side.
  expect(formatCompactAxis(-400e3, domain(-1.9e6, 600e3))).toBe("-0.4M");
});

test("rate tags read to the bp while the ticks keep the plotted range's digits", () => {
  const domain = (min: number, max: number, unit: string): CompositeAxisDomain => ({
    side: "right", min, max, scale: "linear", unit, unitGroup: "", seriesIds: ["rate"], maxTicks: 5,
  });
  // WIRP's target range, 3.75% to 4.00%, on an axis wide enough for tenths.
  const rates = domain(3.65, 4.7, "%");
  expect(compositeAxisTicks(rates, formatPercentAxis).map((tick) => tick.label)).toEqual(["4.6%", "4.4%", "4.2%", "4.0%", "3.8%"]);
  const percentTag = compositeAxisTagFormatter(formatPercentAxis);
  expect(percentTag(3.75, rates)).toBe("3.75%");
  expect(percentTag(4.05, rates)).toBe("4.05%");
  // The gutter fits the tag, so it never reads as a clipped "…".
  expect(compositeAxisLabelWidth(rates, formatPercentAxis, true)).toBe(5);
  expect(compositeAxisLabelWidth(rates, formatPercentAxis, false)).toBe(4);
  const spreads = domain(20, 310, "bp");
  expect(compositeAxisTicks(spreads, formatBpAxis).map((tick) => tick.label)).toEqual(["300bp", "250bp", "200bp", "150bp", "100bp", "50bp"]);
  expect(compositeAxisTagFormatter(formatBpAxis)(44.83, spreads)).toBe("44.8bp");
  // Ticks finer than the value's own precision: the tag reads as finely as they do.
  expect(percentTag(4.0251, domain(4, 4.05, "%"))).toBe("4.025%");
});
