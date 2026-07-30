import type { NativeChartBitmap } from "../native/chart-rasterizer";
import {
  drawCircle,
  drawLine,
  fillRect,
  parseHex,
  type RgbaColor,
} from "../native/raster/primitives";
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

interface RenderCompositePanelBitmapOptions {
  pixelWidth: number;
  pixelHeight: number;
  colors: CompositeChartColors;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function pixelPoint(point: CompositeProjectedPoint, width: number, height: number): { x: number; y: number } {
  return {
    x: clamp(point.xRatio * Math.max(width - 1, 0), 0, Math.max(width - 1, 0)),
    y: clamp(point.yRatio * Math.max(height - 1, 0), 0, Math.max(height - 1, 0)),
  };
}

function pixelY(value: number, domain: CompositeAxisDomain, height: number): number | null {
  const ratio = projectCompositeValue(value, domain);
  return ratio === null ? null : clamp(ratio * Math.max(height - 1, 0), 0, Math.max(height - 1, 0));
}

function drawConnectedSeries(
  data: Uint8Array,
  width: number,
  height: number,
  series: CompositeProjectedSeries,
  domain: CompositeAxisDomain,
  color: RgbaColor,
  area: boolean,
): void {
  const points = series.points.map((point) => pixelPoint(point, width, height));
  if (points.length === 0) return;
  const baseline = pixelY(0, domain, height) ?? height - 1;
  const step = series.source.style === "step" || series.source.interpolation === "step-after";

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    if (series.points[index]?.breakBefore) continue;
    if (area) {
      const left = Math.round(Math.min(previous.x, current.x));
      const right = Math.round(Math.max(previous.x, current.x));
      for (let x = left; x <= right; x += 1) {
        const ratio = right === left ? 0 : (x - left) / (right - left);
        const y = step ? previous.y : previous.y + (current.y - previous.y) * ratio;
        fillRect(data, width, height, x, Math.min(y, baseline), x, Math.max(y, baseline), color, 0.14);
      }
    }
    if (step) {
      drawLine(data, width, height, previous.x, previous.y, current.x, previous.y, color, 1.4);
      drawLine(data, width, height, current.x, previous.y, current.x, current.y, color, 1.4);
    } else {
      drawLine(data, width, height, previous.x, previous.y, current.x, current.y, color, 1.5);
    }
  }

  // A line segment cannot represent a lone observation (or one isolated by
  // missing values). Mark only those observations; do not extend them across
  // time or add markers to normally connected lines.
  for (let index = 0; index < points.length; index += 1) {
    const connectedToPrevious = index > 0 && series.points[index]?.breakBefore === false;
    const connectedToNext = index + 1 < points.length && series.points[index + 1]?.breakBefore === false;
    if (!connectedToPrevious && !connectedToNext) {
      const point = points[index]!;
      drawCircle(data, width, height, point.x, point.y, 2.2, color);
    }
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
  const xs = ratios.map((ratio) => ratio * Math.max(pixelWidth - 1, 0)).sort((left, right) => left - right);
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
  const maximumSlotWidth = clamp(pixelWidth * 0.04, 18, 72);
  return maximumSlotWidth * Math.max(1, seriesCount);
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
  const columnWidth = group.count === 1 ? slotWidth : slotWidth * 0.78;
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
    width: columnWidth,
  };
}

function drawColumns(
  data: Uint8Array,
  width: number,
  height: number,
  series: CompositeProjectedSeries,
  domain: CompositeAxisDomain,
  color: RgbaColor,
  layout: CompositeColumnLayout,
  widthByFamily: ReadonlyMap<string, number>,
  opacity: number,
): void {
  const baseline = pixelY(0, domain, height) ?? height - 1;
  for (const projected of series.points) {
    const point = pixelPoint(projected, width, height);
    const geometry = columnPixelGeometry(projected, width, layout, widthByFamily);
    fillRect(
      data,
      width,
      height,
      geometry.x - geometry.width / 2,
      Math.min(point.y, baseline),
      geometry.x + geometry.width / 2,
      Math.max(point.y, baseline),
      color,
      opacity,
    );
  }
}

