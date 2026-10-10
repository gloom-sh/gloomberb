import type { ChartSurfaceProps } from "../../../ui";
import type { NativeChartBitmap } from "../native/chart-rasterizer";
import { compositeAxisTicks, formatCompositeCursorValue, type CompositeAxisValueFormatter } from "./format";
import type { CompositeColumnLayout } from "./column-layout";
import { projectCompositeValue, unprojectCompositeValue } from "./scene";
import type { CompositeAxisDomain, CompositeChartScene, CompositePanelScene } from "./types";

export function resolvePanelCrosshair(
  panel: CompositePanelScene,
  columnLayout: CompositeColumnLayout,
  bitmap: NativeChartBitmap | null,
  cursorXRatio: number | null,
  cursorYRatio: number | null,
  color: string,
): ChartSurfaceProps["crosshair"] {
  if (!bitmap || cursorXRatio === null) return null;
  const markers = panel.series.flatMap((series) => {
    // Column cohorts are drawn at their group center, not each observation's
    // own timestamp, so match the position the bar actually occupies.
    const cursorPoint = series.points.find((point) => {
      const xRatio = series.source.style === "columns"
        ? columnLayout.groupByPoint.get(point)?.xRatio ?? point.xRatio
        : point.xRatio;
      return Math.abs(xRatio - cursorXRatio) < 1e-9;
    });
    return cursorPoint
      ? [{
        pixelY: cursorPoint.yRatio * Math.max(bitmap.height - 1, 0),
        color: series.source.color,
      }]
      : [];
  });
  return {
    pixelX: cursorXRatio * Math.max(bitmap.width - 1, 0),
    pixelY: cursorYRatio === null ? null : cursorYRatio * Math.max(bitmap.height - 1, 0),
    color,
    markers,
  };
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
