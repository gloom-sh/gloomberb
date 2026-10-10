import type { NativeChartBitmap } from "../native/chart-rasterizer";
import {
  blendPixel,
  drawCircle,
  drawLine,
  fillOpaque,
  fillRect,
  parseHex,
  type RgbaColor,
} from "../native/raster/primitives";
import {
  buildCompositeColumnLayout,
  type CompositeColumnGroupCenter,
  type CompositeColumnLayout,
} from "./column-layout";
import { compositeGridRatios } from "./format";
import { projectCompositeValue } from "./scene";
import { paintVolumeProfile } from "./volume-profile-paint";
import { paintExtendedHours } from "./session-shading";
import type { SeriesLineCue } from "./series-cues";
import type {
  CompositeAxisDomain,
  CompositeChartColors,
  CompositePanelScene,
  CompositeProjectedPoint,
  CompositeProjectedSeries,
} from "./types";
import { clamp } from "../../../utils/math";

interface RenderCompositePanelBitmapOptions {
  pixelWidth: number;
  pixelHeight: number;
  colors: CompositeChartColors;
  /** Terminal cells hold one axis label per row: centre each gridline on the
   * row its label snaps to. */
  snapGridToRows?: boolean;
}

/** Dash geometry of the last price level, in bitmap pixels. */
const LAST_PRICE_DASH_PIXELS = 6;
const LAST_PRICE_GAP_PIXELS = 5;
const LAST_PRICE_OPACITY = 0.9;
const PRIOR_CLOSE_DOT_PIXELS = 2;
const PRIOR_CLOSE_GAP_PIXELS = 3;
const PRIOR_CLOSE_OPACITY = 0.7;

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

const AREA_FILL_MAX_OPACITY = 0.3;
const AREA_FILL_MIN_OPACITY = 0.02;

/**
 * The area under a line, filled once per pixel column with a vertical
 * gradient: strongest at the series' furthest point from the baseline, fading
 * to almost nothing at the baseline. Filling per segment instead stacked
 * alpha wherever neighbouring segments shared a column, which on dense
 * series (years of daily closes in a few hundred pixels) read as a barcode.
 */
function fillAreaGradient(
  data: Uint8Array,
  width: number,
  height: number,
  series: CompositeProjectedSeries,
  points: readonly { x: number; y: number }[],
  baseline: number,
  step: boolean,
  color: RgbaColor,
): void {
  // Per column, the line's furthest point from the baseline, on either side.
  const above = new Float64Array(width).fill(Number.NaN);
  const below = new Float64Array(width).fill(Number.NaN);
  for (let index = 1; index < points.length; index += 1) {
    if (series.points[index]?.breakBefore) continue;
    const previous = points[index - 1]!;
    const current = points[index]!;
    const from = previous.x <= current.x ? previous : current;
    const to = previous.x <= current.x ? current : previous;
    const start = Math.round(from.x);
    const span = Math.round(to.x) - start;
    for (let x = Math.max(0, start); x <= Math.min(width - 1, start + span); x += 1) {
      const y = step ? previous.y : span === 0 ? to.y : from.y + (to.y - from.y) * ((x - start) / span);
      if (y <= baseline) above[x] = Number.isNaN(above[x]!) ? y : Math.min(above[x]!, y);
      if (y >= baseline) below[x] = Number.isNaN(below[x]!) ? y : Math.max(below[x]!, y);
    }
  }

  const floor = Math.min(Math.max(baseline, 0), height - 1);
  let peakAbove = floor;
  let peakBelow = floor;
  for (let x = 0; x < width; x += 1) {
    if (!Number.isNaN(above[x]!)) peakAbove = Math.min(peakAbove, above[x]!);
    if (!Number.isNaN(below[x]!)) peakBelow = Math.max(peakBelow, below[x]!);
  }
  const reachAbove = Math.max(1, floor - Math.max(0, peakAbove));
  const reachBelow = Math.max(1, Math.min(height - 1, peakBelow) - floor);

  for (let x = 0; x < width; x += 1) {
    const top = above[x]!;
    if (!Number.isNaN(top)) {
      for (let y = Math.max(0, Math.ceil(top)); y <= floor; y += 1) {
        const strength = (floor - y) / reachAbove;
        blendPixel(data, width, height, x, y, color, AREA_FILL_MIN_OPACITY + (AREA_FILL_MAX_OPACITY - AREA_FILL_MIN_OPACITY) * strength);
      }
    }
    const bottom = below[x]!;
    if (!Number.isNaN(bottom)) {
      for (let y = floor + 1; y <= Math.min(height - 1, Math.floor(bottom)); y += 1) {
        const strength = (y - floor) / reachBelow;
        blendPixel(data, width, height, x, y, color, AREA_FILL_MIN_OPACITY + (AREA_FILL_MAX_OPACITY - AREA_FILL_MIN_OPACITY) * strength);
      }
    }
  }
}

