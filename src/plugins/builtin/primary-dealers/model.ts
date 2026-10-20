import type { DataTableColumn } from "../../../components";
import { fitChartTableColumns } from "../../../components/chart-table";
import { formatNumber } from "../../../utils/format";

export const PRIMARY_DEALERS_PANE_ID = "primary-dealers";

export type DealerTab = "positions" | "fails";

/** One observation of a series. */
export interface SeriesPoint {
  asOf: string;
  value: number;
}

/** What the "latest" read holds per series: its newest observation. */
export type LatestBySeries = ReadonlyMap<string, SeriesPoint>;

/** A row of the board: one series, or the sum of several that the release does not total. */
interface RowDef {
  id: string;
  label: string;
  tab: DealerTab;
  /** 1 for a breakdown of the total above it. */
  depth: 0 | 1;
  /** The levels the row sums, in the release's series ids. */
  keys: readonly string[];
}

export interface DealerRow {
  id: string;
  label: string;
  tab: DealerTab;
  depth: 0 | 1;
  /** The total a breakdown row belongs to; null for a total. */
  parent: string | null;
  /** The release's series behind the row; its history is their sum. */
  keys: readonly string[];
  asOf: string | null;
  latest: number | null;
  previous: number | null;
  change: number | null;
}

const total = (id: string, label: string, ...keys: string[]): RowDef => ({ id, label, tab: "positions", depth: 0, keys });
const part = (id: string, label: string, ...keys: string[]): RowDef => ({ id, label, tab: "positions", depth: 1, keys });

/**
 * The positions the board shows, in reading order: a total, then what it is
 * made of. Every total is the exact sum of its breakdown in each week of the
 * release (the Fed's own description of the Treasury total says it leaves TIPS
 * out, and its numbers include them), so the breakdown always adds up.
 */
const POSITION_ROWS: readonly RowDef[] = [
  total("treasuries", "Treasuries", "PDPOSGST-TOT"),
  part("bills", "Bills", "PDPOSGS-B"),
  part("coupons-0-2", "Coupons 0-2y", "PDPOSGSC-L2"),
  part("coupons-2-3", "Coupons 2-3y", "PDPOSGSC-G2L3"),
  part("coupons-3-6", "Coupons 3-6y", "PDPOSGSC-G3L6"),
  part("coupons-6-7", "Coupons 6-7y", "PDPOSGSC-G6L7"),
  part("coupons-7-11", "Coupons 7-11y", "PDPOSGSC-G7L11"),
  part("coupons-11-21", "Coupons 11-21y", "PDPOSGSC-G11L21"),
  part("coupons-21", "Coupons 21y+", "PDPOSGSC-G21"),
  part("tips", "TIPS", "PDPOSTIPS-L2", "PDPOSTIPS-G2", "PDPOSTIPS-G6L11", "PDPOSTIPS-G11"),
  part("frn", "FRN", "PDPOSGS-BFRN"),
  total("agency", "Agency & GSE", "PDPOSFGS-TOT"),
  part("agency-coupons", "Agency coupons", "PDPOSFGS-C"),
  part("discount-notes", "Discount notes", "PDPOSFGS-DN"),
  total("mbs", "MBS", "PDPOSMBS-TOT"),
  part("tba", "TBA", "PDPOSMBSFGS-TBA"),
  part("pools", "Specified pools", "PDPOSMBSFGS-ST"),
  part("agency-resi", "Other agency MBS", "PDPOSMBSFGS-OR"),
  part("agency-cmbs", "Agency CMBS", "PDPOSMBSFGS-C"),
  part("nonagency-resi", "Non-agency residential", "PDPOSMBSNA-R"),
  part("nonagency-cmbs", "Non-agency CMBS", "PDPOSMBSNA-O"),
  total("corporates", "Corporates", "PDPOSCS-TOT"),
  part("ig", "IG bonds", "PDPOSCSBND-L13", "PDPOSCSBND-G13", "PDPOSCSBND-G5L10", "PDPOSCSBND-G10"),
  part("hy", "HY bonds", "PDPOSCSBND-BELL13", "PDPOSCSBND-BELG13", "PDPOSCSBND-BELG5L10", "PDPOSCSBND-BELG10"),
  part("cp", "Commercial paper", "PDPOSCSCP"),
  total("munis", "Munis", "PDPOSSMGO-TOT"),
  total("abs", "ABS", "PDPOSABS-TOT"),
];

/**
 * Settlement fails: deliver, then receive, for each asset, as the release
 * names them (PDFTD and PDFTR). Corporate and agency-debt fails stay off: they
 * are a different order of size and not what the tab is read for.
 */
const FAIL_ASSETS = [
  ["USTET", "Treasuries ex-TIPS"],
  ["UST", "TIPS"],
  ["FGM", "Agency MBS"],
  ["OM", "Other MBS"],
] as const;

const FAIL_ROWS: readonly RowDef[] = FAIL_ASSETS.flatMap(([asset, label]) => [
  { id: `PDFTD-${asset}`, label: `${label}, fails to deliver`, tab: "fails" as const, depth: 0 as const, keys: [`PDFTD-${asset}`] },
  { id: `PDFTR-${asset}`, label: `${label}, fails to receive`, tab: "fails" as const, depth: 0 as const, keys: [`PDFTR-${asset}`] },
]);

