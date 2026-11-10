import { expect, test } from "bun:test";
import { createTestResolvedSeries, createTestSeriesPoint } from "../test-support/time-series";
import { assignAxes } from "./series-presentation";

/** Each series' axis, and the warnings, for prices given as [symbol, unit, unitGroup]. */
function axes(prices: Array<[string, string, string]>) {
  const warnings: string[] = [];
  const series = prices.map(([id, unit, unitGroup]) => createTestResolvedSeries({ id, unit, unitGroup, points: [] }));
  const assigned = assignAxes(series, series.map(({ id }) => ({ id, axis: "auto" as const })), warnings);
  return { axes: assigned.map(({ id, axis }) => `${id} ${axis}`), warnings };
}

test("prices per different physical quantities, or a price beside an FX rate, scale on axes of their own", () => {
  // Heating oil and gasoline per gallon on one axis, Brent per barrel on the other.
  expect(axes([["HO=F", "USD / gallon", "price:USD"], ["BZ=F", "USD / barrel", "price:USD"], ["RB=F", "USD / gallon", "price:USD"]]))
    .toEqual({ axes: ["HO=F left", "BZ=F right", "RB=F left"], warnings: [] });
  // A third quantity in dollars shares as it would without them, unwarned.
  expect(axes([["HO=F", "USD / gallon", "price:USD"], ["BZ=F", "USD/bbl", "price:USD"], ["NG=F", "USD / MMBtu", "price:USD"]]))
    .toEqual({ axes: ["HO=F left", "BZ=F right", "NG=F left"], warnings: [] });
  expect(axes([["BZ=F", "USD / barrel", "price:USD"], ["EURUSD=X", "USD / EUR", "price:USD"]]).axes)
    .toEqual(["BZ=F left", "EURUSD=X right"]);
});

test("per-share and per-unit prices, and FX rates quoted in one currency, share an axis as any prices in it do", () => {
  expect(axes([["AAPL", "USD/share", "price:USD"], ["BTC-USD", "USD/unit", "price:USD"], ["SPY", "USD", "price:USD"]]))
    .toEqual({ axes: ["AAPL left", "BTC-USD left", "SPY left"], warnings: [] });
  expect(axes([["EURUSD=X", "USD / EUR", "price:USD"], ["GBPUSD=X", "USD / GBP", "price:USD"], ["AUDUSD=X", "USD / AUD", "price:USD"]]))
    .toEqual({ axes: ["EURUSD=X left", "GBPUSD=X left", "AUDUSD=X left"], warnings: [] });
  // A rate quoted in yen is in another currency: its own axis, as before.
  expect(axes([["EURUSD=X", "USD / EUR", "price:USD"], ["USDJPY=X", "JPY / USD", "price:JPY"], ["GBPUSD=X", "USD / GBP", "price:USD"]]))
    .toEqual({ axes: ["EURUSD=X left", "USDJPY=X right", "GBPUSD=X left"], warnings: [] });
});

test("a price under a tenth of another's in the same unit goes on the right axis, with what is drawn in its price", () => {
  const price = (id: string, close: number, extra: Partial<Parameters<typeof createTestResolvedSeries>[0]> = {}) => createTestResolvedSeries({
    id, unit: "USD / troy oz", unitGroup: "price:USD", listing: { symbol: id, exchange: "" },
    points: [createTestSeriesPoint("2026-11-10", close), createTestSeriesPoint("2026-11-11", close * 1.01)], ...extra,
  });
  const place = (series: ReturnType<typeof price>[], specs: Array<{ id: string; axis: "auto" | "left" | "right" }> = series.map(({ id }) => ({ id, axis: "auto" }))) =>
    assignAxes(series, specs, []).map(({ id, axis }) => `${id} ${axis}`);
  // Silver at $52 beside gold at $4,050 drew flat on gold's $0-$4K axis; in either order it takes the right one.
  expect(place([price("GC=F", 4050), price("SI=F", 51.8)])).toEqual(["GC=F left", "SI=F right"]);
  expect(place([price("SI=F", 51.8), price("GC=F", 4050)])).toEqual(["SI=F right", "GC=F left"]);
  // Its moving average follows it; a study of gold, and prices within a tenth, stay on the left.
  const silverAverage = price("SI=F:sma", 51.5, { listing: undefined, priceOf: "SI=F" });
  const goldAverage = price("GC=F:sma", 4000, { listing: undefined, priceOf: "GC=F" });
  expect(place([price("GC=F", 4050), price("SI=F", 51.8), silverAverage, goldAverage]))
    .toEqual(["GC=F left", "SI=F right", "SI=F:sma right", "GC=F:sma left"]);
  expect(place([price("GC=F", 4050), price("PL=F", 1600)])).toEqual(["GC=F left", "PL=F left"]);
  // An axis a spec names stays, and a right axis already taken leaves the prices sharing.
  expect(place([price("GC=F", 4050), price("SI=F", 51.8)], [{ id: "GC=F", axis: "auto" }, { id: "SI=F", axis: "left" }]))
    .toEqual(["GC=F left", "SI=F left"]);
  const rate = createTestResolvedSeries({ id: "EURUSD=X", unit: "USD / EUR", unitGroup: "price:USD", points: [createTestSeriesPoint("2026-11-10", 1.1)] });
  expect(place([price("GC=F", 4050), rate as ReturnType<typeof price>, price("SI=F", 51.8)])).toEqual(["GC=F left", "EURUSD=X right", "SI=F left"]);
});
