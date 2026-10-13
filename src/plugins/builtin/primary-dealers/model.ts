import type { DataTableColumn } from "../../../components";
import { fitChartTableColumns } from "../../../components/chart-table";
import { formatNumber } from "../../../utils/format";

export const PRIMARY_DEALERS_PANE_ID = "primary-dealers";

/** Aggregate totals only. Tenor and CUSIP buckets stay off the wire. */
const SERIES_CAP = 12;

/**
 * The current release names settlement fails PDFTD (deliver) and PDFTR
 * (receive). PDFAIL and PDFAS are included when a break still publishes them.
 */
const FAIL_PREFIXES = ["PDFAIL", "PDFAS", "PDFTD", "PDFTR"] as const;

export type DealerTab = "positions" | "fails";

export interface CatalogEntry {
  seriesBreak: string;
  keyid: string;
  description: string;
}

export interface SeriesSelection {
  seriesBreak: string;
  positions: CatalogEntry[];
  fails: CatalogEntry[];
}

export interface DealerRow {
  keyid: string;
  label: string;
  tab: DealerTab;
  asOf: string | null;
  latest: number | null;
  previous: number | null;
  change: number | null;
}

function seriesBreakYear(seriesBreak: string): number {
  const match = /(\d{4})$/.exec(seriesBreak);
  return match ? Number(match[1]) : 0;
}

function newestSeriesBreak(entries: readonly CatalogEntry[]): string | null {
  let best: string | null = null;
  let bestYear = -1;
  for (const entry of entries) {
    const year = seriesBreakYear(entry.seriesBreak);
    if (best == null || year > bestYear || (year === bestYear && entry.seriesBreak > best)) {
      best = entry.seriesBreak;
      bestYear = year;
    }
  }
  return best;
}

function isWeeklyChange(entry: CatalogEntry): boolean {
  return /change from previous/i.test(entry.description) || /C$/i.test(entry.keyid);
}

function describesTreasury(description: string): boolean {
  return /\bTREASURY\b/i.test(description);
}

function describesMbs(description: string): boolean {
  const text = description.replace(/excluding mbs/gi, "");
  return /\bMBS\b/i.test(text) || /mortgage/i.test(text);
}

function isAggregateTotal(entry: CatalogEntry): boolean {
  if (isWeeklyChange(entry)) return false;
  return entry.keyid.toUpperCase().endsWith("-TOT") || /^\s*total\b/i.test(entry.description);
}

function isExcludedAsset(entry: CatalogEntry): boolean {
  const id = entry.keyid.toUpperCase();
  if (id.endsWith("-CS") || id.endsWith("-CSC") || id.endsWith("-FGEM") || id.endsWith("-FGEMC")) return true;
  const text = entry.description.toUpperCase();
  if (/\bCORPORATE\b|\bMUNICIPAL\b|\bASSET-BACKED\b|\bEQUITIES\b|\bEQUITY\b/.test(text)) return true;
  return /EXCLUDING MBS/.test(text) && !/\bTREASURY\b/.test(text);
}

function isPositionAggregate(entry: CatalogEntry): boolean {
  if (!entry.keyid.toUpperCase().startsWith("PDPOS")) return false;
  if (!isAggregateTotal(entry)) return false;
  return describesTreasury(entry.description) || describesMbs(entry.description);
}

