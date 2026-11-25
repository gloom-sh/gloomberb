import type { JodiBalanceBoard, JodiBalanceRow } from "../../../api-client/commodity-balances";
import type { DataTableColumn } from "../../../components";
import { MISSING_VALUE, formatNumber } from "../../../utils/format";

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

/** A figure in the decimals its column shares (balanceDigits); alone, whole from 100 up and one decimal below. */
export function formatBalance(value: number | null, digits?: number): string {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  const decimals = digits ?? (Math.abs(value) >= 100 || Number.isInteger(value) ? 0 : 1);
  return formatNumber(value, decimals);
}

/** The figure columns, each one quantity across the countries. */
export const BALANCE_FIGURE_KEYS = ["production", "demand", "imports", "exports", "stocks"] as const;
export type BalanceFigureKey = typeof BALANCE_FIGURE_KEYS[number];

/**
 * The decimals each figure column shares: one when any of its figures under
 * 100 has a fraction (Japan's 2.2 kb/d of crude), so the whole column reads
 * 13,952.7 over it; whole numbers otherwise.
 */
export function balanceDigits(rows: readonly BalanceRow[]): Record<BalanceFigureKey, number> {
  const digits = (key: BalanceFigureKey) => rows.some((row) => {
    const value = row[key];
    return value != null && Number.isFinite(value) && Math.abs(value) < 100 && !Number.isInteger(value);
  }) ? 1 : 0;
  return Object.fromEntries(BALANCE_FIGURE_KEYS.map((key) => [key, digits(key)])) as Record<BalanceFigureKey, number>;
}

export function balanceTitle(board: Board): string {
  const name = board.commodity === "gas" ? "Natural gas" : "Crude oil";
  return `${name}, ${formatBalanceMonth(board.month)}`;
}

/**
 * The units every country's figures share, which head the figure columns
 * instead of filling a column: crude's flows in kb/d and its stocks in kbbl
 * ("kb/d, kbbl"), gas's all in one. Null when countries differ, and each row
 * then says its own.
 */
export function balanceUnits(rows: readonly BalanceRow[]): { flow: string; stock: string } | null {
  const units = new Set(rows.map((row) => row.unit));
  const unit = rows.length > 0 && units.size === 1 ? rows[0]!.unit : "";
  const [flow, stock = flow] = unit.split(/,\s*/);
  return flow ? { flow, stock: stock! } : null;
}

/** The figure columns a unit heads: the flows, then the closing stocks. */
export const BALANCE_FLOW_KEYS = new Set(["production", "demand", "imports", "exports"]);

/**
 * Crude has no demand flow in the primary table, so its balance has no Demand
 * column. Countries report on their own schedules, so each row says its month;
 * narrower columns keep crude within the width it had.
 */
export function balanceColumns(commodity: BalanceCommodity, units: { flow: string; stock: string } | null = null): DataTableColumn[] {
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
  // One set of units for every country heads the figures instead of a Unit column (balanceUnits).
  const headed = units ? columns.flatMap((column): DataTableColumn[] => {
    if (column.id === "unit") return [];
    const unit = BALANCE_FLOW_KEYS.has(column.id) ? units.flow : column.id === "stocks" ? units.stock : null;
    if (!unit) return [column];
    const label = `${column.label} ${unit}`;
    return [{ ...column, label, width: Math.max(column.width, label.length) }];
  }) : columns;
  return commodity === "oil" ? headed.filter((column) => column.id !== "demand") : headed;
}
