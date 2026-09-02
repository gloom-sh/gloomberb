import { blendHex, colors } from "../../../theme/colors";
import type { StatTransform } from "./transform";

export type StatCategoryId =
  | "inflation"
  | "labor"
  | "growth"
  | "consumer"
  | "housing"
  | "rates"
  | "trade";

export const STAT_CATEGORIES: ReadonlyArray<{ id: StatCategoryId; label: string }> = [
  { id: "inflation", label: "Inflation" },
  { id: "labor", label: "Labor" },
  { id: "growth", label: "Growth" },
  { id: "consumer", label: "Consumer" },
  { id: "housing", label: "Housing" },
  { id: "rates", label: "Rates & Money" },
  { id: "trade", label: "Trade & Costs" },
];

/**
 * Whether a rising number is welcome. Unemployment climbing is bad, payrolls
 * climbing is good, and an index level like CPI is neither on its own, so the
 * table colours the change accordingly instead of pretending every rise is green.
 */
export type StatDirection = "higher-is-good" | "higher-is-bad" | "neutral";

export interface StatDef {
  id: string;
  label: string;
  /** Fits the table's INDICATOR column. */
  shortLabel: string;
  category: StatCategoryId;
  seriesId: string;
  transform: StatTransform;
  /**
   * Multiplier applied to raw observations before the transform, to bring a series
   * into the unit it is quoted in. Percent changes are ratios, so scaling cannot
   * affect them; it only matters for levels.
   */
  scale?: number;
  direction: StatDirection;
  /** Drives the chart axis and the cursor readout. */
  axisUnit: "%" | "";
  formatValue: (value: number) => string;
  /** A level that means something: the Fed's target, zero for a spread. */
  reference: { value: number; label: string } | null;
  /** How old the newest print may get before the pane flags it stale. */
  staleAfterMs: number;
  note: string;
  limit: number;
}

export function categoryLabel(id: StatCategoryId): string {
  return STAT_CATEGORIES.find((entry) => entry.id === id)?.label ?? id;
}

/** Green when the move is welcome, red when it is not, plain when it is neither. */
export function changeColor(direction: StatDirection, change: number | null): string {
  if (change == null || !Number.isFinite(change) || change === 0) return colors.textMuted;
  if (direction === "neutral") return colors.text;
  const good = direction === "higher-is-good" ? change > 0 : change < 0;
  return good ? colors.positive : blendHex(colors.negative, "#000000", 0.1);
}
