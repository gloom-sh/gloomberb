import { describe, expect, test } from "bun:test";
import { buildPriceChartPreset, chartFuturesGeneric, setChartFuturesGeneric } from "../plugins/builtin/chart-composer/presets";
import { formatFuturesGeneric, futuresGenericCaption, futuresGenericRollFromValue, parseFuturesGeneric } from "./futures-generic";

describe("generic futures tickers", () => {
  test("parse the root or Bloomberg alias, position, roll and adjustment, and nothing else", () => {
    expect(parseFuturesGeneric("cl1")).toMatchObject({ ticker: "CL1", root: "CL", position: 1, roll: { rule: "open-interest" }, adjust: "none" });
    expect(parseFuturesGeneric("TY2F5R")).toMatchObject({ prefix: "TY", root: "ZN", position: 2, roll: { rule: "first-notice", days: 5 }, adjust: "ratio" });
    expect(parseFuturesGeneric("SR31")).toMatchObject({ root: "SR3", position: 1 });
    for (const value of ["AAPL", "CL=F", "CLZ26", "CL0", "CL25", "CL1D29", "BRK.B"]) expect(parseFuturesGeneric(value)).toBeNull();
    expect(formatFuturesGeneric({ prefix: "ES", position: 1, roll: { rule: "fixed-day", day: 15 }, adjust: "difference" })).toBe("ES1D15A");
  });

  test("caption a generic as a rolling series with its rule, never as one contract", () => {
    expect(futuresGenericCaption(parseFuturesGeneric("CL1")!)).toBe("CL1 1st generic · open interest switch · unadjusted");
    expect(futuresGenericCaption(parseFuturesGeneric("GC2F5A")!)).toBe("GC2F5A 2nd generic · 5 days before first notice · difference adjusted");
    expect(futuresGenericCaption(parseFuturesGeneric("VX1F5R")!)).toBe("VX1F5R 1st generic · 5 days before last trade · ratio adjusted");
  });

  test("the chart's roll and adjustment controls rewrite each generic as its own ticker", () => {
    const spec = buildPriceChartPreset("CL1");
    expect(chartFuturesGeneric(spec)?.ticker).toBe("CL1");
    const rolled = setChartFuturesGeneric(spec, { roll: futuresGenericRollFromValue("f5")!, adjust: "ratio" });
    expect(chartFuturesGeneric(rolled)?.ticker).toBe("CL1F5R");
    expect(setChartFuturesGeneric(buildPriceChartPreset("AAPL"), { adjust: "ratio" })).toEqual(buildPriceChartPreset("AAPL"));
  });
});
