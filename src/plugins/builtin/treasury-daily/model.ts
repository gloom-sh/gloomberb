import type { DataTableColumn } from "../../../components";
import { formatNumber } from "../../../utils/format";

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

/** One day's Treasury General Account closing balance, millions of dollars. */
export interface TgaClose {
  date: string;
  millions: number;
}

/** The longest stretch of closing balances the Cash tab charts, and the ranges it offers. */
export type TgaRange = "3M" | "6M" | "1Y" | "ALL";
export const TGA_RANGES: ReadonlyArray<{ value: TgaRange; label: string; hint: string; months: number | null }> = [
  { value: "3M", label: "3M", hint: "1", months: 3 },
  { value: "6M", label: "6M", hint: "2", months: 6 },
  { value: "1Y", label: "1Y", hint: "3", months: 12 },
  { value: "ALL", label: "All", hint: "4", months: null },
];
const DEFAULT_TGA_RANGE: TgaRange = "1Y";

export function tgaRange(value: unknown): TgaRange {
  return TGA_RANGES.find((range) => range.value === value)?.value ?? DEFAULT_TGA_RANGE;
}

/** The closes of the last `range`, counted back from the newest one, oldest first. */
export function tgaClosesInRange(closes: readonly TgaClose[], range: TgaRange): TgaClose[] {
  const months = TGA_RANGES.find((entry) => entry.value === range)?.months ?? null;
  const last = closes.at(-1);
  if (months == null || !last) return [...closes];
  const start = new Date(`${last.date}T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() - months);
  const from = start.toISOString().slice(0, 10);
  return closes.filter((close) => close.date >= from);
}

/**
 * What the Treasury's statement calls a line of the Treasury General Account,
 * said plainly: `Treasury General Account (TGA) Opening Balance` is the
 * opening balance, `Total TGA Withdrawals (Table II) (-)` the withdrawals. A
 * line the statement adds later keeps its own words, less the table reference.
 */
export function cashLineLabel(account: string): string {
  if (/^Treasury General Account \(TGA\) Opening Balance$/i.test(account)) return "Opening balance";
  if (/^Treasury General Account \(TGA\) Closing Balance$/i.test(account)) return "Closing balance";
  if (/^Total TGA Deposits\b/i.test(account)) return "Deposits";
  if (/^Total TGA Withdrawals\b/i.test(account)) return "Withdrawals";
  return account.replace(/\s*\(Table [IVX]+\)/g, "").replace(/\s*\(-\)$/, "").trim();
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
  { id: "account", label: "Treasury General Account", width: 26, align: "left", flexGrow: 1 },
  { id: "today", label: "Today $bn", width: 12, align: "right" },
  { id: "month", label: "This month $bn", width: 15, align: "right" },
];

export const DEBT_COLUMNS: DebtColumn[] = [
  { id: "date", label: "Date", width: 10, align: "left" },
  { id: "heldByPublic", label: "Held by public $tn", width: 18, align: "right", flexGrow: 1 },
  { id: "intragovernmental", label: "Intragovernmental $tn", width: 22, align: "right", flexGrow: 1 },
  { id: "total", label: "Total $tn", width: 12, align: "right" },
];

/** Two decimals with thousands separators, as every money table writes a large figure: `2,594.63`. */
function scaled(value: unknown, divisor: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  const rounded = Number((value / divisor).toFixed(2));
  return formatNumber(rounded === 0 ? 0 : rounded, 2);
}

/** Millions of dollars, drawn as billions. */
export function formatBillions(millions: unknown): string {
  return scaled(millions, 1_000);
}

/** Dollars, drawn as trillions. */
export function formatTrillions(dollars: unknown): string {
  return scaled(dollars, 1_000_000_000_000);
}
