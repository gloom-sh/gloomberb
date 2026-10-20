import { expect, test } from "bun:test";
import { getTableWidth } from "../../../components/ui/table-layout";
import { parseScreenDefinition } from "./model";
import { resultColumns } from "./pane";

const definition = parseScreenDefinition({
  version: 1,
  criteria: [{ field: "symbol", op: "in", value: ["LMT", "RTX", "NOC", "GD"] }],
  sort: { field: "returnYtdPercent", direction: "desc" },
  currency: "USD",
});
const ids = (width: number, base: string | null) =>
  resultColumns(width, definition, "returnYtdPercent", false, [], base).map((column) => column.id);
const ytd = (width: number) =>
  resultColumns(width, definition, "returnYtdPercent", false, [], "31 Dec").find((column) => column.id === "m:returnYtdPercent")!.label;

test("YTD names its base close in every width, and the longer header never costs a column", () => {
  for (let width = 60; width <= 240; width++) {
    const columns = resultColumns(width, definition, "returnYtdPercent", false, [], "31 Dec");
    expect(getTableWidth(columns)).toBeLessThanOrEqual(width);
    expect(["YTD% vs 31 Dec", "YTD% 31 Dec"]).toContain(ytd(width));
  }
  // A full-width pane keeps its sector column beside `YTD% vs 31 Dec`.
  expect(ids(178, "31 Dec")).toEqual(ids(178, null));
  expect(ytd(178)).toBe("YTD% vs 31 Dec");
  // Where the long header would push a column out, the short one stays.
  expect(ids(160, "31 Dec")).toContain("sector");
  expect(ytd(160)).toBe("YTD% 31 Dec");
  expect(ytd(80)).toBe("YTD% 31 Dec");
});
