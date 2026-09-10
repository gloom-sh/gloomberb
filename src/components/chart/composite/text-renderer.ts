import { getCurrentStyle, glyphs } from "../../../theme/colors";
import type { GlyphSet } from "../../../theme/glyphs";
import { compositeAxisTicks, type CompositeAxisValueFormatter } from "./format";
import type { CompositeViewportRange } from "./interactions";
import { resolveCompositeObservationWidth } from "./rasterizer";
import { buildCompositeColumnLayout, type CompositeColumnLayout } from "./column-layout";
import { projectCompositeValue } from "./scene";
import {
  buildCompositeTimeAxisLayout,
  buildCompositeViewportTimeAxisLayout,
} from "./time-axis";
import type {
  CompositeAxisDomain,
  CompositeChartScene,
  CompositePanelScene,
  CompositeProjectedPoint,
  CompositeProjectedSeries,
} from "./types";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function setCell(rows: string[][], x: number, y: number, value: string): void {
  const row = rows[y];
  if (!row || x < 0 || x >= row.length) return;
  row[x] = value;
}

function drawLine(rows: string[][], x0: number, y0: number, x1: number, y1: number, mark: string): void {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  while (true) {
    setCell(rows, x, y, mark);
    if (x === x1 && y === y1) break;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y += sy;
    }
  }
}

function cellPoint(point: CompositeProjectedPoint, width: number, height: number): { x: number; y: number } {
  return {
    x: clamp(Math.round(point.xRatio * Math.max(width - 1, 0)), 0, Math.max(width - 1, 0)),
    y: clamp(Math.round(point.yRatio * Math.max(height - 1, 0)), 0, Math.max(height - 1, 0)),
  };
}

function valueRow(value: number, domain: CompositeAxisDomain, height: number): number | null {
  const ratio = projectCompositeValue(value, domain);
  return ratio === null ? null : clamp(Math.round(ratio * Math.max(height - 1, 0)), 0, Math.max(height - 1, 0));
}

function renderLineLike(
  rows: string[][],
  series: CompositeProjectedSeries,
  width: number,
  height: number,
): void {
  const points = series.points.map((point) => ({ ...cellPoint(point, width, height), point }));
  if (points.length === 0) return;
  const step = series.source.style === "step" || series.source.interpolation === "step-after";
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    if (current.point.breakBefore) continue;
    if (step) {
      drawLine(rows, previous.x, previous.y, current.x, previous.y, "─");
      drawLine(rows, current.x, previous.y, current.x, current.y, "│");
    } else {
      drawLine(rows, previous.x, previous.y, current.x, current.y, "•");
    }
  }
  for (let index = 0; index < points.length; index += 1) {
    const connectedToPrevious = index > 0 && points[index]!.point.breakBefore === false;
    const connectedToNext = index + 1 < points.length && points[index + 1]!.point.breakBefore === false;
    if (!connectedToPrevious && !connectedToNext) {
      const point = points[index]!;
      setCell(rows, point.x, point.y, "◆");
    }
  }
}

function renderPoints(
  rows: string[][],
  series: CompositeProjectedSeries,
  width: number,
  height: number,
): void {
  for (const point of series.points) {
    const cell = cellPoint(point, width, height);
    setCell(rows, cell.x, cell.y, "●");
  }
}

function renderArea(
  rows: string[][],
  series: CompositeProjectedSeries,
  domain: CompositeAxisDomain,
  width: number,
  height: number,
): void {
  const baseline = valueRow(0, domain, height) ?? height - 1;
  const points = series.points.map((point) => cellPoint(point, width, height));
  for (const point of points) {
    const top = Math.min(point.y, baseline);
    const bottom = Math.max(point.y, baseline);
    for (let row = top; row <= bottom; row += 1) setCell(rows, point.x, row, "░");
  }
  renderLineLike(rows, series, width, height);
}

