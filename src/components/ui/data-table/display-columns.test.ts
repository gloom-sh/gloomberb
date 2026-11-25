import { expect, test } from "bun:test";
import { createDataTableCsv } from "../../data-table/export";
import { MISSING_VALUE } from "../../../utils/format";
import { dataTableDisplayColumns } from "./display-columns";
import type { DataTableColumn, DataTableProps } from "./types";

type Row = { id: string; value: number | null; section?: boolean };
const columns: DataTableColumn[] = [
  { id: "id", label: "ID", width: 10, align: "left" },
  { id: "value", label: "Value", width: 10, align: "right", omitWhenEmpty: true },
];
const table = (items: Row[]) => ({
  columns, items,
  getItemKey: (row: Row) => row.id,
  isSelected: () => false,
  renderSectionHeader: (row: Row) => row.section ? { text: row.id } : null,
  renderCell: (row: Row, column: DataTableColumn) => column.id === "id"
    ? { text: row.id } : { text: row.value == null ? MISSING_VALUE : String(row.value), value: row.value },
});

test("only opted-in columns with no data cells leave; zero and a late populated row keep them", () => {
  const empty = table([{ id: "empty", value: null }, { id: "section", value: 12, section: true }]);
  expect(dataTableDisplayColumns(empty).map((column) => column.id)).toEqual(["id"]);
  expect(dataTableDisplayColumns(table([])).map((column) => column.id)).toEqual(["id"]);
  const mixed = table([{ id: "empty", value: null }, { id: "zero", value: 0 }]);
  expect(dataTableDisplayColumns(mixed, { start: 0, end: 1 })).toEqual(columns);
  expect(mixed.items.map((row) => mixed.renderCell(row, columns[1]!).text)).toEqual([MISSING_VALUE, "0"]);
});

test("a visible-window column returns when scrolling to a row with coverage", () => {
  const props = { ...table([{ id: "old", value: 36.73 }, { id: "recent", value: null }]),
    columns: columns.map((column) => column.id === "value" ? { ...column, omitWhenEmpty: "visible" as const } : column) };
  expect(dataTableDisplayColumns(props, { start: 1, end: 2 }).map((column) => column.id)).toEqual(["id"]);
  expect(dataTableDisplayColumns(props, { start: 0, end: 1 }).map((column) => column.id)).toEqual(["id", "value"]);
  expect(dataTableDisplayColumns(props)).toHaveLength(2);
  // A covered row cut at the viewport's edge is not in view, unless only cut rows fit.
  expect(dataTableDisplayColumns(props, { start: 0, end: 2, wholeStart: 1, wholeEnd: 2 }).map((column) => column.id)).toEqual(["id"]);
  expect(dataTableDisplayColumns(props, { start: 0, end: 1, wholeStart: 0, wholeEnd: 0 })).toHaveLength(2);
});

test("omitting a drawn column never removes its CSV field or turns null into a number", () => {
  const props = table([{ id: "empty", value: null }]);
  expect(dataTableDisplayColumns(props)).toHaveLength(1);
  expect(createDataTableCsv(props as DataTableProps<Row>)).toBe("\uFEFFID,Value\nempty,");
});

test("a column every row shows alike leaves, blank or not; one row, one differing row or a section header keep it", () => {
  const same = (items: Row[]) => ({ ...table(items), columns: columns.map((column) => column.id === "value" ? { ...column, omitWhenEmpty: undefined, omitWhenSame: true } : column) });
  const ids = (props: ReturnType<typeof same>) => dataTableDisplayColumns(props).map((column) => column.id);
  expect(ids(same([{ id: "a", value: 2 }, { id: "b", value: 2 }, { id: "c", value: 2 }]))).toEqual(["id"]);
  expect(ids(same([{ id: "a", value: null }, { id: "b", value: null }]))).toEqual(["id"]);
  expect(ids(same([{ id: "a", value: 2 }, { id: "b", value: 3 }]))).toEqual(["id", "value"]);
  expect(ids(same([{ id: "a", value: 2 }, { id: "b", value: null }]))).toEqual(["id", "value"]);
  // A lone row says nothing about what the others would show.
  expect(ids(same([{ id: "a", value: 2 }]))).toEqual(["id", "value"]);
  expect(ids(same([{ id: "a", value: 2 }, { id: "group", value: 9, section: true }, { id: "b", value: 2 }]))).toEqual(["id"]);
  // The CSV keeps the column a view shares.
  const props = same([{ id: "a", value: 2 }, { id: "b", value: 2 }]);
  expect(createDataTableCsv(props as DataTableProps<Row>)).toBe("﻿ID,Value\na,2\nb,2");
});
