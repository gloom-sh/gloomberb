import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/headless";
import { fetchPrimaryDealers } from "./client";
import { formatChange, formatLevel, type DealerRow } from "./model";

const level = (value: unknown) => typeof value === "number" ? formatLevel(value) : "—";
const change = (value: unknown) => typeof value === "number" ? formatChange(value) : "—";
const text = (value: unknown) => typeof value === "string" && value ? value : "—";
const group = (value: unknown) => typeof value === "string" ? value : "";

const COLUMNS: HeadlessPaneColumn[] = [
  { key: "position", header: "Position" },
  { key: "group", header: "Group", format: group },
  { key: "asOf", header: "As of", format: text },
  { key: "latest", header: "Latest $mn", align: "right", format: level },
  { key: "previous", header: "Previous $mn", align: "right", format: level },
  { key: "change", header: "Change $mn", align: "right", format: change },
];

/** The report's table sets a breakdown in under its total, as the pane does; the export names the total in `group` instead. */
const TEXT_COLUMNS: HeadlessPaneColumn[] = COLUMNS.filter((column) => column.key !== "group");

function reportRow(row: DealerRow) {
  return {
    id: row.id,
    position: row.label,
    group: row.parent,
    series: row.keys.join("+"),
    asOf: row.asOf,
    latest: row.latest,
    previous: row.previous,
    change: row.change,
  };
}

function textRow(row: DealerRow) {
  return { ...reportRow(row), position: `${"  ".repeat(row.depth)}${row.label}` };
}

function section(title: string, rows: readonly DealerRow[]) {
  return {
    title,
    columns: COLUMNS,
    rows: rows.map(reportRow),
    textColumns: TEXT_COLUMNS,
    textRows: rows.map(textRow),
    unit: "USD millions",
    rowSymbolKey: "series",
    rowAsOfKey: "asOf",
    interval: "weekly",
  };
}

export const primaryDealersHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "none" },
  options: [],
  describe: "Primary dealer net positions and settlement fails",
  freshness: { source: "New York Fed", status: "not-a-feed", basis: "weekly release" },
  discovery: {
    aliases: ["PDLR"],
    dataRequirements: ["Weekly primary dealer positions and settlement fails"],
    limitations: [
      "Net positions in Treasuries (bills, coupons by tenor, TIPS, FRN), agencies, MBS, corporates, munis and ABS; settlement fails in Treasuries, TIPS and MBS",
      "Latest observation and the change from the week before; the weekly history is in the pane",
    ],
  },
  async load() {
    const board = await fetchPrimaryDealers();
    return {
      complete: board.positions.length > 0,
      sections: [
        section("Positions", board.positions),
        section("Fails", board.fails),
      ],
      metadata: { asOf: board.asOf, seriesBreak: board.seriesBreak },
    };
  },
};