function renderColumns(
  rows: string[][],
  series: CompositeProjectedSeries,
  domain: CompositeAxisDomain,
  width: number,
  height: number,
  layout: CompositeColumnLayout,
): void {
  const baseline = valueRow(0, domain, height) ?? height - 1;
  for (const point of series.points) {
    const cell = cellPoint(point, width, height);
    const group = layout.groupByPoint.get(point) ?? {
      index: 0,
      count: 1,
      xRatio: point.xRatio,
      familyKey: "",
    };
    cell.x = clamp(
      Math.round(group.xRatio * Math.max(width - 1, 0)),
      0,
      Math.max(width - 1, 0),
    );
    if (group.count > 1) {
      const groupWidth = Math.min(group.count, width);
      const groupStart = clamp(
        Math.round(cell.x - (groupWidth - 1) / 2),
        0,
        Math.max(width - groupWidth, 0),
      );
      const slot = groupWidth === 1
        ? 0
        : Math.round(group.index * (groupWidth - 1) / (group.count - 1));
      cell.x = groupStart + slot;
    }
    const top = Math.min(cell.y, baseline);
    const bottom = Math.max(cell.y, baseline);
    for (let row = top; row <= bottom; row += 1) setCell(rows, cell.x, row, "█");
  }
}

/** Box-drawing edge for a hollow candle, so the outline joins at the corners. */
function hollowBodyChar(
  row: number,
  top: number,
  bottom: number,
  offset: number,
  half: number,
  set: GlyphSet,
): string {
  const onTop = row === top;
  const onBottom = row === bottom;
  const onLeft = offset === -half;
  const onRight = offset === half;
  if (onTop && onLeft) return set.border.topLeft;
  if (onTop && onRight) return set.border.topRight;
  if (onBottom && onLeft) return set.border.bottomLeft;
  if (onBottom && onRight) return set.border.bottomRight;
  if (onTop || onBottom) return set.border.horizontal;
  return set.border.vertical;
}

/** True for a cell that carries nothing but the grid, so an overlay may claim it. */
function isBackdropCell(current: string | undefined, gridChar: string): boolean {
  return current === " " || current === gridChar || current === undefined;
}

function renderOhlc(
  rows: string[][],
  series: CompositeProjectedSeries,
  domain: CompositeAxisDomain,
  width: number,
  height: number,
): void {
  const candles = getCurrentStyle().charts.candles;
  const candleWidth = resolveCompositeTextOhlcWidth(series.points, width);
  const halfCandleWidth = Math.floor(candleWidth / 2);
  for (const projected of series.points) {
    const source = projected.point;
    const x = cellPoint(projected, width, height).x;
    const close = source.close ?? projected.value;
    const open = source.open ?? close;
    const high = source.high ?? Math.max(open, close);
    const low = source.low ?? Math.min(open, close);
    const openRow = valueRow(open, domain, height);
    const closeRow = valueRow(close, domain, height);
    const highRow = valueRow(high, domain, height);
    const lowRow = valueRow(low, domain, height);
    if (closeRow === null || highRow === null || lowRow === null) continue;
    drawLine(rows, x, highRow, x, lowRow, glyphs.border.vertical);
    if (series.source.style === "candles" && openRow !== null && candles !== "ohlc") {
      const bodyTop = Math.min(openRow, closeRow);
      const bodyBottom = Math.max(openRow, closeRow);
      for (let row = bodyTop; row <= bodyBottom; row += 1) {
        for (let offset = -halfCandleWidth; offset <= halfCandleWidth; offset += 1) {
          // A hollow body keeps its outline and lets the plot through, which is
          // how a lighter style reads a candle without a block of ink.
          const onEdge = row === bodyTop || row === bodyBottom
            || offset === -halfCandleWidth || offset === halfCandleWidth;
          if (candles === "hollow" && !onEdge) continue;
          setCell(rows, x + offset, row, candles === "hollow" ? hollowBodyChar(row, bodyTop, bodyBottom, offset, halfCandleWidth, glyphs) : glyphs.bar.full);
        }
      }
      continue;
    }
    const tickWidth = Math.max(1, halfCandleWidth);
    if (openRow !== null && (series.source.style === "ohlc" || candles === "ohlc")) {
      drawLine(rows, Math.max(0, x - tickWidth), openRow, x, openRow, glyphs.border.horizontal);
    }
    drawLine(rows, x, closeRow, Math.min(width - 1, x + tickWidth), closeRow, glyphs.border.horizontal);
  }
}

export function resolveCompositeTextOhlcWidth(
  points: CompositeProjectedPoint[],
  width: number,
): number {
  const maximum = clamp(Math.floor(width / 16), 3, 7);
  const resolved = Math.max(
    1,
    Math.floor(resolveCompositeObservationWidth(points, width, 1, maximum)),
  );
  return resolved % 2 === 0 ? Math.max(1, resolved - 1) : resolved;
}

