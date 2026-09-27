import type { ScannerHiloExtreme, ScannerHiloPayload } from "../../../api-client";

export type HiloWindowKey = keyof ScannerHiloPayload["windows"];
export type HiloMinPrice = "off" | "1" | "5";
export type HiloSort = "recent" | "count";

/** Widest window first, so the dominant bar reads as the top of the funnel. */
export const HILO_WINDOW_ROWS: ReadonlyArray<{ key: HiloWindowKey; label: string }> = [
  { key: "m5", label: "5 min" },
  { key: "m1", label: "1 min" },
  { key: "s30", label: "30 sec" },
];

/** Two decimals, four under a dollar, so a price column lines up. */
export function formatHiloPrice(price: number): string {
  if (!Number.isFinite(price)) return "--";
  return price.toLocaleString("en-US", { minimumFractionDigits: price < 1 ? 4 : 2, maximumFractionDigits: price < 1 ? 4 : 2 });
}

export interface HiloBarRow {
  key: HiloWindowKey;
  label: string;
  highs: number;
  lows: number;
  /** 0..1 against the single scale shared by every row and both sides. */
  highRatio: number;
  lowRatio: number;
}

/**
 * One scale across all six counts, so the 5 min row visibly dominates instead of
 * every row saturating its own half.
 */
export function buildHiloBarRows(windows: ScannerHiloPayload["windows"] | null | undefined): HiloBarRow[] {
  const rows = HILO_WINDOW_ROWS.map(({ key, label }) => ({
    key,
    label,
    highs: Math.max(0, windows?.[key]?.highs ?? 0),
    lows: Math.max(0, windows?.[key]?.lows ?? 0),
  }));
  const scale = Math.max(0, ...rows.flatMap((row) => [row.highs, row.lows]));
  return rows.map((row) => ({
    ...row,
    highRatio: scale > 0 ? row.highs / scale : 0,
    lowRatio: scale > 0 ? row.lows / scale : 0,
  }));
}

/** Room for "30 sec" with two cells either side, so a count never runs into the window label. */
export const HILO_LABEL_WIDTH = 10;
/** "HIGHS" plus a cell of gap from the bar. */
export const HILO_SIDE_NAME_WIDTH = 6;
/** The side names give way before they would squeeze a bar below this many cells. */
const MIN_NAMED_BAR_WIDTH = 10;
const MIN_HALF_WIDTH = 4;

/** The window label centred by padding, so both renderers leave the same gap to the counts. */
export function hiloWindowLabel(label: string): string {
  const lead = Math.max(0, Math.floor((HILO_LABEL_WIDTH - label.length) / 2));
  return label.padStart(label.length + lead).padEnd(HILO_LABEL_WIDTH);
}

export interface HiloBarLayout {
  /** Cells for one side's count and bar. */
  halfWidth: number;
  barWidth: number;
  /** Cells for "LOWS" and "HIGHS" at the ends of the top row; 0 when the pane is too narrow. */
  sideNameWidth: number;
}

/**
 * Splits a bars row of `width` cells (one cell of padding each side) around the
 * window label. `countWidth` is the widest count plus its gap to the bar.
 */
export function hiloBarLayout(width: number, countWidth: number): HiloBarLayout {
  const available = Math.max(MIN_HALF_WIDTH, Math.floor((width - 2 - HILO_LABEL_WIDTH) / 2));
  const sideNameWidth = available - HILO_SIDE_NAME_WIDTH - countWidth >= MIN_NAMED_BAR_WIDTH ? HILO_SIDE_NAME_WIDTH : 0;
  const halfWidth = available - sideNameWidth;
  return { halfWidth, barWidth: Math.max(0, halfWidth - countWidth), sideNameWidth };
}

export interface TerminalBarCells {
  full: number;
  /** Trailing half cell, so small-but-nonzero counts stay visible in cell units. */
  half: boolean;
}

/** Converts a 0..1 bar ratio into terminal cells at half-cell resolution. */
export function terminalBarCells(ratio: number, halfWidth: number): TerminalBarCells {
  if (!(ratio > 0) || halfWidth <= 0) return { full: 0, half: false };
  const capped = Math.min(1, ratio);
  const cells = capped * halfWidth;
  let full = Math.floor(cells);
  let half = cells - full >= 0.5;
  if (full >= halfWidth) return { full: halfWidth, half: false };
  if (full === 0 && !half) half = true;
  return { full, half };
}

export function hiloMinPriceValue(setting: HiloMinPrice): number {
  return setting === "1" ? 1 : setting === "5" ? 5 : 0;
}

export function filterHiloRows(
  rows: readonly ScannerHiloExtreme[] | undefined,
  minPrice: HiloMinPrice,
  sort: HiloSort,
): ScannerHiloExtreme[] {
  const floor = hiloMinPriceValue(minPrice);
  const filtered = (rows ?? []).filter((row) => row.price >= floor);
  return sort === "count"
    ? [...filtered].sort((left, right) => right.count - left.count || right.at - left.at)
    : [...filtered].sort((left, right) => right.at - left.at);
}