function drawOhlc(
  data: Uint8Array,
  width: number,
  height: number,
  series: CompositeProjectedSeries,
  domain: CompositeAxisDomain,
  color: RgbaColor,
  negative: RgbaColor,
): void {
  const candleWidth = resolveCompositeOhlcWidth(series.points, width);
  for (const projected of series.points) {
    const source = projected.point;
    const x = pixelPoint(projected, width, height).x;
    const close = source.close ?? projected.value;
    const open = source.open ?? close;
    const high = source.high ?? Math.max(open, close);
    const low = source.low ?? Math.min(open, close);
    const highY = pixelY(high, domain, height);
    const lowY = pixelY(low, domain, height);
    const openY = pixelY(open, domain, height);
    const closeY = pixelY(close, domain, height);
    if (highY === null || lowY === null || closeY === null) continue;
    const candleColor = close >= open ? color : negative;
    drawLine(data, width, height, x, highY, x, lowY, candleColor, 1.1);
    if (series.source.style === "candles" && openY !== null) {
      fillRect(
        data,
        width,
        height,
        x - candleWidth / 2,
        Math.min(openY, closeY),
        x + candleWidth / 2,
        Math.max(openY, closeY) + 1,
        candleColor,
      );
      continue;
    }
    if (series.source.style === "ohlc" && openY !== null) {
      drawLine(data, width, height, x - candleWidth / 2, openY, x, openY, candleColor, 1.2);
    }
    drawLine(data, width, height, x, closeY, x + candleWidth / 2, closeY, candleColor, 1.2);
  }
}

export function renderCompositePanelBitmap(
  panel: CompositePanelScene,
  options: RenderCompositePanelBitmapOptions,
): NativeChartBitmap {
  const width = Math.max(1, Math.floor(options.pixelWidth));
  const height = Math.max(1, Math.floor(options.pixelHeight));
  const data = new Uint8Array(width * height * 4);
  const background = parseHex(options.colors.background);
  const grid = parseHex(options.colors.grid);
  const negative = parseHex(options.colors.negative);
  fillRect(data, width, height, 0, 0, width - 1, height - 1, background, 1);

  for (let index = 1; index <= 3; index += 1) {
    const y = (height - 1) * (index / 4);
    fillRect(data, width, height, 0, y, width - 1, y + 0.6, grid, 0.42);
  }

  const ordered = [...panel.series].sort((left, right) => {
    const rank = (style: string) => style === "area" || style === "columns" ? 0 : 1;
    return rank(left.source.style) - rank(right.source.style);
  });
  const columnLayout = buildCompositeColumnLayout(panel);
  const columnWidthByFamily = new Map<string, number>();
  for (const [family, centers] of columnLayout.centersByFamily) {
    const maximumColumnWidth = maximumColumnClusterWidth(
      width,
      columnLayout.seriesCountByFamily.get(family) ?? 1,
    );
    columnWidthByFamily.set(
      family,
      columnWidthFromCenters(centers, width, maximumColumnWidth),
    );
  }
  const mixesColumnsWithOtherMarks = panel.series.some((series) => series.source.style === "columns")
    && panel.series.some((series) => series.source.style !== "columns");
  for (const series of ordered) {
    const domain = panel.axes[series.source.axis];
    if (!domain) continue;
    const color = parseHex(series.source.color);
    switch (series.source.style) {
      case "columns":
        drawColumns(
          data,
          width,
          height,
          series,
          domain,
          color,
          columnLayout,
          columnWidthByFamily,
          mixesColumnsWithOtherMarks ? 0.48 : 0.72,
        );
        break;
      case "area":
        drawConnectedSeries(data, width, height, series, domain, color, true);
        break;
      case "points":
        for (const point of series.points) {
          const projected = pixelPoint(point, width, height);
          drawCircle(data, width, height, projected.x, projected.y, 2.4, color);
        }
        break;
      case "candles":
      case "ohlc":
      case "hlc":
        drawOhlc(data, width, height, series, domain, color, negative);
        break;
      case "line":
      case "step":
        drawConnectedSeries(data, width, height, series, domain, color, false);
        break;
    }
  }

  return { width, height, pixels: data };
}