export function renderCompositePanelText(
  panel: CompositePanelScene,
  width: number,
  cursorXRatio: number | null,
  cursorYRatio: number | null,
): string[] {
  const height = Math.max(1, panel.height);
  const plotWidth = Math.max(1, width);
  const rows = Array.from({ length: height }, () => Array(plotWidth).fill(" "));
  const grid = getCurrentStyle().charts.grid;
  const gridChar = grid === "lines" ? glyphs.border.horizontal : glyphs.dot;
  const gridStep = grid === "lines" ? 1 : 3;
  if (grid !== "none") {
    for (let index = 1; index <= 3; index += 1) {
      const row = Math.round((height - 1) * (index / 4));
      for (let x = 0; x < plotWidth; x += gridStep) setCell(rows, x, row, gridChar);
    }
  }

  const columnLayout = buildCompositeColumnLayout(panel);
  const orderedSeries = [...panel.series].sort((left, right) => {
    const layerRank = (style: string) => style === "area" || style === "columns" ? 0 : 1;
    return layerRank(left.source.style) - layerRank(right.source.style);
  });
  for (const series of orderedSeries) {
    const domain = panel.axes[series.source.axis];
    if (!domain) continue;
    switch (series.source.style) {
      case "columns":
        renderColumns(rows, series, domain, plotWidth, height, columnLayout);
        break;
      case "area":
        renderArea(rows, series, domain, plotWidth, height);
        break;
      case "candles":
      case "ohlc":
      case "hlc":
        renderOhlc(rows, series, domain, plotWidth, height);
        break;
      case "line":
      case "step":
        renderLineLike(rows, series, plotWidth, height);
        break;
      case "points":
        renderPoints(rows, series, plotWidth, height);
        break;
    }
  }

  // Blank cells only, so the dashed level reads as if it ran under the marks.
  if (panel.lastPrice) {
    const row = clamp(
      Math.round(panel.lastPrice.yRatio * Math.max(height - 1, 0)),
      0,
      Math.max(height - 1, 0),
    );
    for (let x = 0; x < plotWidth; x += 1) {
      const current = rows[row]?.[x];
      if (isBackdropCell(current, gridChar)) setCell(rows, x, row, "╌");
    }
  }

  if (cursorXRatio !== null) {
    const cursorX = clamp(Math.round(cursorXRatio * Math.max(plotWidth - 1, 0)), 0, Math.max(plotWidth - 1, 0));
    for (let y = 0; y < height; y += 1) {
      const current = rows[y]?.[cursorX];
      setCell(rows, cursorX, y, isBackdropCell(current, gridChar) ? glyphs.border.vertical : glyphs.border.cross);
    }
  }
  if (cursorYRatio !== null) {
    const cursorY = clamp(Math.round(cursorYRatio * Math.max(height - 1, 0)), 0, Math.max(height - 1, 0));
    for (let x = 0; x < plotWidth; x += 1) {
      const current = rows[cursorY]?.[x];
      setCell(rows, x, cursorY, isBackdropCell(current, gridChar) ? glyphs.border.horizontal : glyphs.border.cross);
    }
  }

  return rows.map((row) => row.join(""));
}

export function renderCompositeAxisText(
  domain: CompositeAxisDomain | undefined,
  height: number,
  width: number,
  side: "left" | "right",
  format?: CompositeAxisValueFormatter,
): string[] {
  const rows = Array.from({ length: Math.max(1, height) }, () => " ".repeat(Math.max(0, width)));
  if (!domain || width <= 0) return rows;
  for (const tick of compositeAxisTicks(domain, 3, format)) {
    const row = clamp(Math.round(tick.ratio * Math.max(height - 1, 0)), 0, Math.max(height - 1, 0));
    const label = tick.label.length > width ? tick.label.slice(0, width) : tick.label;
    rows[row] = side === "left" ? label.padStart(width) : label.padEnd(width);
  }
  return rows;
}

export function renderCompositeViewportTimeAxis(
  viewport: CompositeViewportRange,
  width: number,
): string {
  return buildCompositeViewportTimeAxisLayout(viewport, width).text;
}

export function renderCompositeTimeAxis(scene: CompositeChartScene, width: number): string {
  return buildCompositeTimeAxisLayout(scene, width).text;
}
