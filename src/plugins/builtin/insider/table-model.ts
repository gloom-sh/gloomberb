import type { DataTableColumn } from "../../../components";
import { displayWidth, formatCompact, formatCurrency } from "../../../utils/format";
import { isAmendedInsiderFiling } from "./amendments";
import { insiderSecurityTag, insiderTypeLabel, insiderTypeTone, type InsiderTypeTone } from "./display";
import {
  insiderDisplayName,
  insiderRole,
  insiderTransactionId,
  isInsiderDisclosureOnly,
  type ParsedInsiderFiling,
} from "./model";

export type InsiderColumnId = "date" | "insider" | "role" | "type" | "security" | "shares" | "price" | "value";

export interface InsiderColumn extends DataTableColumn {
  id: InsiderColumnId;
  /** The type column has room for the 10b5-1 marker. */
  plan?: boolean;
}

/** One table row: a Form 4 line, or a filing without one (loading, unread, a disclosure). */
export interface InsiderTableRow {
  id: string;
  entry: ParsedInsiderFiling;
  date: Date | null;
  name: string;
  role: string;
  type: string;
  tone: InsiderTypeTone;
  /** An amended filing (Form 4/A), marked after the type at every width. */
  amended: boolean;
  /** Rule 10b5-1 plan trade, marked after the type when there is room. */
  plan: boolean;
  security: string | null;
  shares: number | null;
  price: number | null;
  value: number | null;
}

function validDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function buildInsiderTableRows(parsed: readonly ParsedInsiderFiling[]): InsiderTableRow[] {
  return parsed.map((entry) => {
    const { filing, transaction } = entry;
    const amendment = isAmendedInsiderFiling(entry);
    const name = insiderDisplayName(entry);
    if (!transaction) {
      const disclosure = !entry.isLoading && isInsiderDisclosureOnly(entry);
      return {
        id: insiderTransactionId(entry),
        entry,
        date: validDate(filing.filingDate),
        name: name ?? (entry.isLoading ? "Loading..." : "Unknown filer"),
        role: insiderRole(entry),
        type: entry.isLoading ? "" : disclosure ? "NOTICE" : "—",
        tone: "neutral",
        amended: amendment,
        plan: false,
        security: null,
        shares: null,
        price: null,
        value: null,
      };
    }
    return {
      id: insiderTransactionId(entry),
      entry,
      date: validDate(transaction.filingDate ?? filing.filingDate),
      name: name ?? "Unknown filer",
      role: insiderRole(entry),
      type: insiderTypeLabel(transaction.transactionType),
      tone: insiderTypeTone(transaction.transactionType),
      amended: amendment,
      plan: transaction.rule10b51 === true,
      security: insiderSecurityTag(transaction),
      shares: transaction.shares,
      price: transaction.pricePerShare,
      value: transaction.totalValue,
    };
  });
}

