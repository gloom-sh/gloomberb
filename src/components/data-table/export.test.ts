import { expect, test } from "bun:test";
import { EXCEL_CSV_BOM } from "../../utils/csv";
import type { DataTableCell, DataTableColumn } from "../ui";
import { createDataTableCsv } from "./export";
import { daysInTextCell } from "../ui/day-cell";

function csvRows(
  columns: DataTableColumn[],
  rows: Array<Record<string, string | DataTableCell>>,
  getExportMetadata?: () => readonly (readonly unknown[])[],
): string[] {
  const csv = createDataTableCsv({
    columns,
    items: rows,
    renderCell: (row, column) => {
      const cell = row[column.id]!;
      return typeof cell === "string" ? { text: cell } : cell;
    },
    getExportMetadata,
  });
  expect(csv.startsWith(EXCEL_CSV_BOM)).toBe(true);
  return csv.slice(EXCEL_CSV_BOM.length).split("\n");
}

const right = (id: string, label: string): DataTableColumn => ({ id, label, width: 10, align: "right" });
const left = (id: string, label: string): DataTableColumn => ({ id, label, width: 10, align: "left" });

test("exports numbers instead of the formatted text, with the dropped unit in the header", () => {
  expect(csvRows(
    [left("name", "Name"), right("chg", "Change"), right("pct", "CHG%"), right("cap", "MCAP"), right("px", "Last"), right("pe", "P/E"), right("spd", "Spread")],
    [
      { name: "S&P 500", chg: "+12.30", pct: "+1.25%", cap: "1.20B", px: "$1,234.50", pe: "21.4x", spd: "+12bp \u2191" },
      { name: "Nikkei", chg: "-2.10", pct: "-0.40%", cap: "999.50", px: "$0.07", pe: "9.0x", spd: "-3.5bp \u2193" },
      { name: "DAX", chg: "—", pct: "—", cap: "12.3k", px: "…", pe: "--", spd: "0bp" },
    ],
  )).toEqual([
    "Name,Change,CHG%,MCAP,Last ($),P/E (x),Spread (bp)",
    "S&P 500,12.30,1.25,1200000000,1234.50,21.4,12",
    "Nikkei,-2.10,-0.40,999.50,0.07,9.0,-3.5",
    "DAX,,,12300,,,0",
  ]);
});

test("a percent column gets % in its header", () => {
  expect(csvRows([right("share", "Share")], [{ share: "12.5%" }, { share: "-0.1%" }]))
    .toEqual(["Share (%)", "12.5", "-0.1"]);
});

test("keeps the text of a column that mixes units or holds words", () => {
  expect(csvRows(
    [right("level", "Level"), right("time", "Time"), right("state", "State"), left("tenor", "Tenor")],
    [
      { level: "4.125%", time: "14:32", state: "OPEN", tenor: "3M" },
      { level: "12.5bp", time: "Sep 25", state: "—", tenor: "-" },
    ],
  )).toEqual([
    "Level,Time,State,Tenor",
    "4.125%,14:32,OPEN,3M",
    "12.5bp,Sep 25,,",
  ]);
});

test("a cell's own value wins: full precision numbers and ISO dates", () => {
  expect(csvRows(
    [left("date", "Date"), right("vol", "VOL"), right("pct", "CHG%"), right("px", "Last")],
    [
      { date: { text: "Sep 25", value: "2026-09-25" }, vol: { text: "1.23M", value: 1_234_567 },
        pct: { text: "+3.45%", value: 0.0345 * 100 }, px: { text: "112'16", value: 112.5 } },
      { date: { text: "—", value: null }, vol: { text: "—", value: null },
        pct: { text: "—", value: Number.NaN }, px: { text: "—" } },
    ],
  )).toEqual([
    "Date,VOL,CHG%,Last",
    "2026-09-25,1234567,3.45,112.5",
    ",,,",
  ]);
});

test("a day a table draws first exports in ISO, by its value or, given none, read back from a whole-cell day or time", () => {
  expect(csvRows(
    [left("day", "Day"), right("at", "At"), left("words", "Status"), left("short", "Last")],
    [
      // No value: what an ISO day became when a table started writing it day first.
      { day: "21 Aug 2026", at: "09 Oct 2026 13:21", words: daysInTextCell("Trading suspended, ended 2026-11-16"), short: "21 Aug" },
      { day: "TBD", at: "—", words: daysInTextCell("Announced: 02 Nov 2026 → 16 Nov 2026"), short: { text: "16 Nov", value: "2026-11-16" } },
    ],
  )).toEqual([
    "Day,At,Status,Last",
    "2026-08-21,2026-10-09 13:21,\"Trading suspended, ended 2026-11-16\",21 Aug",
    "TBD,,Announced: 2026-11-02 → 2026-11-16,2026-11-16",
  ]);
  // A zone the time names stays. A name that ends in a day, or a figure shaped like one, is not a day: it exports as drawn.
  expect(csvRows([left("at", "First computed"), left("name", "Bond"), left("figure", "Code")], [
    { at: "09 Oct 2026 13:21 UTC", name: "Treasury 4.25% 15 Mar 2027", figure: "31 Feb 2026" },
    { at: "09 Oct 2026 25:10", name: "Dec 2026", figure: "12 Mar 2026 1.5" },
  ])).toEqual([
    "First computed,Bond,Code",
    "2026-10-09 13:21 UTC,Treasury 4.25% 15 Mar 2027,31 Feb 2026",
    "09 Oct 2026 25:10,Dec 2026,12 Mar 2026 1.5",
  ]);
  // The words are drawn day first either way.
  expect(daysInTextCell("ended 2026-11-16").text).toBe("ended 16 Nov 2026");
  expect(daysInTextCell("Week of 2026-11-16", "no-year")).toEqual({ text: "Week of 16 Nov", value: "Week of 2026-11-16" });
});

