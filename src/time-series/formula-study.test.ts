import { describe, expect, test } from "bun:test";
import { validateChartSpec } from "./spec";
import { resolveStudies } from "./studies";
import { applyResolvedSeriesTransform } from "./transforms";
import { contractPriceUnit, perBarrelUnit } from "./price-units";
import { CHART_SPEC_VERSION, type ChartStudySpec, type ResolvedSeries, type TimeSeriesPoint } from "./types";

/** A futures price series: `days` maps a day of January 2026 to its settle. */
function future(symbol: string, unit: string, days: Record<number, number>, currency = "USD"): ResolvedSeries {
  const points: TimeSeriesPoint[] = Object.entries(days).map(([day, value]) => {
    const date = new Date(Date.UTC(2026, 0, Number(day)));
    return { date, observedAt: date, availableAt: date, value, close: value };
  });
  return {
    id: symbol, label: `${symbol}:NYM Price`, color: "#fff", unit, unitGroup: `price:${currency}`, statedUnit: unit,
    priceAssetCategory: "FUTURE", listing: { symbol, exchange: "NYM" }, nativeFrequency: "daily", dataShape: "ohlcv",
    style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none", observationKind: "market", points,
  };
}

function formula(inputs: string[], parameters: Record<string, number>): ChartStudySpec {
  return { id: "formula", kind: "formula", inputSeriesIds: inputs, parameters, panelId: "formula", axis: "auto" };
}

const HO = future("HO=F", "USD / gallon", { 1: 2.5, 2: 2.6, 3: 2.4 });
const RB = future("RB=F", "USD / gallon", { 1: 2, 2: 2.1, 3: 2.2 });
const CL = future("CL=F", "USD / barrel", { 1: 70, 3: 72 });
const BZ = future("BZ=F", "USD / barrel", { 1: 75, 2: 76, 3: 77 });

