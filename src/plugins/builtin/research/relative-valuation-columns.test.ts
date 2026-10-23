import { describe, expect, test } from "bun:test";
import { extraColumnsBasis, normalizeExtraColumns, parseExtraColumns } from "./relative-valuation-columns";

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

  test("the footer dates each added column by its cells: a June fiscal year beside December ones, never a retrieval time", () => {
    // The screener's gross margin is the fiscal year's: FY2025 for DUOL beside TTM margins, which the header alone hid.
    const rows = [
      { symbol: "DUOL", grossMarginPercent: 72.2, grossMarginAsOf: "2025-12-31", targetMean: 210, targetAsOf: "2026-10-23T11:00:00.000Z" },
      { symbol: "MSFT", grossMarginPercent: 68.8, grossMarginAsOf: "2026-06-30", shortInterestPercentFloat: 0.8, shortInterestAsOf: "2026-09-30" },
      { symbol: "LRN", grossMarginPercent: 39.1, grossMarginAsOf: "2026-06-30" },
      { symbol: "LHA:XETRA", grossMarginPercent: null, grossMarginAsOf: null },
    ];
    expect(extraColumnsBasis(["grossMargin", "target", "shortInterest"], rows)).toEqual([
      "Gross Margin: fiscal year to 2026-06-30 (DUOL 2025-12-31)",
      "Short % Float: settlement 2026-09-30",
    ]);
  });
});
