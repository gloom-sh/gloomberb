import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/headless";
import { fetchPrimaryDealers } from "./client";
import { formatChange, formatLevel, type DealerRow } from "./model";

const level = (value: unknown) => typeof value === "number" ? formatLevel(value) : "—";
const change = (value: unknown) => typeof value === "number" ? formatChange(value) : "—";
const text = (value: unknown) => typeof value === "string" && value ? value : "—";

const COLUMNS: HeadlessPaneColumn[] = [
  { key: "position", header: "Position" },
  { key: "asOf", header: "As of", format: text },
  { key: "latest", header: "Latest $mn", align: "right", format: level },
  { key: "previous", header: "Previous $mn", align: "right", format: level },
  { key: "change", header: "Change $mn", align: "right", format: change },
];

function reportRow(row: DealerRow) {
  return {
    id: row.keyid,
    position: row.label,
    asOf: row.asOf,
    latest: row.latest,
    previous: row.previous,
    change: row.change,
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
      "Treasury and mortgage-backed aggregate totals, not tenor or CUSIP buckets",
      "Latest observation and the one before it",
    ],
  },
  async load() {
    const board = await fetchPrimaryDealers();
    return {
      complete: board.positions.length > 0,
      sections: [
        { title: "Positions", columns: COLUMNS, rows: board.positions.map(reportRow) },
        { title: "Fails", columns: COLUMNS, rows: board.fails.map(reportRow) },
      ],
      metadata: { asOf: board.asOf, seriesBreak: board.seriesBreak },
    };
  },
};
