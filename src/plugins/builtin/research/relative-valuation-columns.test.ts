import { describe, expect, test } from "bun:test";
import { normalizeExtraColumns, parseExtraColumns } from "./relative-valuation-columns";

describe("RV --columns", () => {
  test("takes the report's own columns by their usual names and adds nothing for them", () => {
    // `--columns trailingPE` was refused, so the P/E RV already reports read as one it could not give.
    for (const value of ["trailingPE", "P/E", "pe, forwardPE", "fwdPE,marketCap", "evSales fcfYield"]) {
      expect(normalizeExtraColumns(value)).toBe("");
      expect(parseExtraColumns(normalizeExtraColumns(value))).toEqual([]);
    }
    expect(normalizeExtraColumns("trailingPE,target,P/E,si")).toBe("target,shortInterest");
  });

  test("an unknown field names the columns it can add and the ones the report always has", () => {
    expect(() => normalizeExtraColumns("trailingPE,pegRatio")).toThrow(
      'Unknown --columns field "pegRatio". Use any of: shortInterest, nextEarnings, target, grossMargin, evEbitda. '
        + "Last, Chg%, Mkt Cap, P/E, Fwd P/E, EV/S, FCF Yield, Quarter Revenue YoY and TTM Op Margin are always in the report.",
    );
  });
});
