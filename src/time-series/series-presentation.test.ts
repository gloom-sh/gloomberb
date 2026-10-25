import { expect, test } from "bun:test";
import { createTestResolvedSeries } from "../test-support/time-series";
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
