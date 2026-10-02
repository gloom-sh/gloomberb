import type { ChartVectorShape } from "../../../ui/host";
import type { NativeChartBitmap } from "../native/chart-rasterizer";
import { drawLine, parseHex } from "../native/raster/primitives";
import { projectCompositeValue } from "./scene";
import type { CompositeAxisDomain, CompositeChartScene, CompositePanelScene } from "./types";
import { clamp } from "../../../utils/math";

/** A horizontal price level across the plot, with its price on the axis. */
export interface CompositeChartLevel {
  id: string;
  value: number;
  color: string;
  /** False for a level the chart shows but something else owns, such as a price alert. */
  editable: boolean;
  /** Whether the chart's level action applies to it. */
  actionable: boolean;
}

export type CompositeLevelEdit =
  | { kind: "add"; id: string; value: number }
  | { kind: "move"; id: string; value: number }
  | { kind: "remove"; id: string };

export interface CompositeChartLevels {
  /** The series the levels are prices of; they draw on its panel and axis. */
  seriesId: string;
  items: readonly CompositeChartLevel[];
  /** Present when levels can be added, moved and removed here. */
  onEdit?: (edit: CompositeLevelEdit) => void;
  /** One action on the selected level, such as turning it into an alert. */
  action?: { label: string; title: string; run: (level: CompositeChartLevel) => void };
}

export interface ProjectedLevel {
  level: CompositeChartLevel;
  yRatio: number;
}

/** Pointer slack for grabbing a level: a share of the plot, at least half a text row. */
export function levelGrabRatio(panelRows: number): number {
  return Math.max(0.03, 0.6 / Math.max(panelRows - 1, 1));
}

/** The panel holding the levels' series and the axis their prices read on. */
export function levelPanel(
  scene: CompositeChartScene,
  seriesId: string,
): { panel: CompositePanelScene; domain: CompositeAxisDomain } | null {
  for (const panel of scene.panels) {
    const series = panel.series.find((entry) => entry.source.id === seriesId);
    const domain = series ? panel.axes[series.source.axis] : undefined;
    if (domain) return { panel, domain };
  }
  return null;
}

/** Levels inside the axis range, with a dragged level at its draft value. */
export function projectLevels(
  items: readonly CompositeChartLevel[],
  domain: CompositeAxisDomain,
  draft: { id: string; value: number } | null,
): ProjectedLevel[] {
  return items.flatMap((level) => {
    const value = draft?.id === level.id ? draft.value : level.value;
    const yRatio = projectCompositeValue(value, domain);
    return yRatio === null || yRatio < 0 || yRatio > 1 ? [] : [{ level: { ...level, value }, yRatio }];
  });
}

/** The level nearest the pointer's height within the slack; editable ones win ties. */
export function hitTestLevel(levels: readonly ProjectedLevel[], yRatio: number, slack: number): CompositeChartLevel | null {
  let best: ProjectedLevel | null = null;
  for (const entry of levels) {
    const distance = Math.abs(entry.yRatio - yRatio);
    if (distance > slack) continue;
    const bestDistance = best ? Math.abs(best.yRatio - yRatio) : Number.POSITIVE_INFINITY;
    if (distance < bestDistance || (distance === bestDistance && entry.level.editable && !best?.level.editable)) best = entry;
  }
  return best?.level ?? null;
}

/**
 * A price placed by pointer or arrow key, rounded to what the axis can tell
 * apart (about a two-hundredth of its span), so a level reads 230.45, not
 * 230.4471.
 */
export function roundLevelValue(value: number, domain: Pick<CompositeAxisDomain, "min" | "max">): number {
  const span = Math.abs(domain.max - domain.min);
  if (!(span > 0) || !Number.isFinite(value)) return value;
  const decimals = clamp(Math.ceil(-Math.log10(span / 200)), 0, 8);
  return Number(value.toFixed(decimals));
}

/**
 * The level labels that fit on the axis beside the ones already there, taken
 * in the order given. Each needs a row of its own, measured by `rowOf` in rows
 * (fractional on the desktop), so a level close to another keeps its line and
 * loses only its label.
 */
export function fitAxisLabels<T>(
  candidates: readonly T[],
  taken: readonly T[],
  rowOf: (entry: T) => number,
): T[] {
  const placed = taken.map(rowOf);
  return candidates.filter((candidate) => {
    const row = rowOf(candidate);
    if (placed.some((other) => Math.abs(other - row) < 1)) return false;
    placed.push(row);
    return true;
  });
}

export function levelVectors(levels: readonly ProjectedLevel[], selectedId: string | null): ChartVectorShape[] {
  return levels.map(({ level, yRatio }) => ({
    id: `level:${level.id}`,
    points: [{ x: 0, y: yRatio }, { x: 1, y: yRatio }],
    color: level.color,
    strokeWidth: level.id === selectedId ? 2.2 : 1.2,
  }));
}

/** Levels painted on a copy of the panel raster, the one layer the terminal uploads. */
export function paintLevels(
  base: NativeChartBitmap,
  levels: readonly ProjectedLevel[],
  selectedId: string | null,
): NativeChartBitmap {
  const data = new Uint8Array(base.pixels);
  const maxX = Math.max(base.width - 1, 0);
  const maxY = Math.max(base.height - 1, 0);
  for (const { level, yRatio } of levels) {
    const y = Math.round(yRatio * maxY);
    drawLine(data, base.width, base.height, 0, y, maxX, y, parseHex(level.color), level.id === selectedId ? 2.2 : 1.2);
  }
  return { width: base.width, height: base.height, pixels: data };
}

/**
 * Levels in the terminal text plot, written into blank cells so they read as
 * running under the marks: `━` selected, `─` drawn here, `┄` owned elsewhere.
 */
export function writeLevelText(lines: readonly string[], levels: readonly ProjectedLevel[], selectedId: string | null): string[] {
  if (levels.length === 0 || lines.length === 0) return [...lines];
  const rows = lines.map((line) => Array.from(line));
  for (const { level, yRatio } of levels) {
    const row = rows[clamp(Math.round(yRatio * (rows.length - 1)), 0, rows.length - 1)]!;
    const glyph = level.id === selectedId ? "━" : level.editable ? "─" : "┄";
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] === " " || row[x] === "·" || row[x] === "╌") row[x] = glyph;
    }
  }
  return rows.map((row) => row.join(""));
}