const BAND_FILL_OPACITY = 0.2;

/**
 * The range a band series spans, one flat fill per pixel column between its
 * points' `low` and `high`, read straight across between neighbouring points.
 */
function fillBand(
  data: Uint8Array,
  width: number,
  height: number,
  series: CompositeProjectedSeries,
  domain: CompositeAxisDomain,
  color: RgbaColor,
): void {
  const edges = series.points.map((projected) => {
    const { high, low } = projected.point;
    const x = pixelPoint(projected, width, height).x;
    if (high == null || low == null || !Number.isFinite(high) || !Number.isFinite(low)) return null;
    const top = pixelY(high, domain, height);
    const bottom = pixelY(low, domain, height);
    return top === null || bottom === null ? null : { x, top: Math.min(top, bottom), bottom: Math.max(top, bottom) };
  });
  const filled = new Uint8Array(width);
  const fillColumn = (x: number, top: number, bottom: number) => {
    if (x < 0 || x >= width || filled[x]) return;
    filled[x] = 1;
    for (let y = Math.max(0, Math.round(top)); y <= Math.min(height - 1, Math.round(bottom)); y += 1) {
      blendPixel(data, width, height, x, y, color, BAND_FILL_OPACITY);
    }
  };
  for (let index = 0; index < edges.length; index += 1) {
    const current = edges[index];
    if (!current) continue;
    const previous = index > 0 && !series.points[index]?.breakBefore ? edges[index - 1] : null;
    if (!previous) {
      fillColumn(Math.round(current.x), current.top, current.bottom);
      continue;
    }
    const start = Math.round(previous.x);
    const span = Math.max(1, Math.round(current.x) - start);
    for (let x = start; x <= start + span; x += 1) {
      const t = (x - start) / span;
      fillColumn(x, previous.top + (current.top - previous.top) * t, previous.bottom + (current.bottom - previous.bottom) * t);
    }
  }
}

/**
 * Strokes a line's segments with a dash pattern that runs on along the whole
 * line, so a dense series with segments shorter than one dash still shows the
 * pattern rather than restarting it at every point.
 */
class DashedStroke {
  private index = 0;
  private remaining: number;

  constructor(
    private readonly data: Uint8Array,
    private readonly width: number,
    private readonly height: number,
    private readonly color: RgbaColor,
    private readonly cue: SeriesLineCue,
  ) {
    this.remaining = cue.dash[0] ?? 0;
  }

  segment(x0: number, y0: number, x1: number, y1: number): void {
    const { dash, thickness } = this.cue;
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (dash.length === 0 || length === 0) {
      drawLine(this.data, this.width, this.height, x0, y0, x1, y1, this.color, thickness);
      return;
    }
    let travelled = 0;
    while (travelled < length) {
      const run = Math.min(this.remaining, length - travelled);
      if (this.index % 2 === 0) {
        const from = travelled / length;
        const to = (travelled + run) / length;
        drawLine(
          this.data, this.width, this.height,
          x0 + (x1 - x0) * from, y0 + (y1 - y0) * from,
          x0 + (x1 - x0) * to, y0 + (y1 - y0) * to,
          this.color, thickness,
        );
      }
      travelled += run;
      this.remaining -= run;
      if (this.remaining <= 0) {
        this.index = (this.index + 1) % dash.length;
        this.remaining = dash[this.index]!;
      }
    }
  }
}

