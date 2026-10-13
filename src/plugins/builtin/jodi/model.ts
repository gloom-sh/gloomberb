import type { DataTableColumn } from "../../../components";
import { formatNumber } from "../../../utils/format";

export const JODI_PANE_ID = "jodi";

/** Crude flows are thousand barrels a day; closing stocks are thousand barrels. */
export const OIL_UNIT = "kb/d, kbbl";
/** Natural gas flows and closing stocks, million cubic metres. */
export const GAS_UNIT = "million m3";

export const BALANCE_COUNTRIES: readonly { code: string; country: string }[] = [
  { code: "US", country: "United States" },
  { code: "CN", country: "China" },
  { code: "SA", country: "Saudi Arabia" },
  { code: "RU", country: "Russia" },
  { code: "IN", country: "India" },
  { code: "JP", country: "Japan" },
  { code: "DE", country: "Germany" },
  { code: "GB", country: "United Kingdom" },
  { code: "BR", country: "Brazil" },
  { code: "KR", country: "Korea" },
];

export type BalanceCommodity = "oil" | "gas";

export interface BalanceRow {
  country: string;
  production: number | null;
  demand: number | null;
  imports: number | null;
  exports: number | null;
  stocks: number | null;
  unit: string;
}

export interface Board {
  month: string;
  commodity: BalanceCommodity;
  rows: BalanceRow[];
}

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

/** Crude has no demand flow in the primary table, so its balance has no Demand column. */
export function balanceColumns(commodity: BalanceCommodity): DataTableColumn[] {
  const columns: DataTableColumn[] = [
    { id: "country", label: "Country", width: 18, align: "left" },
    { id: "production", label: "Production", width: 12, align: "right" },
    { id: "demand", label: "Demand", width: 12, align: "right" },
    { id: "imports", label: "Imports", width: 12, align: "right" },
    { id: "exports", label: "Exports", width: 12, align: "right" },
    { id: "stocks", label: "Stocks", width: 14, align: "right" },
    { id: "unit", label: "Unit", width: commodity === "oil" ? 14 : 12, align: "left" },
  ];
  return commodity === "oil" ? columns.filter((column) => column.id !== "demand") : columns;
}