/** Every series a board needs, with the series that holds each one's change from the week before. */
export const changeSeriesId = (key: string): string => `${key}C`;

/** Sums with the float noise of fractional $mn figures rounded away. */
function sum(values: readonly number[]): number {
  return Math.round(values.reduce((all, value) => all + value, 0) * 1e6) / 1e6;
}

function parentLabels(defs: readonly RowDef[]): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  let current: string | null = null;
  for (const def of defs) {
    if (def.depth === 0) current = def.label;
    parents.set(def.id, def.depth === 0 ? null : current);
  }
  return parents;
}

/**
 * The board from the latest observation of every series. A row needs every
 * series behind it, all from the same week (a sum with a part missing or from
 * another week would be a different number), and is left out otherwise. Its
 * change is the sum of the series' own published changes, equal to this week
 * minus last week, and is empty when one of them is suppressed or from another
 * week.
 */
export function buildDealerRows(latest: LatestBySeries): DealerRow[] {
  const defs = [...POSITION_ROWS, ...FAIL_ROWS];
  const parents = parentLabels(defs);
  const rows: DealerRow[] = [];
  for (const def of defs) {
    const levels = def.keys.map((key) => latest.get(key));
    const asOf = levels[0]?.asOf;
    if (!asOf || levels.some((point) => point?.asOf !== asOf)) continue;
    const changes = def.keys.map((key) => latest.get(changeSeriesId(key)));
    const level = sum(levels.map((point) => point!.value));
    const change = changes.every((point) => point?.asOf === asOf) ? sum(changes.map((point) => point!.value)) : null;
    rows.push({
      id: def.id,
      label: def.label,
      tab: def.tab,
      depth: def.depth,
      parent: parents.get(def.id) ?? null,
      keys: def.keys,
      asOf,
      latest: level,
      previous: change != null ? sum([level, -change]) : null,
      change,
    });
  }
  return rows;
}

export function boardAsOf(rows: readonly DealerRow[]): string | null {
  let best: string | null = null;
  for (const row of rows) {
    if (row.asOf && (best == null || row.asOf > best)) best = row.asOf;
  }
  return best;
}

/**
 * The newest series break: the one the release is published in now. Breaks
 * restate the series, so keys are only meaningful inside one.
 */
export function newestSeriesBreak(breaks: ReadonlyArray<{ seriesBreak: string; startDate: string }>): string | null {
  let best: { seriesBreak: string; startDate: string } | null = null;
  for (const entry of breaks) {
    if (best == null || entry.startDate > best.startDate) best = entry;
  }
  return best?.seriesBreak ?? null;
}

/** The dates every series has, with the sum of their values: a week a series is missing is not a week of the sum. */
export function sumSeries(series: ReadonlyArray<readonly SeriesPoint[]>): SeriesPoint[] {
  if (series.length === 0) return [];
  const totals = new Map<string, { value: number; count: number }>();
  for (const points of series) {
    for (const point of points) {
      const entry = totals.get(point.asOf);
      if (entry) {
        entry.value += point.value;
        entry.count += 1;
      } else {
        totals.set(point.asOf, { value: point.value, count: 1 });
      }
    }
  }
  return [...totals.entries()]
    .filter(([, entry]) => entry.count === series.length)
    .map(([asOf, entry]) => ({ asOf, value: sum([entry.value]) }))
    .sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
}

/** The chart's ranges; the release's current series start in July 2024, so a long one is all of it. */
export const DEALER_RANGES = [
  { value: "6M", label: "6M", hint: "1", days: 183 },
  { value: "1Y", label: "1Y", hint: "2", days: 366 },
  { value: "ALL", label: "All", hint: "3", days: null },
] as const;

export type DealerRange = typeof DEALER_RANGES[number]["value"];
export const DEFAULT_DEALER_RANGE: DealerRange = "1Y";

export function dealerRange(value: unknown): DealerRange {
  return DEALER_RANGES.find((range) => range.value === value)?.value ?? DEFAULT_DEALER_RANGE;
}

/** The points of the last `range`, counted back from the newest observation. */
export function pointsInRange(points: readonly SeriesPoint[], range: DealerRange): SeriesPoint[] {
  const days = DEALER_RANGES.find((entry) => entry.value === range)?.days ?? null;
  const last = points.at(-1);
  if (days == null || !last) return [...points];
  const cutoff = Date.parse(`${last.asOf}T00:00:00Z`) - days * 86_400_000;
  return points.filter((point) => Date.parse(`${point.asOf}T00:00:00Z`) >= cutoff);
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

/**
 * The row's name, a breakdown set in under its total. The indent is no-break
 * spaces: table cells do not wrap, and on the desktop that also folds ordinary
 * leading spaces away.
 */
export function dealerRowLabel(row: Pick<DealerRow, "label" | "depth">): string {
  return `${"\u00a0\u00a0".repeat(row.depth)}${row.label}`;
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
