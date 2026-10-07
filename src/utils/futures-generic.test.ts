import { describe, expect, test } from "bun:test";
import { rebindFollowChartSpec } from "../plugins/builtin/chart-composer/follow-binding";
import { chartFuturesGeneric, rebindResearchChartSpec, setChartFuturesGeneric } from "../plugins/builtin/chart-composer/chart-spec-edit";
import { buildPriceChartPreset } from "../plugins/builtin/chart-composer/presets";
import { formatFuturesGeneric, futuresGenericCaption, futuresGenericListing, futuresGenericRollFromValue, parseFuturesGeneric } from "./futures-generic";

describe("generic futures tickers", () => {
  test("parse the root or Bloomberg alias, position, roll and adjustment, and nothing else", () => {
    expect(parseFuturesGeneric("cl1")).toMatchObject({ ticker: "CL1", root: "CL", position: 1, roll: { rule: "open-interest" }, adjust: "none" });
    expect(parseFuturesGeneric("TY2F5R")).toMatchObject({ prefix: "TY", root: "ZN", position: 2, roll: { rule: "first-notice", days: 5 }, adjust: "ratio" });
    expect(parseFuturesGeneric("SR31")).toMatchObject({ root: "SR3", position: 1 });
    for (const value of ["AAPL", "CL=F", "CLZ26", "CL0", "CL25", "CL1D29", "BRK.B"]) expect(parseFuturesGeneric(value)).toBeNull();
    expect(formatFuturesGeneric({ prefix: "ES", position: 1, roll: { rule: "fixed-day", day: 15 }, adjust: "difference" })).toBe("ES1D15A");
    // Only on its root's venue or none, as Gloom Cloud decides: PL8 on the ASX is a listed company.
    expect(futuresGenericListing("CL1", "NYMEX")?.root).toBe("CL");
    expect(futuresGenericListing("VX1:CFE")?.root).toBe("VX");
    expect(futuresGenericListing("PL8", "ASX")).toBeNull();
    expect(chartFuturesGeneric(buildPriceChartPreset("PL8:ASX"))).toBeNull();
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
