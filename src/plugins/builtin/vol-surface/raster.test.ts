import { expect, test } from "bun:test";
import { SURFACE_3D_DELTAS } from "./model";
import { deltaLabel, tenorLabel, volatilitySurfaceInput, volatilityTicks } from "./raster";

test("delta surfaces label 10P, 25P, ATM, 25C and 10C, ridge the ATM column and span the bulk of the vols", () => {
  const volatilities = [0.02, 0.1, 0.5].map((years) => SURFACE_3D_DELTAS.map((delta) => 0.2 + (delta < 0 ? 0.3 + delta : 0) + years * 0.05));
  volatilities[0]![0] = 3; // one wild front wing cell
  const input = volatilitySurfaceInput({ tenors: [0.02, 0.1, 0.5], moneyness: SURFACE_3D_DELTAS, volatilities, axis: "delta" }, { tenorIndex: 1, moneynessIndex: 8 });
  expect(input.xTicks.map((tick) => tick.label)).toEqual(["10P", "25P", "ATM", "25C", "10C"]);
  expect(input.xTicks.map((tick) => tick.position)).toEqual([0, 3 / 16, 0.5, 13 / 16, 1]);
  expect(input.ridgeColumn).toBe(8);
  expect(input.zMax).toBeLessThan(1);
  expect(input.selected).toEqual({ row: 1, column: 8 });
  expect(input.titles.x).toBe("DELTA");
});

test("moneyness surfaces place ticks by value and ridge K/F = 1 between columns", () => {
  const input = volatilitySurfaceInput({ tenors: [0.1, 0.5], moneyness: [0.8, 0.95, 1.05, 1.2], volatilities: [[0.3, 0.22, 0.2, 0.21], [0.28, 0.23, 0.21, 0.22]] }, null);
  expect(input.xTicks.map((tick) => tick.label)).toEqual(["80%", "90%", "100%", "110%", "120%"]);
  expect(input.ridgeColumn).toBeCloseTo(1.5, 9);
  expect(input.titles.x).toBe("FORWARD MONEYNESS");
});

test("labels and vol ticks", () => {
  expect([deltaLabel(-0.1), deltaLabel(0), deltaLabel(0.25)]).toEqual(["10P", "ATM", "25C"]);
  expect([tenorLabel(2 / 365), tenorLabel(90 / 365), tenorLabel(1), tenorLabel(2.3)]).toEqual(["2D", "3M", "1Y", "2.3Y"]);
  expect(volatilityTicks(0.11, 0.26)).toEqual([0.15, 0.2, 0.25]);
});
