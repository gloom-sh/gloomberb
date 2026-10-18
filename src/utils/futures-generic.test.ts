import { describe, expect, test } from "bun:test";
import { rebindFollowChartSpec } from "../plugins/builtin/chart-composer/follow-binding";
import { chartFuturesGeneric, rebindResearchChartSpec, setChartFuturesGeneric } from "../plugins/builtin/chart-composer/chart-spec-edit";
import { buildPriceChartPreset } from "../plugins/builtin/chart-composer/presets";
import { formatFuturesGeneric, futuresGenericCaption, futuresGenericListing, futuresGenericRollFromValue, parseFuturesGeneric } from "./futures-generic";

describe("generic futures tickers", () => {
  test("parse the root or Bloomberg alias, position, roll and adjustment, and nothing else", () => {
    expect(parseFuturesGeneric("cl1")).toMatchObject({ ticker: "CL1", root: "CL", position: 1, roll: { rule: "first-notice", days: 2, standard: true },
      adjust: "none" });
    expect(parseFuturesGeneric("CL1OI")).toMatchObject({ ticker: "CL1OI", root: "CL", position: 1, roll: { rule: "open-interest" } });
    expect(parseFuturesGeneric("NG2OIR")).toMatchObject({ root: "NG", position: 2, roll: { rule: "open-interest" }, adjust: "ratio" });
    expect(parseFuturesGeneric("TY2F5R")).toMatchObject({ prefix: "TY", root: "ZN", position: 2, roll: { rule: "first-notice", days: 5 }, adjust: "ratio" });
    expect(parseFuturesGeneric("SR31")).toMatchObject({ root: "SR3", position: 1 });
    for (const value of ["AAPL", "CL=F", "CLZ26", "CL0", "CL25", "CL1D29", "BRK.B"]) expect(parseFuturesGeneric(value)).toBeNull();
    expect(formatFuturesGeneric({ prefix: "ES", position: 1, roll: { rule: "fixed-day", day: 15 }, adjust: "difference" })).toBe("ES1D15A");
    for (const ticker of ["CL1", "CL1OI", "CL1F1", "NG2OIR", "ES1R"]) expect(formatFuturesGeneric(parseFuturesGeneric(ticker)!)).toBe(ticker);
    // Only on its root's venue or none, as Gloom Cloud decides: PL8 on the ASX is a listed company.
    expect(futuresGenericListing("CL1", "NYMEX")?.root).toBe("CL");
    expect(futuresGenericListing("VX1:CFE")?.root).toBe("VX");
    expect(futuresGenericListing("PL8", "ASX")).toBeNull();
    expect(chartFuturesGeneric(buildPriceChartPreset("PL8:ASX"))).toBeNull();
  });

  test("caption a generic as a rolling series with its rule, never as one contract", () => {
    // A bare generic names its root's standard roll, as Gloom Cloud counts it.
    expect(futuresGenericCaption(parseFuturesGeneric("CL1")!)).toBe("CL1 1st generic · 2 days before last trade · unadjusted");
    expect(futuresGenericCaption(parseFuturesGeneric("MCL1")!)).toBe("MCL1 1st generic · 1 day before last trade · unadjusted");
    expect(futuresGenericCaption(parseFuturesGeneric("HO1")!)).toBe("HO1 1st generic · 1 day before last trade · unadjusted");
    expect(futuresGenericCaption(parseFuturesGeneric("GC1")!)).toBe("GC1 1st generic · 1 day before first notice · unadjusted");
    expect(futuresGenericCaption(parseFuturesGeneric("ES1")!)).toBe("ES1 1st generic · 6 days before last trade · unadjusted");
    expect(futuresGenericCaption(parseFuturesGeneric("VX1")!)).toBe("VX1 1st generic · after last trade · unadjusted");
    expect(futuresGenericCaption(parseFuturesGeneric("CL1OI")!)).toBe("CL1OI 1st generic · open interest switch · unadjusted");
    expect(futuresGenericCaption(parseFuturesGeneric("GC2F5A")!)).toBe("GC2F5A 2nd generic · 5 days before first notice · difference adjusted");
    expect(futuresGenericCaption(parseFuturesGeneric("VX1F5R")!)).toBe("VX1F5R 1st generic · 5 days before last trade · ratio adjusted");
  });

  test("the chart's roll and adjustment controls rewrite each generic as its own ticker", () => {
    const spec = buildPriceChartPreset("CL1");
    expect(chartFuturesGeneric(spec)?.ticker).toBe("CL1");
    const rolled = setChartFuturesGeneric(spec, { roll: futuresGenericRollFromValue("f5", "CL")!, adjust: "ratio" });
    expect(chartFuturesGeneric(rolled)?.ticker).toBe("CL1F5R");
    expect(chartFuturesGeneric(setChartFuturesGeneric(rolled, { roll: futuresGenericRollFromValue("oi", "CL")! }))?.ticker).toBe("CL1OIR");
    expect(chartFuturesGeneric(setChartFuturesGeneric(rolled, { roll: futuresGenericRollFromValue("standard", "CL")! }))?.ticker).toBe("CL1R");
    expect(setChartFuturesGeneric(buildPriceChartPreset("AAPL"), { adjust: "ratio" })).toEqual(buildPriceChartPreset("AAPL"));
  });

  test("a chart following CL1 keeps the rule it was switched to until the ticker changes", () => {
    const spec = setChartFuturesGeneric(buildPriceChartPreset("CL1:NYM"), { adjust: "ratio" });
    expect(rebindResearchChartSpec(spec, "CL1:NYM", "CL1:NYM")).toBe(spec);
    expect(chartFuturesGeneric(rebindResearchChartSpec(spec, "CL1:NYM", "CL2:NYM"))?.ticker).toBe("CL2");
    const cl1 = { symbol: "CL1", exchange: "NYM" };
    const ids = spec.series.map((series) => series.id);
    expect(rebindFollowChartSpec(spec, cl1, cl1, ids)).toBe(spec);
    expect(chartFuturesGeneric(rebindFollowChartSpec(spec, cl1, { symbol: "GC1", exchange: "CMX" }, ids))?.ticker).toBe("GC1");
  });
});