describe("formula studies", () => {
  test("42 gallons of a per-gallon leg are a barrel: the crack is per barrel, on every date of either leg", () => {
    const result = resolveStudies([HO, CL], [formula(["HO=F", "CL=F"], { weight1: 42, perBarrel1: 1, weight2: -1, divisor: 1 })]);
    expect(result.errors).toEqual([]);
    const crack = result.series.find(({ id }) => id === "formula")!;
    expect(crack).toMatchObject({ label: "42×HO=F - CL=F", unit: "USD / barrel", statedUnit: "USD / barrel", unitGroup: "price:USD" });
    // CL=F has no settle on the 2nd: its 1st carries forward.
    expect(crack.points.map(({ value }) => value)).toEqual([42 * 2.5 - 70, 42 * 2.6 - 70, 42 * 2.4 - 72].map((value) => expect.closeTo(value, 9)));
  });

  test("the 3:2:1 crack divides the weighted sum by three barrels of crude", () => {
    const result = resolveStudies([RB, HO, CL], [formula(["RB=F", "HO=F", "CL=F"], {
      weight1: 84, perBarrel1: 1, weight2: 42, perBarrel2: 1, weight3: -3, divisor: 3,
    })]);
    expect(result.errors).toEqual([]);
    const crack = result.series[0]!;
    expect(crack.label).toBe("(2×42×RB=F + 42×HO=F - 3×CL=F)/3");
    expect(crack.unit).toBe("USD / barrel");
    expect(crack.points[0]?.value).toBeCloseTo((84 * 2 + 42 * 2.5 - 3 * 70) / 3, 9);
  });

  test("any other multiplier keeps a leg's unit, so gallons and barrels still do not mix", () => {
    const result = resolveStudies([HO, CL], [formula(["HO=F", "CL=F"], { weight1: 84, weight2: -1, divisor: 1 })]);
    expect(result.series).toEqual([]);
    expect(result.errors).toEqual(["formula: HO=F is USD / gallon and CL=F is USD / barrel: write 42*HO=F to compare per barrel."]);
    // Two per-gallon legs need no conversion.
    expect(resolveStudies([HO, RB], [formula(["HO=F", "RB=F"], { weight1: 1, weight2: -1, divisor: 1 })]).series[0]?.unit)
      .toBe("USD / gallon");
  });

  test("a spread names both legs' units and the fix, whichever side the gallons are on", () => {
    expect(resolveStudies([HO, BZ], [{ ...formula(["HO=F", "BZ=F"], {}), id: "spread", kind: "spread" }]).errors)
      .toEqual(["spread: HO=F is USD / gallon and BZ=F is USD / barrel: write 42*HO=F to compare per barrel."]);
    expect(resolveStudies([BZ, HO], [{ ...formula(["BZ=F", "HO=F"], {}), id: "spread", kind: "spread" }]).errors)
      .toEqual(["spread: BZ=F is USD / barrel and HO=F is USD / gallon: write 42*HO=F to compare per barrel."]);
    // Two barrels, spaced or not, subtract.
    const brent = { ...BZ, unit: "USD/barrel", statedUnit: undefined };
    const spread = resolveStudies([CL, brent], [{ ...formula(["CL=F", "BZ=F"], {}), id: "spread", kind: "spread" }]);
    expect(spread.errors).toEqual([]);
    expect(spread.series[0]).toMatchObject({ unit: "USD / barrel", statedUnit: "USD / barrel" });
  });

  test("a mismatch names each leg's unit: another currency, cents, or a price with no quantity", () => {
    const ttf = future("TTF=F", "EUR / MWh", { 1: 30 }, "EUR");
    const corn = future("ZC=F", "US cents / bushel", { 1: 450 }, "USX");
    const bare = { ...future("XX=F", "USD", { 1: 5 }), statedUnit: undefined };
    const error = (left: ResolvedSeries, right: ResolvedSeries) => resolveStudies([left, right], [
      formula([left.id, right.id], { weight1: 1, weight2: -1, divisor: 1 }),
    ]).errors;
    expect(error(ttf, CL)).toEqual(["formula: TTF=F is EUR / MWh and CL=F is USD / barrel: a formula does not convert currencies."]);
    expect(error(corn, CL)).toEqual(["formula: ZC=F is US cents / bushel and CL=F is USD / barrel: a formula does not convert currencies."]);
    expect(error(bare, CL)).toEqual(["formula: XX=F is in USD per an unknown quantity and CL=F is USD / barrel: a formula needs every leg in one known unit."]);
  });

  test("a saved formula with a multiplier or divisor no formula was written with is an error, not a silent 1", () => {
    const error = (parameters: Record<string, number>) => resolveStudies([HO, CL], [formula(["HO=F", "CL=F"], parameters)]);
    // A value that is not a number is dropped when a spec loads, so it arrives missing.
    expect(error({ weight1: 42, perBarrel1: 1, divisor: 1 })).toMatchObject({
      series: [], errors: ["formula: The multiplier of CL=F is missing or not a number; write the formula again."],
    });
    expect(error({ weight1: Number.NaN, weight2: -1 }).errors).toEqual(["formula: The multiplier of HO=F is missing or not a number; write the formula again."]);
    expect(error({ weight1: 0, weight2: -1 }).errors).toEqual(["formula: HO=F has a multiplier of 0, which removes it; leave it out of the formula instead."]);
    expect(error({ weight1: 42, perBarrel1: 1, weight2: -1, divisor: 0 }).errors).toEqual(["formula: A formula cannot be divided by 0."]);
    expect(error({ weight1: 42, perBarrel1: 1, weight2: -1, divisor: Number.POSITIVE_INFINITY }).errors)
      .toEqual(["formula: The formula's divisor is not a number; write the formula again."]);
    // No divisor is a divisor of 1.
    expect(error({ weight1: 42, perBarrel1: 1, weight2: -1 }).series[0]?.points[0]?.value).toBeCloseTo(42 * 2.5 - 70, 9);
  });

  test("a rebased or log chart of a future no longer states its contract unit", () => {
    expect(applyResolvedSeriesTransform(HO, "percent").statedUnit).toBeUndefined();
    expect(applyResolvedSeriesTransform(HO, "raw").statedUnit).toBe("USD / gallon");
    // A moving average is still in gallons; RSI is not.
    const studies = resolveStudies([HO], [
      { id: "sma", kind: "sma", inputSeriesIds: ["HO=F"], parameters: { period: 2 }, panelId: "main", axis: "auto" },
      { id: "rsi", kind: "rsi", inputSeriesIds: ["HO=F"], parameters: { period: 2 }, panelId: "rsi", axis: "auto" },
    ]);
    expect(studies.series.find(({ id }) => id === "sma")?.statedUnit).toBe("USD / gallon");
    expect(studies.series.find(({ id }) => id === "rsi")?.statedUnit).toBeUndefined();
  });

  test("a formula takes one series or more, up to a chart's limit", () => {
    const spec = (inputs: string[]) => ({
      version: CHART_SPEC_VERSION,
      viewport: { range: "1Y", resolution: "auto" },
      panels: [{ id: "main" }, { id: "formula" }],
      series: inputs.map((id) => ({ id, source: { kind: "security", instrument: { symbol: id }, fieldId: "market.close" },
        style: "line", transform: "raw", axis: "auto", panelId: "main", interpolation: "none" })),
      studies: [formula(inputs, { weight1: 42, divisor: 1 })],
    });
    expect(validateChartSpec(spec(["HO=F", "RB=F", "CL=F"])).errors).toEqual([]);
    expect(validateChartSpec({ ...spec(["HO=F"]), studies: [formula([], {})] }).errors)
      .toEqual([expect.objectContaining({ code: "wrong-input-count", message: "formula requires 1 to 20 input series." })]);
  });
});

describe("futures price units", () => {
  test("a contract's unit is the price's only when it names the quote's currency", () => {
    expect(contractPriceUnit("USD / gallon", "USD")).toBe("USD / gallon");
    expect(contractPriceUnit("US cents / bushel", "USX")).toBe("US cents / bushel");
    expect(contractPriceUnit("US cents / bushel", "USD")).toBeNull();
    expect(contractPriceUnit("% of par", "USD")).toBeNull();
    expect(contractPriceUnit("index points", "USD")).toBeNull();
    expect(contractPriceUnit("USD / gallon", undefined)).toBeNull();
  });

  test("a per-gallon unit becomes per barrel in the same wording", () => {
    expect(perBarrelUnit("USD / gallon")).toBe("USD / barrel");
    expect(perBarrelUnit("USD/gallon")).toBe("USD/barrel");
    expect(perBarrelUnit("US cents / gallon")).toBe("US cents / barrel");
    expect(perBarrelUnit("USD / barrel")).toBe("USD / barrel");
    expect(perBarrelUnit("USD / MMBtu")).toBe("USD / MMBtu");
  });
});