function drawConnectedSeries(
  data: Uint8Array,
  width: number,
  height: number,
  series: CompositeProjectedSeries,
  domain: CompositeAxisDomain,
  color: RgbaColor,
  area: boolean,
  cue?: SeriesLineCue,
): void {
  const points = series.points.map((point) => pixelPoint(point, width, height));
  if (points.length === 0) return;
  const baseline = pixelY(0, domain, height) ?? height - 1;
  const step = series.source.style === "step" || series.source.interpolation === "step-after";

  if (area) fillAreaGradient(data, width, height, series, points, baseline, step, color);

  const stroke = cue ? new DashedStroke(data, width, height, color, cue) : null;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    if (series.points[index]?.breakBefore) continue;
    if (stroke) {
      if (step) {
        stroke.segment(previous.x, previous.y, current.x, previous.y);
        stroke.segment(current.x, previous.y, current.x, current.y);
      } else {
        stroke.segment(previous.x, previous.y, current.x, current.y);
      }
    } else if (step) {
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
  negativeColor: RgbaColor,
  layout: CompositeColumnLayout,
  widthByFamily: ReadonlyMap<string, number>,
  opacity: number,
): void {
  const baseline = pixelY(0, domain, height) ?? height - 1;
  for (const projected of series.points) {
    const fill = projected.value < 0 ? negativeColor : color;
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
      fill,
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
    const halfWidth = Math.min(candleWidth / 2, Math.max(width - 1, 0) / 2);
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

function drawDashedLevel(
  data: Uint8Array,
  width: number,
  height: number,
  yRatio: number,
  color: RgbaColor,
  dash = LAST_PRICE_DASH_PIXELS,
  gap = LAST_PRICE_GAP_PIXELS,
  opacity = LAST_PRICE_OPACITY,
): void {
  const y = Math.round(clamp(yRatio * Math.max(height - 1, 0), 0, Math.max(height - 1, 0)));
  for (let x = 0; x < width; x += dash + gap) {
    fillRect(data, width, height, x, y, Math.min(x + dash - 1, width - 1), y, color, opacity);
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
  fillOpaque(data, background);
  if (panel.extendedHours) paintExtendedHours(data, width, height, panel.extendedHours, options.colors.textDim);

  const rows = Math.max(1, panel.height);
  for (const ratio of compositeGridRatios(panel)) {
    const y = options.snapGridToRows
      ? (Math.round(ratio * (rows - 1)) + 0.5) / rows * height
      : (height - 1) * ratio;
    fillRect(data, width, height, 0, y, width - 1, y + 0.6, grid, 0.42);
  }
  if (panel.volumeProfile) paintVolumeProfile(data, width, height, panel.volumeProfile);
  // Under the bars, which read across it.
  if (panel.priorClose) {
    drawDashedLevel(data, width, height, panel.priorClose.yRatio, parseHex(options.colors.textDim),
      PRIOR_CLOSE_DOT_PIXELS, PRIOR_CLOSE_GAP_PIXELS, PRIOR_CLOSE_OPACITY);
  }

  const ordered = [...panel.series].sort((left, right) => {
    const rank = (style: string) => style === "area" || style === "columns" || style === "band" ? 0 : 1;
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
    const negativeColor = series.source.negativeColor ? parseHex(series.source.negativeColor) : color;
    const cue = panel.lineCues?.get(series.source.id);
    switch (series.source.style) {
      case "columns":
        drawColumns(
          data,
          width,
          height,
          series,
          domain,
          color,
          negativeColor,
          columnLayout,
          columnWidthByFamily,
          mixesColumnsWithOtherMarks ? 0.48 : 0.72,
        );
        break;
      case "area":
        drawConnectedSeries(data, width, height, series, domain, color, true, cue);
        break;
      case "band":
        fillBand(data, width, height, series, domain, color);
        drawConnectedSeries(data, width, height, series, domain, color, false, cue);
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
        drawConnectedSeries(data, width, height, series, domain, color, false, cue);
        break;
    }
  }

  if (panel.lastPrice) {
    drawDashedLevel(data, width, height, panel.lastPrice.yRatio, parseHex(panel.lastPrice.color));
  }

  return { width, height, pixels: data };
}
