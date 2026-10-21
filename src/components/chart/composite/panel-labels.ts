import type { ChartSurfaceProps } from "../../../ui";
import type { NativeChartBitmap } from "../native/chart-rasterizer";
import { compositeAxisTicks, formatCompositeCursorValue, type CompositeAxisValueFormatter } from "./format";
import { projectCompositeValue, unprojectCompositeValue } from "./scene";
import type { CompositeAxisDomain, CompositeChartScene, CompositePanelScene } from "./types";

/**
 * The crosshair, and a marker where it crosses each line: hollow where the
 * line has no observation at the cursor's time and carries its last one.
 * Columns are read off their own bars.
 */
export function resolvePanelCrosshair(
  panel: CompositePanelScene,
  bitmap: NativeChartBitmap | null,
  scene: Pick<CompositeChartScene, "cursorXRatio" | "cursorValues">,
  cursorYRatio: number | null,
  color: string,
): ChartSurfaceProps["crosshair"] {
  const cursorXRatio = scene.cursorXRatio;
  if (!bitmap || cursorXRatio === null) return null;
  const values = new Map(scene.cursorValues.map((entry) => [entry.seriesId, entry] as const));
  const markers = panel.series.flatMap((series) => {
    const cursor = values.get(series.source.id);
    const domain = panel.axes[series.source.axis];
    if (!cursor || cursor.value === null || !domain || series.source.style === "columns" || series.source.profile) return [];
    const yRatio = projectCompositeValue(cursor.value, domain);
    if (yRatio === null || yRatio < 0 || yRatio > 1) return [];
    return [{
      pixelY: yRatio * Math.max(bitmap.height - 1, 0),
      color: series.source.color,
      ...(cursor.carried ? { hollow: true } : {}),
    }];
  });
  return {
    pixelX: cursorXRatio * Math.max(bitmap.width - 1, 0),
    pixelY: cursorYRatio === null ? null : cursorYRatio * Math.max(bitmap.height - 1, 0),
    color,
    markers,
  };
}

export interface SeriesAxisTag {
  seriesId: string;
  seriesLabel: string;
  side: "left" | "right";
  value: number;
  label: string;
  color: string;
  yRatio: number;
  carried: boolean;
}

/** Each observation belongs to its own axis, never to the pointer's height. */
export function resolveSeriesAxisTags(
  panel: CompositePanelScene,
  scene: Pick<CompositeChartScene, "cursorXRatio" | "cursorValues">,
  format?: CompositeAxisValueFormatter,
): SeriesAxisTag[] {
  if (scene.cursorXRatio === null) return [];
  const values = new Map(scene.cursorValues.map((entry) => [entry.seriesId, entry]));
  return panel.series.flatMap(({ source }) => {
    const cursor = values.get(source.id);
    const domain = panel.axes[source.axis];
    if (source.hidden || !domain || cursor?.value == null) return [];
    const yRatio = projectCompositeValue(cursor.value, domain);
    // An axis scaled by hand tags only the values it shows.
    if (yRatio === null || (domain.manual && (yRatio < 0 || yRatio > 1))) return [];
    return [{
      seriesId: source.id,
      seriesLabel: source.label,
      side: source.axis,
      value: cursor.value,
      label: (format ?? formatCompositeCursorValue)(cursor.value, domain),
      color: source.color,
      yRatio,
      carried: !!cursor.carried,
    }];
  });
}

export function axisLabelRows(lines: string[]): ReadonlyMap<number, string> {
  return new Map(lines.flatMap((line, row) => {
    const label = line.trim();
    return label ? [[row, label] as const] : [];
  }));
}

export function cursorAxisLabel(
  panel: CompositePanelScene,
  side: "left" | "right",
  cursorYRatio: number | null,
  format?: CompositeAxisValueFormatter,
): string | null {
  const domain = panel.axes[side];
  if (!domain || cursorYRatio === null) return null;
  const value = unprojectCompositeValue(cursorYRatio, domain);
  if (value === null) return null;
  return format ? format(value, domain) : formatCompositeCursorValue(value, domain);
}

export const MINIMUM_AXIS_LABEL_WIDTH = 3;

/**
 * Reserve cursor precision even when the tick values are round numbers. This
 * keeps the plot stable while the pointer moves between integer tick values.
 */
export function compositeAxisLabelWidth(
  domain: CompositeAxisDomain | undefined,
  format: CompositeAxisValueFormatter | undefined,
  includeCursor: boolean,
): number {
  if (!domain) return 0;
  const ticks = compositeAxisTicks(domain, format);
  const labels = ticks.map((tick) => tick.label);
  if (includeCursor) {
    const cursorFormat = format ?? formatCompositeCursorValue;
    for (const { value } of ticks) {
      labels.push(cursorFormat(value, domain));
      // Totals use two decimals at their compact scale; prices can use four
      // below one currency unit. Probe those digits without changing the data.
      const scale = domain.unitGroup.toLowerCase().split(":")[0] === "currency-total"
        ? 10 ** Math.max(0, Math.min(12, Math.floor(Math.log10(Math.abs(value) || 1) / 3) * 3))
        : Math.abs(value) > 0 && Math.abs(value) < 0.01
          ? 10 ** Math.floor(Math.log10(Math.abs(value))) : 1;
      const precisionValue = (value < 0 ? -1 : 1) * (Math.floor(Math.abs(value) / scale) + 0.1234) * scale;
      labels.push(cursorFormat(precisionValue, domain));
    }
  }
  return labels.reduce((widest, label) => Math.max(widest, [...label].length), 0);
}


export function resolveSeriesCursorYRatio(
  panel: CompositePanelScene,
  scene: CompositeChartScene,
): number | null {
  for (const series of panel.series) {
    const value = scene.cursorValues.find(
      (entry) => entry.seriesId === series.source.id,
    )?.value ?? null;
    const domain = panel.axes[series.source.axis];
    if (value === null || !domain) continue;
    const yRatio = projectCompositeValue(value, domain);
    if (yRatio !== null) return yRatio;
  }
  return null;
}
