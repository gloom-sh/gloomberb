import { expect, test } from "bun:test";
import { compositeAxisMaxTicks, compositeAxisTicks } from "../../../components/chart/composite/format";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import { formatOpenRolesAxisValue } from "./pane";

function domain(min: number, max: number, rows = 14): CompositeAxisDomain {
  return {
    side: "right",
    seriesIds: ["primary"],
    min,
    max,
    scale: "linear",
    unit: "",
    unitGroup: "",
    maxTicks: compositeAxisMaxTicks(rows),
    tickRows: rows,
  };
}

const labels = (axis: CompositeAxisDomain) => compositeAxisTicks(axis, formatOpenRolesAxisValue).map((tick) => tick.label);

// Regression: formatCompact(Math.round(value)) read 2k 2k 1.9k down the gutter.
test("open-role axes below 10k read whole grouped counts", () => {
  expect(labels(domain(1950, 2025))).toEqual(["2,020", "2,000", "1,980", "1,960"]);
  expect(labels(domain(1880, 2030, 20))).toEqual(["2,000", "1,950", "1,900"]);
  expect(formatOpenRolesAxisValue(1_943.6, domain(1880, 2030))).toBe("1,944");
  // Half-role ticks on a tiny count step up to whole ones rather than repeat.
  expect(labels(domain(3, 5, 20))).toEqual(["5", "4", "3"]);
});

test("open-role axes above 10k stay compact with the decimals the step needs", () => {
  expect(labels(domain(158_700, 160_300))).toEqual(["160.0k", "159.5k", "159.0k"]);
  expect(formatOpenRolesAxisValue(159_734, domain(158_700, 160_300))).toBe("159.7k");
  expect(labels(domain(120_000, 185_000))).toEqual(["180k", "160k", "140k", "120k"]);
  expect(labels(domain(9_800, 10_300))).toEqual(["10.3k", "10.2k", "10.1k", "10.0k", "9.9k", "9.8k"]);
});
