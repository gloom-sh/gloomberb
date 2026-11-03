import { expect, test } from "bun:test";
import { formatCompact } from "../../../utils/format";
import { figureColumnCells } from "./render-cell";
import type { DataTableColumn } from "./types";

const column = (align: "left" | "right", width = 10): DataTableColumn => ({ id: align, label: align, width, align });

test("a right-aligned column keeps its compact figures' decimals, prose and other columns keep the short form", () => {
  const cell = figureColumnCells<number, DataTableColumn>((value) => ({ text: formatCompact(value) }));
  expect(cell(12_000_000, column("right"), 0, { selected: false }).text).toBe("12.00M");
  expect(cell(12_000_000, column("left"), 0, { selected: false }).text).toBe("12M");
  expect(formatCompact(12_000_000)).toBe("12M");
  const bracket = figureColumnCells<number, DataTableColumn>((value) => ({ text: formatCompact(value, { fixedDecimals: false }) }));
  expect(bracket(1_000, column("right"), 0, { selected: false }).text).toBe("1k");
});

test("a column sized to the short figures keeps the short one where the decimals would not fit", () => {
  const cell = figureColumnCells<number, DataTableColumn>((value) => ({ text: `$${formatCompact(value)}` }));
  expect(cell(4_200_000, column("right", 6), 0, { selected: false }).text).toBe("$4.20M");
  expect(cell(900_000, column("right", 6), 0, { selected: false }).text).toBe("$900k");
});

test("a cell that throws leaves later formatting outside the column", () => {
  const cell = figureColumnCells<number, DataTableColumn>(() => { throw new Error("bad row"); });
  expect(() => cell(1, column("right"), 0, { selected: false })).toThrow("bad row");
  expect(formatCompact(12_000_000)).toBe("12M");
});
