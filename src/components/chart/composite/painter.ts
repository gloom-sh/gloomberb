import type { ChartPaintPoint, ChartPainter } from "../core/painter";
import {
  buildCompositeColumnLayout,
  type CompositeColumnGroupCenter,
  type CompositeColumnLayout,
} from "./column-layout";
import { projectCompositeValue } from "./scene";
import type {
  CompositeAxisDomain,
  CompositeChartColors,
  CompositePanelScene,
  CompositeProjectedPoint,
  CompositeProjectedSeries,
} from "./types";

const clamp = (value: number, minimum: number, maximum: number) => (
  Math.max(minimum, Math.min(maximum, value))
);

function pixelPoint(
  point: CompositeProjectedPoint,
  width: number,
  height: number,
): ChartPaintPoint {
  return {
    x: clamp(point.xRatio * Math.max(width - 1, 0), 0, Math.max(width - 1, 0)),
    y: clamp(point.yRatio * Math.max(height - 1, 0), 0, Math.max(height - 1, 0)),
  };
}

function pixelY(value: number, domain: CompositeAxisDomain, height: number): number | null {
  const ratio = projectCompositeValue(value, domain);
  return ratio === null
    ? null
    : clamp(ratio * Math.max(height - 1, 0), 0, Math.max(height - 1, 0));
}

function connectedRuns(
  series: CompositeProjectedSeries,
  width: number,
  height: number,
): ChartPaintPoint[][] {
  const runs: ChartPaintPoint[][] = [];
  series.points.forEach((point, index) => {
    if (index === 0 || point.breakBefore || runs.length === 0) runs.push([]);
    runs.at(-1)!.push(pixelPoint(point, width, height));
  });
  return runs;
}

