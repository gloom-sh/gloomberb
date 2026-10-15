import type { DataTableColumn } from "../../../components";
import type { InsiderSignalRow, InsiderSignalsPayload } from "../../../api-client/insider-signals";
import { formatShortDate } from "../../../utils/datetime-format";
import { displayWidth, formatCompact } from "../../../utils/format";
import { DEFAULT_INSIDER_SIGNAL_WINDOW, INSIDER_SIGNAL_WINDOWS } from "./signals-client";

export type InsiderSignalColumnId = "ticker" | "company" | "score" | "why" | "insiders" | "value" | "lastBuy";

export interface InsiderSignalColumn extends DataTableColumn {
  id: InsiderSignalColumnId;
}

/** The ranked view's title, and the one it goes back to from a company. */
export const INSIDER_SIGNALS_TITLE = "Insider Buying";

export const INSIDER_SIGNAL_WINDOW_OPTIONS = INSIDER_SIGNAL_WINDOWS.map((days) => ({ value: String(days), label: `${days}D` }));

/** A stored window the pane offers, or the default. */
export function insiderSignalWindow(value: unknown): number {
  const days = Number(value);
  return (INSIDER_SIGNAL_WINDOWS as readonly number[]).includes(days) ? days : DEFAULT_INSIDER_SIGNAL_WINDOW;
}

/** The reasons as one line, strongest first. */
export function insiderSignalWhy(row: Pick<InsiderSignalRow, "reasons">): string {
  return row.reasons.join(" · ");
}

const DAY_MS = 86_400_000;

/**
 * Filings are read from a first day on: a window reaching past it ranks less
 * buying than it says, and so does one before any day has been read whole.
 */
export function insiderSignalsCoverageNotice(payload: Pick<InsiderSignalsPayload, "window" | "through" | "coverage">): string | null {
  const from = payload.coverage.from;
  if (!from) return "Form 4 filings are still being read, so this ranking may leave out buying.";
  const windowStart = new Date(Date.parse(`${payload.through}T00:00:00Z`) - (payload.window - 1) * DAY_MS).toISOString().slice(0, 10);
  return from > windowStart
    ? `Form 4 filings are read from ${formatShortDate(from, { utc: true })}, so this window leaves out buying before then.`
    : null;
}

export function formatSignalValue(value: number): string {
  return `$${formatCompact(value)}`;
}

/** A buy day as m/d/yy, as the INS table writes a transaction date. */
export function formatSignalDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match ? `${Number(match[2])}/${Number(match[3])}/${match[1]!.slice(2)}` : "--";
}

export function insiderSignalsEmptyTitle(window: number): string {
  return `No open-market insider buying in the last ${window} days.`;
}

/** Cells left and right of the columns, and between two of them. */
const TABLE_PADDING = 2;
const COLUMN_GAP = 1;
/** The kit widens a column to fit its header plus the sort arrow. */
const HEADER_EXTRA = 2;
/** The reasons are the point of the view; below this they would read as noise. */
const WHY_MIN = 24;

function fitWidth(texts: readonly string[], label: string, max: number): number {
  const widest = texts.reduce((width, value) => Math.max(width, displayWidth(value)), 0);
  return Math.max(displayWidth(label) + HEADER_EXTRA, Math.min(max, widest));
}

/**
 * The columns that fit `width` cells (the desktop passes its width in the
 * same cells and lets the reasons fill the rest). The reasons keep at least
 * 24 cells: when the pane runs short the company goes first, then the
 * buyer count and the last buy day, so a narrow pane still reads ticker,
 * score, why and dollars. Room the reasons do not need widens the company.
 */
export function buildInsiderSignalColumns(width: number, rows: readonly InsiderSignalRow[]): InsiderSignalColumn[] {
  const widths = {
    ticker: fitWidth(rows.map((row) => row.ticker), "Ticker", 8),
    company: fitWidth(rows.map((row) => row.company), "Company", 20),
    score: fitWidth(rows.map((row) => String(row.score)), "Score", 5),
    insiders: fitWidth(rows.map((row) => String(row.insiders)), "Buyers", 4),
    value: fitWidth(rows.map((row) => formatSignalValue(row.value)), "Bought", 8),
    lastBuy: fitWidth(rows.map((row) => formatSignalDay(row.lastBuy)), "Last Buy", 8),
  };
  const show = { company: true, insiders: true, lastBuy: true };
  const available = Math.max(0, Math.floor(width) - TABLE_PADDING);
  const fixed = () => [
    widths.ticker,
    show.company ? widths.company : 0,
    widths.score,
    show.insiders ? widths.insiders : 0,
    widths.value,
    show.lastBuy ? widths.lastBuy : 0,
  ].reduce((sum, columnWidth) => sum + (columnWidth > 0 ? columnWidth + COLUMN_GAP : 0), 0);
  for (const drop of ["company", "insiders", "lastBuy"] as const) {
    if (available - fixed() - COLUMN_GAP >= WHY_MIN) break;
    show[drop] = false;
  }
  let why = Math.max(8, available - fixed() - COLUMN_GAP);
  // Room the reasons do not need goes to the company names cut at 20.
  if (show.company) {
    const whyNeed = fitWidth(rows.map(insiderSignalWhy), "Why", Number.POSITIVE_INFINITY);
    const grow = Math.max(0, Math.min(why - whyNeed, fitWidth(rows.map((row) => row.company), "Company", 32) - widths.company));
    widths.company += grow;
    why -= grow;
  }
  return [
    { id: "ticker", label: "Ticker", width: widths.ticker, align: "left" },
    ...(show.company ? [{ id: "company" as const, label: "Company", width: widths.company, align: "left" as const }] : []),
    { id: "score", label: "Score", width: widths.score, align: "right" },
    { id: "why", label: "Why", width: why, align: "left", flexGrow: 1 },
    ...(show.insiders ? [{ id: "insiders" as const, label: "Buyers", width: widths.insiders, align: "right" as const }] : []),
    { id: "value", label: "Bought", width: widths.value, align: "right" },
    ...(show.lastBuy ? [{ id: "lastBuy" as const, label: "Last Buy", width: widths.lastBuy, align: "right" as const }] : []),
  ];
}

/** The ranking's own order breaks ties, so a sort never shuffles equal rows. */
export function compareInsiderSignalRows(a: InsiderSignalRow, b: InsiderSignalRow, columnId: InsiderSignalColumnId): number {
  switch (columnId) {
    case "ticker": return a.ticker.localeCompare(b.ticker, "en-US");
    case "company": return a.company.localeCompare(b.company, "en-US", { sensitivity: "base" });
    case "score": return a.score - b.score;
    case "why": return insiderSignalWhy(a).localeCompare(insiderSignalWhy(b), "en-US", { sensitivity: "base" });
    case "insiders": return a.insiders - b.insiders;
    case "value": return a.value - b.value;
    case "lastBuy": return a.lastBuy.localeCompare(b.lastBuy);
  }
}

/** Text columns sort A to Z first, figures and dates largest first. */
export function insiderSignalFirstDirection(columnId: InsiderSignalColumnId): "asc" | "desc" {
  return columnId === "ticker" || columnId === "company" || columnId === "why" ? "asc" : "desc";
}
