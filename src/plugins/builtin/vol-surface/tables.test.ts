import { expect, test } from "bun:test";
import type { DataTableCell, DataTableColumn } from "../../../components/ui";
import { createDataTableCsv } from "../../../components/data-table/export";
import { EXCEL_CSV_BOM } from "../../../utils/csv";
import { fitVolatilitySmile } from "../shared/volatility";
import { buildSurfaceGrid, DEFAULT_SURFACE_SETTINGS, pendingSurfaceExpiry, type SurfaceExpiry, type SurfaceGridRow,
  type SurfacePoint, type SurfaceSnapshot } from "./model";
import { surfaceExpiryTable, surfaceTenorCell } from "./tables";

const now = Date.UTC(2026, 8, 22);
// A Deribit expiry, stamped at its 08:00 UTC settlement, and two listed ones dated by their day.
const expiries: SurfaceExpiry[] = [Date.UTC(2026, 9, 30, 8), Date.UTC(2026, 11, 18), Date.UTC(2027, 2, 19)].map((date) => {
  const expiry = pendingSurfaceExpiry(date / 1000, now);
  const points = [90, 100, 110].map((strike) => ({ strike, volatility: 0.25, logMoneyness: Math.log(strike / 100), fitResidual: 0 })) as SurfacePoint[];
  return { ...expiry, state: "ready", points, forward: 100, rate: 0.04, dividendYield: 0.04, rateAsOf: ["2026-09-21"],
    source: "test", asOf: "2026-09-22T13:45:00Z", atmIV: 0.25, fit: fitVolatilitySmile(points, expiry.years) };
});
const snapshot: SurfaceSnapshot = { symbol: "AAPL", spot: 100, spotAsOf: "2026-09-22T14:00:00Z", phase: "ready",
  settings: DEFAULT_SURFACE_SETTINGS, requested: 3, loaded: 3, failed: 0, failures: [], warnings: [],
  catalogue: expiries.map((expiry) => expiry.expiration), expiries, rateAsOf: "2026-09-21", fetchedAt: now };

/** The pane's export of a table: each line split into its cells (none of these hold a comma). */
function exported<T>(columns: DataTableColumn[], items: T[], cell: (item: T, id: string) => DataTableCell): string[][] {
  const csv = createDataTableCsv({ columns, items, renderCell: (item, column) => cell(item, column.id) });
  return csv.slice(EXCEL_CSV_BOM.length).split("\n").map((line) => line.split(","));
}

function expiryTable(forwards: boolean) {
  const { fields, cell } = surfaceExpiryTable(snapshot, forwards);
  const columns: DataTableColumn[] = [{ id: "expiry", label: "Expiry", width: 22, align: "left" },
    ...fields.map((label, index): DataTableColumn => ({ id: String(index), label, width: 12, align: "right" }))];
  return { cell, rows: exported(columns, expiries, cell) };
}

test("OVDV's Skew and Forwards tables draw expiries and the as-of day first and export them in ISO", () => {
  const skew = expiryTable(false);
  expect(expiries.map((entry) => skew.cell(entry, "expiry").text)).toEqual(["30 Oct 2026 08:00 UTC", "18 Dec 2026", "19 Mar 2027"]);
  expect(skew.rows.slice(1).map((row) => row[0])).toEqual(["2026-10-30 08:00 UTC", "2026-12-18", "2027-03-19"]);

  const forwards = expiryTable(true);
  expect(forwards.rows[0]).toEqual(["Expiry", "Forward", "Basis", "Div %", "Rate %", "Pairs", "As of"]);
  expect(forwards.cell(expiries[0]!, "5").text).toBe("22 Sep 2026");
  expect(forwards.rows.slice(1).map((row) => [row[0], row[6]])).toEqual([
    ["2026-10-30 08:00 UTC", "2026-09-22"], ["2026-12-18", "2026-09-22"], ["2027-03-19", "2026-09-22"]]);
});

test("OVDV's grid exports a listed expiry's ISO day, its fit mark kept, and a fixed tenor as it reads", () => {
  const listed = buildSurfaceGrid(snapshot, { coordinates: [0.9, 1, 1.1] }).rows;
  const fixed = buildSurfaceGrid(snapshot, { coordinates: [0.9, 1, 1.1], tenors: "fixed" }).rows.slice(3, 4);
  const rows: SurfaceGridRow[] = [...listed.slice(0, 2), { ...listed[2]!, extrapolated: true }, ...fixed];
  const columns: DataTableColumn[] = [{ id: "tenor", label: "Expiry / tenor", width: 14, align: "left" }];
  expect(rows.map((row) => surfaceTenorCell(row).text)).toEqual(["30 Oct 2026", "18 Dec 2026", "19 Mar 2027 E", "2M I"]);
  expect(exported(columns, rows, (row) => surfaceTenorCell(row)).map((row) => row[0]))
    .toEqual(["Expiry / tenor", "2026-10-30", "2026-12-18", "2027-03-19 E", "2M I"]);
});