function paintConnectedSeries(
  painter: ChartPainter,
  width: number,
  height: number,
  series: CompositeProjectedSeries,
  domain: CompositeAxisDomain,
  area: boolean,
): void {
  const runs = connectedRuns(series, width, height);
  const baseline = pixelY(0, domain, height) ?? height - 1;
  const step = series.source.style === "step" || series.source.interpolation === "step-after";
  const lineWidth = step ? 1.4 : 1.5;

  for (const run of runs) {
    if (run.length === 1) {
      painter.circle(run[0]!.x, run[0]!.y, 2.2, series.source.color);
      continue;
    }
    if (area) painter.area(run, baseline, series.source.color, 0.14, step);
    painter.path(run, series.source.color, lineWidth, step);
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function ratioGaps(ratios: readonly number[], pixelWidth: number): number[] {
  const xs = ratios
    .map((ratio) => ratio * Math.max(pixelWidth - 1, 0))
    .sort((left, right) => left - right);
  const positiveGaps: number[] = [];
  for (let index = 1; index < xs.length; index += 1) {
    const gap = xs[index]! - xs[index - 1]!;
    if (gap > 0) positiveGaps.push(gap);
  }
  return positiveGaps;
}

export function resolveCompositeObservationWidth(
  points: CompositeProjectedPoint[],
  extent: number,
  minimum: number,
  maximum: number,
): number {
  const typicalGap = median(ratioGaps(points.map((point) => point.xRatio), extent));
  return clamp(typicalGap === null ? maximum : typicalGap * 0.58, minimum, maximum);
}

function columnObservationWidth(
  ratios: readonly number[],
  pixelWidth: number,
  maximum: number,
): number {
  const typicalGap = median(ratioGaps(ratios, pixelWidth));
  return clamp(typicalGap === null ? maximum : typicalGap * 0.58, 2, maximum);
}

function columnCenterGaps(
  centers: readonly CompositeColumnGroupCenter[],
  pixelWidth: number,
): number[] {
  const scale = Math.max(pixelWidth - 1, 0);
  const positiveGaps: number[] = [];
  for (let index = 1; index < centers.length; index += 1) {
    const previous = centers[index - 1]!;
    const current = centers[index]!;
    const ordinalGap = previous.ordinal !== null
      && current.ordinal !== null
      && current.ordinal > previous.ordinal
      ? current.ordinal - previous.ordinal
      : 1;
    const gap = (current.xRatio - previous.xRatio) * scale / ordinalGap;
    if (gap > 0) positiveGaps.push(gap);
  }
  return positiveGaps;
}

function columnWidthFromCenters(
  centers: readonly CompositeColumnGroupCenter[],
  pixelWidth: number,
  maximum: number,
): number {
  const typicalGap = median(columnCenterGaps(centers, pixelWidth));
  return clamp(typicalGap === null ? maximum : typicalGap * 0.58, 2, maximum);
}

function maximumColumnClusterWidth(pixelWidth: number, seriesCount: number): number {
  return clamp(pixelWidth * 0.04, 18, 72) * Math.max(1, seriesCount);
}

export function resolveCompositeColumnWidth(
  points: CompositeProjectedPoint[],
  pixelWidth: number,
): number {
  const maximum = clamp(pixelWidth * 0.04, 18, 72);
  return columnObservationWidth(points.map((point) => point.xRatio), pixelWidth, maximum);
}

export function resolveCompositeOhlcWidth(
  points: CompositeProjectedPoint[],
  pixelWidth: number,
): number {
  const maximum = clamp(pixelWidth * 0.03, 12, 36);
  return resolveCompositeObservationWidth(points, pixelWidth, 2, maximum);
}

function columnPixelGeometry(
  projected: CompositeProjectedPoint,
  width: number,
  layout: CompositeColumnLayout,
  widthByFamily: ReadonlyMap<string, number>,
): { x: number; width: number } {
  const group = layout.groupByPoint.get(projected) ?? {
    index: 0,
    count: 1,
    xRatio: projected.xRatio,
    familyKey: "",
  };
  const maximum = maximumColumnClusterWidth(width, group.count);
  const clusterWidth = widthByFamily.get(group.familyKey) ?? maximum;
  const drawableWidth = Math.min(clusterWidth, Math.max(width - 1, 1));
  const slotWidth = drawableWidth / group.count;
  const groupCenter = clamp(
    group.xRatio * Math.max(width - 1, 0),
    0,
    Math.max(width - 1, 0),
  );
  const clusterLeft = clamp(
    groupCenter - drawableWidth / 2,
    0,
    Math.max(width - 1 - drawableWidth, 0),
  );
  return {
    x: clusterLeft + slotWidth * (group.index + 0.5),
    width: group.count === 1 ? slotWidth : slotWidth * 0.78,
  };
}

function paintColumns(
  painter: ChartPainter,
  width: number,
  height: number,
  series: CompositeProjectedSeries,
  domain: CompositeAxisDomain,
  layout: CompositeColumnLayout,
  widthByFamily: ReadonlyMap<string, number>,
  opacity: number,
): void {
  const baseline = pixelY(0, domain, height) ?? height - 1;
  for (const projected of series.points) {
    const point = pixelPoint(projected, width, height);
    const geometry = columnPixelGeometry(projected, width, layout, widthByFamily);
    painter.fillRect(
      geometry.x - geometry.width / 2,
      Math.min(point.y, baseline),
      geometry.x + geometry.width / 2,
      Math.max(point.y, baseline),
      series.source.color,
      opacity,
    );
  }
}

function paintOhlc(
  painter: ChartPainter,
  width: number,
  height: number,
  series: CompositeProjectedSeries,
  domain: CompositeAxisDomain,
  negative: string,
): void {
  const candleWidth = resolveCompositeOhlcWidth(series.points, width);
  const halfWidth = Math.min(candleWidth / 2, Math.max(width - 1, 0) / 2);
  for (const projected of series.points) {
    const source = projected.point;
    const x = clamp(
      pixelPoint(projected, width, height).x,
      halfWidth,
      Math.max(width - 1 - halfWidth, halfWidth),
    );
    const close = source.close ?? projected.value;
    const open = source.open ?? close;
    const high = source.high ?? Math.max(open, close);
    const low = source.low ?? Math.min(open, close);
    const highY = pixelY(high, domain, height);
    const lowY = pixelY(low, domain, height);
    const openY = pixelY(open, domain, height);
    const closeY = pixelY(close, domain, height);
    if (highY === null || lowY === null || closeY === null) continue;
    const color = close >= open ? series.source.color : negative;
    painter.line(x, highY, x, lowY, color, 1.1);
    if (series.source.style === "candles" && openY !== null) {
      painter.fillRect(
        x - halfWidth,
        Math.min(openY, closeY),
        x + halfWidth,
        Math.max(openY, closeY) + 1,
        color,
      );
      continue;
    }
    if (series.source.style === "ohlc" && openY !== null) {
      painter.line(x - halfWidth, openY, x, openY, color, 1.2);
    }
    painter.line(x, closeY, x + halfWidth, closeY, color, 1.2);
  }
}

export function paintCompositePanel(
  painter: ChartPainter,
  panel: CompositePanelScene,
  colors: CompositeChartColors,
  width: number,
  height: number,
): void {
  painter.clear(colors.background);
  for (let index = 1; index <= 3; index += 1) {
    const y = (height - 1) * (index / 4);
    painter.fillRect(0, y, width - 1, y + 0.6, colors.grid, 0.42);
  }

  const ordered = [...panel.series].sort((left, right) => {
    const rank = (style: string) => style === "area" || style === "columns" ? 0 : 1;
    return rank(left.source.style) - rank(right.source.style);
  });
  const columnLayout = buildCompositeColumnLayout(panel);
  const columnWidthByFamily = new Map<string, number>();
  for (const [family, centers] of columnLayout.centersByFamily) {
    const maximum = maximumColumnClusterWidth(
      width,
      columnLayout.seriesCountByFamily.get(family) ?? 1,
    );
    columnWidthByFamily.set(family, columnWidthFromCenters(centers, width, maximum));
  }
  const mixesColumnsWithOtherMarks = panel.series.some((series) => series.source.style === "columns")
    && panel.series.some((series) => series.source.style !== "columns");

  for (const series of ordered) {
    const domain = panel.axes[series.source.axis];
    if (!domain) continue;
    switch (series.source.style) {
      case "columns":
        paintColumns(
          painter,
          width,
          height,
          series,
          domain,
          columnLayout,
          columnWidthByFamily,
          mixesColumnsWithOtherMarks ? 0.48 : 0.72,
        );
        break;
      case "area":
        paintConnectedSeries(painter, width, height, series, domain, true);
        break;
      case "points":
        for (const point of series.points) {
          const projected = pixelPoint(point, width, height);
          painter.circle(projected.x, projected.y, 2.4, series.source.color);
        }
        break;
      case "candles":
      case "ohlc":
      case "hlc":
        paintOhlc(painter, width, height, series, domain, colors.negative);
        break;
      case "line":
      case "step":
        paintConnectedSeries(painter, width, height, series, domain, false);
        break;
    }
  }
}
