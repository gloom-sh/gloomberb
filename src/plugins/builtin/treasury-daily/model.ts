import type { DataTableColumn } from "../../../components";

export const TREASURY_DAILY_PANE_ID = "treasury-daily";

export type TreasuryTab = "cash" | "debt";

export const TREASURY_TABS: { value: TreasuryTab; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "debt", label: "Debt" },
];

export interface CashAccount {
  id: string;
  account: string;
  /** The day's figure, millions of dollars. Null when it was not published. */
  today: number | null;
  /** Month to date (the month's opening balance on that row), millions of dollars. Null when it was not published. */
  month: number | null;
}

export interface OperatingCash {
  recordDate: string | null;
  rows: CashAccount[];
}

export interface DebtDay {
  id: string;
  date: string;
  /** Dollars. */
  heldByPublic: number | null;
  /** Dollars. */
  intragovernmental: number | null;
  /** Dollars. */
  total: number | null;
}

type CashColumnId = "account" | "today" | "month";
type DebtColumnId = "date" | "heldByPublic" | "intragovernmental" | "total";
export type CashColumn = DataTableColumn & { id: CashColumnId };
export type DebtColumn = DataTableColumn & { id: DebtColumnId };

export const CASH_COLUMNS: CashColumn[] = [
  { id: "account", label: "Account", width: 28, align: "left", flexGrow: 1 },
  { id: "today", label: "Today $bn", width: 12, align: "right" },
  { id: "month", label: "This month $bn", width: 15, align: "right" },
];

export const DEBT_COLUMNS: DebtColumn[] = [
  { id: "date", label: "Date", width: 10, align: "left" },
  { id: "heldByPublic", label: "Held by public $tn", width: 18, align: "right", flexGrow: 1 },
  { id: "intragovernmental", label: "Intragovernmental $tn", width: 22, align: "right", flexGrow: 1 },
  { id: "total", label: "Total $tn", width: 12, align: "right" },
];

function scaled(value: unknown, divisor: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  const text = (value / divisor).toFixed(2);
  return text === "-0.00" ? "0.00" : text;
}

/** Millions of dollars, drawn as billions. */
export function formatBillions(millions: unknown): string {
  return scaled(millions, 1_000);
}

/** Dollars, drawn as trillions. */
export function formatTrillions(dollars: unknown): string {
  return scaled(dollars, 1_000_000_000_000);
}