test("a column whose rows carry different units names none in its header", () => {
  // A statement column: amounts with growth beside them, then a margin row.
  expect(csvRows(
    [left("metric", "Metric"), right("fy", "FY2025")],
    [
      { metric: { text: "  ▾ Revenue (B)", value: "Revenue (B)" }, fy: { text: "416.2  +6.4%", value: 416.161 } },
      { metric: { text: "    Gross Margin", value: "Gross Margin (%)" }, fy: { text: "46.9%", value: 46.905 } },
    ],
  )).toEqual(["Metric,FY2025", "Revenue (B),416.161", "Gross Margin (%),46.905"]);
});

test("skips section headers and a column drawn only as graphics", () => {
  const csv = createDataTableCsv({
    columns: [left("name", "Name"), left("bar", "Wall"), right("value", "Share")],
    items: [{ name: "Americas", value: "" }, { name: "2027", value: "12.5%" }],
    renderSectionHeader: (item) => item.name === "Americas" ? { text: item.name } : null,
    renderCell: (item, column) => column.id === "bar"
      ? { text: "", content: "bar" }
      : { text: item[column.id as "name" | "value"] },
  });

  expect(csv).toBe(`${EXCEL_CSV_BOM}Name,Share (%)\n2027,12.5`);
});

test("notes follow the table after a blank row, as-of first", () => {
  expect(csvRows(
    [right("value", "Value")],
    [{ value: "-1.5" }],
    () => [["units", "IV percent"], ["as of", "2026-09-25"], ["warning", "-stale feed"]],
  )).toEqual([
    "Value",
    "-1.5",
    "",
    "as of,2026-09-25",
    "units,IV percent",
    "warning,'-stale feed",
  ]);
});

test("desktop artwork beside a label never reaches the file", () => {
  expect(csvRows(
    [{ ...left("base", ""), headerLeading: "header art" }, { ...right("EUR", "EUR"), headerLeading: "header art" }],
    [{ base: { text: "USD", leading: "row art" }, EUR: { text: "0.8937", leading: "row art" } }],
  )).toEqual([",EUR", "USD,0.8937"]);
});

test("a ticker list's export names each row's listing, unit, source and as-of after its columns, and leaves out a sparkline", () => {
  // The watchlist's Export CSV read `◐ BA,18.4600,GBP,-1.83,72270000000,…,16:49,BA`: a dot on the ticker, BAE read as
  // Boeing, a market cap to three figures in a currency it did not name, a time with no date, and the ticker under 1M.
  type Row = { ticker: DataTableCell; last: DataTableCell; cap: DataTableCell; asOf: DataTableCell; spark: DataTableCell; identity: string[] | null };
  const rows: Row[] = [
    { ticker: { text: "◐ BA:LSE", value: "BA:LSE" }, last: { text: "18.4600" }, cap: { text: "72.26B", value: 72_262_635_416.7568, valueUnit: "USD" },
      asOf: { text: "16:49", value: "2026-11-06T16:49:00.000Z" },
      spark: { text: "", content: "chart" }, identity: ["CLOSED", "delayed", "", "BA:LSE", "GBP", "", "Gloom Cloud", "2026-11-06T16:49:00.000Z"] },
    { ticker: { text: "FX (EUR)" }, last: { text: "—" }, cap: { text: "—", value: null, valueUnit: "USD" }, asOf: { text: "—" },
      spark: { text: "", content: "chart" }, identity: null },
  ];
  const headers = ["Session", "Feed", "status", "symbol_or_series", "currency_or_unit", "interval", "source", "as_of"];
  const csv = createDataTableCsv<Row>({
    columns: [left("ticker", "TICKER"), right("last", "LAST"), right("cap", "MCAP"), left("asOf", "AS OF UTC"), left("spark", "1M")],
    items: rows,
    renderCell: (row, column) => row[column.id as "ticker" | "last" | "cap" | "asOf" | "spark"],
    exportIdentity: { headers, cells: (row) => row.identity },
  });
  expect(csv.slice(EXCEL_CSV_BOM.length).split("\n")).toEqual([
    `TICKER,LAST,MCAP (USD),AS OF UTC,${headers.join(",")}`,
    "BA:LSE,18.4600,72262635416.7568,2026-11-06T16:49:00.000Z,CLOSED,delayed,,BA:LSE,GBP,,Gloom Cloud,2026-11-06T16:49:00.000Z",
    "FX (EUR),,,,,,,,,,,",
  ]);
});
