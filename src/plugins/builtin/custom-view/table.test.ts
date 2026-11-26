import { expect, test } from "bun:test";
import type { HeadlessPaneColumn } from "../../../types/headless";
import { formatCompact, formatPercentRaw } from "../../../utils/format";
import { sizeViewColumns, viewCellColumns, viewCellExportValue, viewCellText } from "./table";
import { normalizeViewSpec, type ViewRow } from "./view-spec";

const MOST_COLUMNS: HeadlessPaneColumn[] = [
  { key: "rank", header: "Rank", align: "right" },
  { key: "symbol", header: "Symbol" },
  { key: "name", header: "Name" },
  { key: "price", header: "Last", align: "right", format: (value) => `$${Number(value).toFixed(2)}` },
  { key: "changePercent", header: "Change %", align: "right", format: (value) => formatPercentRaw(Number(value)) },
  { key: "volume", header: "Volume", align: "right", format: (value) => formatCompact(Number(value), { fixedDecimals: true }) },
];

const MOVERS: ViewRow[] = [
  { rank: 1, symbol: "NVDA", name: "NVIDIA Corporation", price: 181.5, changePercent: 1.68, volume: 212_345_678 },
  { rank: 2, symbol: "AMD", name: "Advanced Micro Devices, Inc.", price: 162.04, changePercent: -2.1, volume: 61_000_000 },
  { rank: 3, symbol: "BRK.B", name: "Berkshire Hathaway Inc. New", price: 498.2, changePercent: 0.12, volume: 3_400_000 },
];

const sized = (spec: unknown, columns: HeadlessPaneColumn[], rows: ViewRow[], live?: Set<string>) => {
  const cells = viewCellColumns(normalizeViewSpec(spec), columns);
  return sizeViewColumns(cells, rows, (row, column) => viewCellText(row, column), live);
};

test("MOST's projection gives the name the spare width and keeps the ticker and figures as wide as they are", () => {
  const columns = sized({ source: { pane: "MOST" }, projection: { columns: ["symbol", "name", "price", "changePercent", "volume"] } },
    MOST_COLUMNS, MOVERS, new Set(["price", "changePercent", "volume"]));
  expect(columns.map(({ id, width, align, flexGrow }) => ({ id, width, align, flexGrow }))).toEqual([
    { id: "symbol", width: 5, align: "left", flexGrow: undefined },
    // Set short and grown to the pane: a narrow pane cuts a name before it hides a figure, a wide one shows it whole.
    { id: "name", width: 20, align: "left", flexGrow: 1 },
    // A streamed figure keeps a cell for a tick that adds a digit.
    { id: "price", width: 8, align: "right", flexGrow: undefined },
    { id: "changePercent", width: 7, align: "right", flexGrow: undefined },
    { id: "volume", width: 8, align: "right", flexGrow: undefined },
  ]);
  expect(MOVERS.map((row) => viewCellText(row, columns[4]!))).toEqual(["212.35M", "61.00M", "3.40M"]);
});

test("a column's kind comes from what it holds: times and codes stay compact, the longest wording grows, the spec's width stays", () => {
  const rows: ViewRow[] = [
    { at: "2026-11-27T14:30:00Z", venue: "XNAS", count: 12, publisher: "Business Times", headline: "Chipmaker lifts its outlook on data center demand", contract: "Crude Oil Jan 2027" },
    { at: "2026-11-27T15:05:00Z", venue: "XNYS", count: 3, publisher: "Reuters", headline: "Retailer cuts guidance", contract: "Crude Oil Feb 2027" },
  ];
  const columns = sized(
    { source: { pane: "X" }, projection: { columns: ["at", "venue", "count", "publisher", { key: "headline", width: 30 }, "contract"] } },
    [{ key: "contract", header: "Contract", shrink: false }],
    rows,
  );
  expect(columns.map(({ id, width, align, flexGrow }) => ({ id, width, align, flexGrow }))).toEqual([
    { id: "at", width: 20, align: "left", flexGrow: undefined },
    { id: "venue", width: 4, align: "left", flexGrow: undefined },
    // Numbers a source does not align read right, as figures do.
    { id: "count", width: 2, align: "right", flexGrow: undefined },
    // Wording too, but the headline says more: one column takes the pane's spare width.
    { id: "publisher", width: 14, align: "left", flexGrow: undefined },
    { id: "headline", width: 30, align: "left", flexGrow: 1 },
    // A source that keeps a column whole keeps it from growing too.
    { id: "contract", width: 18, align: "left", flexGrow: undefined },
  ]);
});

test("a cell reads as the source's text report writes it, except a value the report prints under its row", () => {
  const spec = normalizeViewSpec({ source: { pane: "N" }, projection: { columns: ["tickers", "summary"] } });
  const [tickers, summary] = viewCellColumns(spec, [
    { key: "tickers", header: "Tickers", textFormat: (value) => (Array.isArray(value) ? value.join(", ") : "") },
    { key: "summary", header: "Summary", underRow: "line", textFormat: () => "" },
  ]);
  expect([{ tickers: ["KO", "PEP"] }, { tickers: [] }].map((row) => viewCellText(row, tickers!))).toEqual(["KO, PEP", ""]);
  expect(viewCellText({ summary: "Bottled water faces new checks." }, summary!)).toBe("Bottled water faces new checks.");
});

test("a cell exports the source's figure unless a transform shows another number", () => {
  const spec = normalizeViewSpec({ source: { pane: "MOST" }, projection: { columns: ["volume", { key: "changePercent", transform: "percent" }, { key: "price", transform: "compact" }] } });
  const [volume, percent, compact] = viewCellColumns(spec, MOST_COLUMNS);
  const row = MOVERS[0]!;
  expect([viewCellExportValue(row, volume!), viewCellExportValue(row, percent!), viewCellExportValue(row, compact!)]).toEqual([212_345_678, undefined, 181.5]);
  // A transform the spec names wins over the source's format.
  expect(viewCellText(row, percent!)).toBe("168.00%");
});