function isFailKey(keyid: string): boolean {
  const id = keyid.toUpperCase();
  return FAIL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function isFailAggregate(entry: CatalogEntry): boolean {
  if (!isFailKey(entry.keyid) || isWeeklyChange(entry) || isExcludedAsset(entry)) return false;
  const id = entry.keyid.toUpperCase();
  const named = describesTreasury(entry.description) || describesMbs(entry.description)
    || id.includes("TIPS") || /(?:USTET|UST|FGM|OM)$/.test(id);
  if (!named) return false;
  if (isAggregateTotal(entry)) return true;
  return /^(?:PDFAIL|PDFAS|PDFTD|PDFTR)-[A-Z0-9]+$/.test(id);
}

function assetRank(entry: CatalogEntry): number {
  const id = entry.keyid.toUpperCase();
  if (id.includes("USTET") || id.includes("GST")) return 0;
  if (id.includes("TIPS") || /-(?:UST)$/.test(id)) return 1;
  if (id.includes("MBS") || id.endsWith("-FGM")) return 2;
  if (id.endsWith("-OM")) return 3;
  return 4;
}

function byReadOrder(a: CatalogEntry, b: CatalogEntry): number {
  const side = (entry: CatalogEntry) => entry.keyid.toUpperCase().startsWith("PDFTR") ? 1 : 0;
  return assetRank(a) - assetRank(b) || side(a) - side(b) || a.keyid.localeCompare(b.keyid);
}

export function selectSeries(entries: readonly CatalogEntry[]): SeriesSelection {
  const seriesBreak = newestSeriesBreak(entries);
  const current = seriesBreak ? entries.filter((entry) => entry.seriesBreak === seriesBreak) : [];
  const positions = current.filter(isPositionAggregate).sort(byReadOrder).slice(0, SERIES_CAP);
  const fails = current.filter(isFailAggregate).sort(byReadOrder).slice(0, Math.max(0, SERIES_CAP - positions.length));
  return { seriesBreak: seriesBreak ?? "", positions, fails };
}

function fallbackLabel(description: string, keyid: string): string {
  let text = description.replace(/^\s*total\s*-\s*/i, "").trim();
  const cut = text.search(/\s+-\s+|\s*:\s*/);
  if (cut > 0) text = text.slice(0, cut).trim();
  text = text.replace(/\s+/g, " ");
  if (!text) return keyid;
  return text.length <= 48 ? text : `${text.slice(0, 47).trimEnd()}…`;
}

function positionLabel(entry: CatalogEntry): string {
  const id = entry.keyid.toUpperCase();
  const asset = id.includes("USTET") || id.includes("GST") ? "Treasuries ex-TIPS"
    : id.includes("TIPS") || /-(?:UST)$/.test(id) ? "TIPS"
    : id.includes("MBS") || id.endsWith("-FGM") ? "Agency MBS"
    : id.endsWith("-OM") ? "Other MBS"
    : null;
  if (!asset) return fallbackLabel(entry.description, entry.keyid);
  if (id.startsWith("PDFTD")) return `${asset}, fails to deliver`;
  if (id.startsWith("PDFTR")) return `${asset}, fails to receive`;
  if (id.startsWith("PDFAIL") || id.startsWith("PDFAS")) return `${asset} fails`;
  return asset;
}

export function formatLevel(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const decimals = Number.isInteger(value) ? 0 : 2;
  const text = formatNumber(Math.abs(value) === 0 ? 0 : value, decimals);
  return text === "-0" ? "0" : text;
}

export function formatChange(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const text = formatLevel(Math.abs(value));
  if (text === "0") return "0";
  return value > 0 ? `+${text}` : `-${text}`;
}

export function toDealerRow(
  entry: CatalogEntry,
  parsed: { keyid: string; latest: { asOf: string; value: number } | null; previous: { asOf: string; value: number } | null },
  tab: DealerTab,
): DealerRow {
  const latest = parsed.latest?.value ?? null;
  const previous = parsed.previous?.value ?? null;
  return {
    keyid: parsed.keyid || entry.keyid,
    label: positionLabel(entry),
    tab,
    asOf: parsed.latest?.asOf ?? null,
    latest,
    previous,
    change: latest != null && previous != null ? latest - previous : null,
  };
}

export function boardAsOf(rows: readonly DealerRow[]): string | null {
  let best: string | null = null;
  for (const row of rows) {
    if (row.asOf && (best == null || row.asOf > best)) best = row.asOf;
  }
  return best;
}

type DealerColumnId = "position" | "asOf" | "latest" | "previous" | "change";
export type DealerColumn = DataTableColumn & { id: DealerColumnId };

const DEALER_COLUMNS: readonly DealerColumn[] = [
  { id: "position", label: "Position", width: 28, align: "left", flexGrow: 1 },
  { id: "asOf", label: "As of", width: 10, align: "left" },
  { id: "latest", label: "Latest $mn", width: 12, align: "right" },
  { id: "previous", label: "Previous $mn", width: 12, align: "right" },
  { id: "change", label: "Change $mn", width: 12, align: "right" },
];

const NARROW_DROP_ORDER: readonly DealerColumnId[] = ["previous", "asOf"];

/** The release reports every figure in millions of dollars. */
export function buildDealerColumns(width: number): DealerColumn[] {
  return fitChartTableColumns(DEALER_COLUMNS, width, NARROW_DROP_ORDER);
}