/** A transaction date as m/d/yy, read in UTC because it names a calendar day. */
export function formatInsiderDate(date: Date | null): string {
  if (!date) return "—";
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${String(date.getUTCFullYear()).slice(-2)}`;
}

export function formatInsiderShares(value: number | null): string {
  return value == null ? "—" : formatCompact(value);
}

export function formatInsiderPrice(value: number | null): string {
  return value == null ? "—" : formatCurrency(value);
}

export function formatInsiderValue(value: number | null): string {
  return value == null ? "—" : `$${formatCompact(value)}`;
}

/** The quieter words after the type: "4/A" always, "10b5-1" when the column has room. */
export function insiderTypeMarkers(row: InsiderTableRow, plan: boolean): string[] {
  return [...(row.amended ? ["4/A"] : []), ...(plan && row.plan ? ["10b5-1"] : [])];
}

export function insiderTypeText(row: InsiderTableRow, plan: boolean): string {
  return [row.type, ...insiderTypeMarkers(row, plan)].filter(Boolean).join(" ");
}

/** Cells left and right of the columns, and between two of them. */
const TABLE_PADDING = 2;
const COLUMN_GAP = 1;
/** The kit widens a column to fit its header plus the sort arrow. */
const HEADER_EXTRA = 2;

function fitWidth(texts: readonly string[], label: string, max: number): number {
  const widest = texts.reduce((width, text) => Math.max(width, displayWidth(text)), 0);
  return Math.max(displayWidth(label) + HEADER_EXTRA, Math.min(max, widest));
}

/**
 * The columns that fit `width` terminal cells (the desktop passes its width
 * in the same cells). Every column takes the width its widest value needs.
 * When the pane runs short, the role goes first, then the price, the
 * 10b5-1 marker, the security and the share count, and only then does the name
 * column shrink below 16 cells, so a narrow pane still reads date, name,
 * type and value.
 */
export function buildInsiderColumns(width: number, rows: readonly InsiderTableRow[]): InsiderColumn[] {
  const anyPlan = rows.some((row) => row.plan);
  const anySecurity = rows.some((row) => row.security);
  const names = rows.map((row) => row.name);
  const widths = {
    date: fitWidth(rows.map((row) => formatInsiderDate(row.date)), "Date", 8),
    insider: fitWidth(names, "Insider", 28),
    role: fitWidth(rows.map((row) => row.role), "Role", 12),
    typeBase: fitWidth(rows.map((row) => insiderTypeText(row, false)), "Type", 12),
    typePlan: fitWidth(rows.map((row) => insiderTypeText(row, true)), "Type", 19),
    security: fitWidth(rows.map((row) => row.security ?? ""), "Security", 12),
    shares: fitWidth(rows.map((row) => formatInsiderShares(row.shares)), "Shares", 9),
    price: fitWidth(rows.map((row) => formatInsiderPrice(row.price)), "Price", 10),
    value: fitWidth(rows.map((row) => formatInsiderValue(row.value)), "Value", 9),
  };
  const show = { role: true, price: true, plan: anyPlan, security: anySecurity, shares: true };
  let insider = widths.insider;
  const available = Math.max(0, Math.floor(width) - TABLE_PADDING);
  const total = () => [
    widths.date,
    insider,
    show.role ? widths.role : 0,
    show.plan ? widths.typePlan : widths.typeBase,
    show.security ? widths.security : 0,
    show.shares ? widths.shares : 0,
    show.price ? widths.price : 0,
    widths.value,
  ].reduce((sum, columnWidth) => sum + (columnWidth > 0 ? columnWidth + COLUMN_GAP : 0), 0);
  const shrinkInsider = (floor: number) => {
    insider = Math.max(Math.min(insider, floor), insider - Math.max(0, total() - available));
  };
  shrinkInsider(16);
  for (const drop of ["role", "price", "plan", "security", "shares"] as const) {
    if (total() <= available) break;
    show[drop] = false;
    shrinkInsider(16);
  }
  shrinkInsider(6);
  // A dropped column can leave room for more of the names.
  insider = Math.min(widths.insider, insider + Math.max(0, available - total()));

  const typeWidth = show.plan ? widths.typePlan : widths.typeBase;
  return [
    { id: "date", label: "Date", width: widths.date, align: "left" },
    { id: "insider", label: "Insider", width: insider, align: "left" },
    ...(show.role ? [{ id: "role" as const, label: "Role", width: widths.role, align: "left" as const }] : []),
    { id: "type", label: "Type", width: typeWidth, align: "left", plan: show.plan },
    ...(show.security ? [{ id: "security" as const, label: "Security", width: widths.security, align: "left" as const }] : []),
    ...(show.shares ? [{ id: "shares" as const, label: "Shares", width: widths.shares, align: "right" as const }] : []),
    ...(show.price ? [{ id: "price" as const, label: "Price", width: widths.price, align: "right" as const }] : []),
    { id: "value", label: "Value", width: widths.value, align: "right" },
  ];
}

function compareNullable(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en-US", { sensitivity: "base" });
}

export function compareInsiderRows(a: InsiderTableRow, b: InsiderTableRow, columnId: InsiderColumnId): number {
  switch (columnId) {
    case "date": return compareNullable(a.date?.getTime() ?? null, b.date?.getTime() ?? null);
    case "insider": return compareText(a.name, b.name);
    case "role": return compareText(a.role, b.role);
    case "type": return compareText(a.type, b.type);
    case "security": return compareText(a.security ?? "", b.security ?? "");
    case "shares": return compareNullable(a.shares, b.shares);
    case "price": return compareNullable(a.price, b.price);
    case "value": return compareNullable(a.value, b.value);
  }
}
