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
