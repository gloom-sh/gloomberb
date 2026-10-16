import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchBalances } from "./client";
import { balanceTitle, formatBalance, formatBalanceMonth, type BalanceCommodity, type BalanceRow } from "./model";

const number = (value: unknown) => typeof value === "number" ? formatBalance(value) : "—";

const COLUMNS: HeadlessPaneColumn[] = [
  { key: "country", header: "Country" },
  { key: "month", header: "Month", format: (value) => typeof value === "string" ? formatBalanceMonth(value) : "—", description: "The country's latest reported month; the figures on the row are for it." },
  { key: "production", header: "Production", align: "right", format: number },
  { key: "demand", header: "Demand", align: "right", format: number },
  { key: "imports", header: "Imports", align: "right", format: number },
  { key: "exports", header: "Exports", align: "right", format: number },
  { key: "stocks", header: "Stocks", align: "right", format: number, description: "Closing stocks. Thousand barrels for crude; million cubic metres for natural gas." },
  { key: "unit", header: "Unit" },
];

function commodityOf(value: unknown): BalanceCommodity {
  return value === "gas" ? "gas" : "oil";
}

/** Each row is dated by its own month, so the report cites the oldest one beside the newest. */
function reportRow(row: BalanceRow) {
  return { ...row, asOf: row.month ? `${row.month}-01` : null };
}

export const jodiHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "none" },
  options: [{
    key: "commodity",
    type: "enum",
    values: [{ value: "oil" }, { value: "gas" }],
    defaultValue: "oil",
    description: "Crude oil or natural gas.",
  }],
  discovery: {
    aliases: ["JODI"],
    dataRequirements: ["Monthly crude oil and natural gas country balances"],
    limitations: [
      "Each country's latest reported month; countries that report late or stopped reporting show an older month.",
      "Crude flows are thousand barrels per day. Crude closing stocks are thousand barrels.",
      "Crude demand is not in the primary table.",
      "Natural gas is million cubic metres, including closing stocks.",
    ],
  },
  freshness: { source: "JODI", status: "not-a-feed", basis: "monthly country reports", periodicity: "monthly" },
  describe: (args) => commodityOf(args.options.commodity) === "gas"
    ? "Monthly natural gas balances"
    : "Monthly crude oil balances",
  async load(args, ctx) {
    const commodity = commodityOf(args.options.commodity);
    const balances = await fetchBalances(ctx.signal);
    const board = commodity === "gas" ? balances.gas : balances.oil;
    if (!board) throw new Error("Gas balances are unavailable.");
    return {
      sections: [{
        title: balanceTitle(board),
        columns: board.commodity === "oil" ? COLUMNS.filter((column) => column.key !== "demand") : COLUMNS,
        rows: board.rows.map(reportRow),
      }],
      metadata: {
        asOf: `${board.month}-01`,
        month: board.month,
        commodity: board.commodity,
        unit: board.rows[0]?.unit ?? null,
        stale: balances.stale,
      },
      ...(balances.gaps.length ? { notes: balances.gaps } : {}),
    };
  },
};
