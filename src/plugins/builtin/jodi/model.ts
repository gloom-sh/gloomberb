import type { JodiBalanceBoard, JodiBalanceRow } from "../../../api-client/commodity-balances";
import type { DataTableColumn } from "../../../components";
import { formatNumber } from "../../../utils/format";

export const JODI_PANE_ID = "jodi";

export type BalanceCommodity = JodiBalanceBoard["commodity"];
/** A country's balance for its own latest reported month, which `month` names. */
export type BalanceRow = JodiBalanceRow;
export type Board = JodiBalanceBoard;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Jul 2026" from 2026-07. */
export function formatBalanceMonth(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return name && match ? `${name} ${match[1]}` : month;
}

/** Whole numbers from 100 up; one decimal below that, and an integer stays whole. */
export function formatBalance(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const decimals = Math.abs(value) >= 100 || Number.isInteger(value) ? 0 : 1;
  return formatNumber(value, decimals);
}

export function balanceTitle(board: Board): string {
  const name = board.commodity === "gas" ? "Natural gas" : "Crude oil";
  return `${name}, ${formatBalanceMonth(board.month)}`;
}

/**
 * Crude has no demand flow in the primary table, so its balance has no Demand
 * column. Countries report on their own schedules, so each row says its month;
 * narrower columns keep crude within the width it had.
 */
export function balanceColumns(commodity: BalanceCommodity): DataTableColumn[] {
  const columns: DataTableColumn[] = [
    { id: "country", label: "Country", width: 15, align: "left" },
    { id: "month", label: "Month", width: 9, align: "left" },
    { id: "production", label: "Production", width: 11, align: "right" },
    { id: "demand", label: "Demand", width: 11, align: "right" },
    { id: "imports", label: "Imports", width: 11, align: "right" },
    { id: "exports", label: "Exports", width: 11, align: "right" },
    { id: "stocks", label: "Stocks", width: 11, align: "right" },
    { id: "unit", label: "Unit", width: 11, align: "left" },
  ];
  return commodity === "oil" ? columns.filter((column) => column.id !== "demand") : columns;
}
