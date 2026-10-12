import { expect, test } from "bun:test";
import { turbo } from "../../../components/chart/surface3d/model";
import { heatGridColumns, heatGridTenorLabel, surfaceColorHex, surfaceTextColor } from "./heat-grid";
import { SURFACE_3D_DELTAS } from "./model";

test("the grid colours a vol with the 3D mesh's scale over the same range", () => {
  const range = { zMin: 0.3, zMax: 0.4 };
  const color = turbo(0.5);
  const hex = (value: number) => Math.round(value * 255).toString(16).padStart(2, "0");
  expect(surfaceColorHex(0.35, range)).toBe(`#${hex(color.r)}${hex(color.g)}${hex(color.b)}`);
  // Outside the range the scale holds its end colours.
  expect(surfaceColorHex(0.9, range)).toBe(surfaceColorHex(0.4, range));
  expect(surfaceColorHex(0.1, range)).toBe(surfaceColorHex(0.3, range));
  expect(surfaceTextColor(surfaceColorHex(0.3, range))).toBe("#f4f4f4");
  expect(surfaceTextColor(surfaceColorHex(0.35, range))).toBe("#101010");
});

test("a narrow grid samples the deltas evenly and always keeps ATM", () => {
  const deltas = [...SURFACE_3D_DELTAS];
  const atm = deltas.indexOf(0);
  expect(heatGridColumns(deltas, 130)).toEqual(deltas.map((_, index) => index));
  for (const width of [30, 44, 58, 80]) {
    const shown = heatGridColumns(deltas, width);
    expect(shown.length).toBe(Math.floor((width - 10) / 7));
    expect(shown).toContain(atm);
    expect([...shown].sort((a, b) => a - b)).toEqual(shown);
    expect(new Set(shown).size).toBe(shown.length);
  }
  expect(heatGridColumns(deltas, 3)).toHaveLength(1);
});

test("expiries inside the first months read in days so neighbours stay apart", () => {
  expect(["5D", "39D", "46D"]).toEqual([5, 39, 46].map((days) => heatGridTenorLabel(days / 365)));
  expect(heatGridTenorLabel(0.5)).toBe("6M");
  expect(heatGridTenorLabel(1.7)).toBe("1.7Y");
});
