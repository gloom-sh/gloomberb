import { displayWidth, padTo } from "../../../utils/format";
import { compositeAxisTicks, compositeGridRatios, type CompositeAxisValueFormatter } from "./format";
import { resolveCompositeObservationWidth } from "./rasterizer";
import { buildCompositeColumnLayout, type CompositeColumnLayout } from "./column-layout";
import { projectCompositeValue } from "./scene";
import { writeVolumeProfileText } from "./volume-profile-paint";
import { writeSessionBreaksText } from "./session-shading";
import type { SeriesLineCue } from "./series-cues";
import type {
  CompositeAxisDomain,
  CompositePanelScene,
  CompositeProjectedPoint,
  CompositeProjectedSeries,
} from "./types";
import { clamp } from "../../../utils/math";
import { clipSegmentToBand } from "./value-scale";

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

/**
 * The cell a point falls in. An axis scaled by hand can put it past the top or
 * bottom row, where `keepY` leaves it for the drawing to clip.
 */
function cellPoint(point: CompositeProjectedPoint, width: number, height: number, keepY = false): { x: number; y: number } {
  const y = Math.round(point.yRatio * Math.max(height - 1, 0));
  return {
    x: clamp(Math.round(point.xRatio * Math.max(width - 1, 0)), 0, Math.max(width - 1, 0)),
    y: keepY ? y : clamp(y, 0, Math.max(height - 1, 0)),
  };
}

function valueRow(value: number, domain: CompositeAxisDomain, height: number): number | null {
  const ratio = projectCompositeValue(value, domain);
  if (ratio === null) return null;
  const row = Math.round(ratio * Math.max(height - 1, 0));
  return domain.manual ? row : clamp(row, 0, Math.max(height - 1, 0));
}

/** A line between two cells, the part outside the rows (a hand-scaled axis) left off. */
function drawRowsLine(rows: string[][], x0: number, y0: number, x1: number, y1: number, mark: string): void {
  const last = rows.length - 1;
  if (y0 >= 0 && y0 <= last && y1 >= 0 && y1 <= last) {
    drawLine(rows, x0, y0, x1, y1, mark);
    return;
  }
  const clipped = clipSegmentToBand(x0, y0, x1, y1, -0.49, last + 0.49);
  if (!clipped) return;
  drawLine(rows, Math.round(clipped[0]), Math.round(clipped[1]), Math.round(clipped[2]), Math.round(clipped[3]), mark);
}

/** Rows from `from` to `to`, both ends kept to the rows there are. */
function rowSpan(from: number, to: number, height: number): [number, number] {
  return [Math.max(0, Math.min(from, to)), Math.min(height - 1, Math.max(from, to))];
}

function renderLineLike(
  rows: string[][],
  series: CompositeProjectedSeries,
  width: number,
  height: number,
  cue?: SeriesLineCue,
  keepY = false,
): void {
  const points = series.points.map((point) => ({ ...cellPoint(point, width, height, keepY), point }));
  if (points.length === 0) return;
  const step = series.source.style === "step" || series.source.interpolation === "step-after";
  // Beside other lines, each line keeps its own mark the whole way, steps
  // included, since cell text has no colour of its own here.
  const mark = cue && cue.id !== "solid" ? cue.glyph : null;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    if (current.point.breakBefore) continue;
    if (step) {
      drawRowsLine(rows, previous.x, previous.y, current.x, previous.y, mark ?? "─");
      drawRowsLine(rows, current.x, previous.y, current.x, current.y, mark ?? "│");
    } else {
      drawRowsLine(rows, previous.x, previous.y, current.x, current.y, mark ?? "•");
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
  keepY: boolean,
): void {
  for (const point of series.points) {
    const cell = cellPoint(point, width, height, keepY);
    setCell(rows, cell.x, cell.y, "●");
  }
}

function renderArea(
  rows: string[][],
  series: CompositeProjectedSeries,
  domain: CompositeAxisDomain,
  width: number,
  height: number,
  cue?: SeriesLineCue,
): void {
  const keepY = domain.manual === true;
  const baseline = valueRow(0, domain, height) ?? height - 1;
  const points = series.points.map((point) => cellPoint(point, width, height, keepY));
  for (const point of points) {
    const [top, bottom] = rowSpan(point.y, baseline, height);
    for (let row = top; row <= bottom; row += 1) setCell(rows, point.x, row, "░");
  }
  renderLineLike(rows, series, width, height, cue, keepY);
}

/** A band's range as shade between its points' low and high rows, under its line. */
function renderBand(
  rows: string[][],
  series: CompositeProjectedSeries,
  domain: CompositeAxisDomain,
  width: number,
  height: number,
  cue?: SeriesLineCue,
): void {
  const edges = series.points.map((projected) => {
    const { high, low } = projected.point;
    if (high == null || low == null) return null;
    const top = valueRow(high, domain, height);
    const bottom = valueRow(low, domain, height);
    return top === null || bottom === null
      ? null
      : { x: cellPoint(projected, width, height).x, top: Math.min(top, bottom), bottom: Math.max(top, bottom) };
  });
  const shade = (x: number, top: number, bottom: number) => {
    for (let row = Math.max(0, Math.round(top)); row <= Math.min(height - 1, Math.round(bottom)); row += 1) {
      const current = rows[row]?.[x];
      if (current === " " || current === "·") setCell(rows, x, row, "░");
    }
  };
  for (let index = 0; index < edges.length; index += 1) {
    const current = edges[index];
    if (!current) continue;
    const previous = index > 0 && !series.points[index]?.breakBefore ? edges[index - 1] : null;
    if (!previous) {
      shade(current.x, current.top, current.bottom);
      continue;
    }
    const span = Math.max(1, current.x - previous.x);
    for (let x = previous.x; x <= current.x; x += 1) {
      const t = (x - previous.x) / span;
      shade(x, previous.top + (current.top - previous.top) * t, previous.bottom + (current.bottom - previous.bottom) * t);
    }
  }
  renderLineLike(rows, series, width, height, cue, domain.manual === true);
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
    const cell = cellPoint(point, width, height, domain.manual);
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
    const [top, bottom] = rowSpan(cell.y, baseline, height);
    for (let row = top; row <= bottom; row += 1) setCell(rows, cell.x, row, "█");
  }
}

function renderOhlc(
  rows: string[][],
  series: CompositeProjectedSeries,
  domain: CompositeAxisDomain,
  width: number,
  height: number,
): void {
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
    drawRowsLine(rows, x, highRow, x, lowRow, "│");
    if (series.source.style === "candles" && openRow !== null) {
      const [bodyTop, bodyBottom] = rowSpan(openRow, closeRow, height);
      for (let row = bodyTop; row <= bodyBottom; row += 1) {
        for (let offset = -halfCandleWidth; offset <= halfCandleWidth; offset += 1) {
          setCell(rows, x + offset, row, "█");
        }
      }
      continue;
    }
    const tickWidth = Math.max(1, halfCandleWidth);
    if (series.source.style === "ohlc" && openRow !== null) {
      drawLine(rows, Math.max(0, x - tickWidth), openRow, x, openRow, "─");
    }
    drawLine(rows, x, closeRow, Math.min(width - 1, x + tickWidth), closeRow, "─");
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
  // The web terminal sizes panes from the viewport in fractional cells, and
  // Array() throws on a fractional length.
  const height = Math.max(1, Math.floor(panel.height));
  const plotWidth = Math.max(1, Math.floor(width));
  const rows = Array.from({ length: height }, () => Array(plotWidth).fill(" "));
  for (const ratio of compositeGridRatios(panel)) {
    const row = Math.round((height - 1) * ratio);
    for (let x = 0; x < plotWidth; x += 3) setCell(rows, x, row, "·");
  }

  const columnLayout = buildCompositeColumnLayout(panel);
  const orderedSeries = [...panel.series].sort((left, right) => {
    const layerRank = (style: string) => style === "area" || style === "columns" || style === "band" ? 0 : 1;
    return layerRank(left.source.style) - layerRank(right.source.style);
  });
  for (const series of orderedSeries) {
    const domain = panel.axes[series.source.axis];
    if (!domain) continue;
    const cue = panel.lineCues?.get(series.source.id);
    switch (series.source.style) {
      case "columns":
        renderColumns(rows, series, domain, plotWidth, height, columnLayout);
        break;
      case "area":
        renderArea(rows, series, domain, plotWidth, height, cue);
        break;
      case "band":
        renderBand(rows, series, domain, plotWidth, height, cue);
        break;
      case "candles":
      case "ohlc":
      case "hlc":
        renderOhlc(rows, series, domain, plotWidth, height);
        break;
      case "line":
      case "step":
        renderLineLike(rows, series, plotWidth, height, cue, domain.manual === true);
        break;
      case "points":
        renderPoints(rows, series, plotWidth, height, domain.manual === true);
        break;
    }
  }

  if (panel.volumeProfile) writeVolumeProfileText(rows, plotWidth, panel.volumeProfile);
  if (panel.extendedHours) writeSessionBreaksText(rows, plotWidth, panel.extendedHours);

  // Blank cells only, so the dashed level reads as if it ran under the marks.
  if (panel.lastPrice) {
    const row = clamp(
      Math.round(panel.lastPrice.yRatio * Math.max(height - 1, 0)),
      0,
      Math.max(height - 1, 0),
    );
    for (let x = 0; x < plotWidth; x += 1) {
      const current = rows[row]?.[x];
      if (current === " " || current === "·") setCell(rows, x, row, "╌");
    }
  }
  // The previous close, dotted, where the last price has not taken the row.
  if (panel.priorClose) {
    const row = clamp(Math.round(panel.priorClose.yRatio * Math.max(height - 1, 0)), 0, Math.max(height - 1, 0));
    for (let x = 0; x < plotWidth; x += 1) {
      const current = rows[row]?.[x];
      if (current === " " || current === "·") setCell(rows, x, row, "┈");
    }
  }

  if (cursorXRatio !== null) {
    const cursorX = clamp(Math.round(cursorXRatio * Math.max(plotWidth - 1, 0)), 0, Math.max(plotWidth - 1, 0));
    for (let y = 0; y < height; y += 1) {
      const current = rows[y]?.[cursorX];
      setCell(rows, cursorX, y, current === " " || current === "·" ? "│" : "┼");
    }
  }
  if (cursorYRatio !== null) {
    const cursorY = clamp(Math.round(cursorYRatio * Math.max(height - 1, 0)), 0, Math.max(height - 1, 0));
    for (let x = 0; x < plotWidth; x += 1) {
      const current = rows[cursorY]?.[x];
      setCell(rows, x, cursorY, current === " " || current === "·" ? "─" : "┼");
    }
  }

  return rows.map((row) => row.join(""));
}

/** Axis ticks as they fit a gutter of `width` cells. */
export function compositeAxisTickLabels(
  domain: CompositeAxisDomain | undefined,
  width: number,
  format?: CompositeAxisValueFormatter,
): Array<{ ratio: number; label: string }> {
  if (!domain || width <= 0) return [];
  // Never pass a clipped number to the axis renderer: its later overflow
  // guard cannot distinguish that prefix from a complete formatted value.
  return compositeAxisTicks(domain, format).map(({ ratio, label }) => ({
    ratio,
    label: displayWidth(label) > width ? "…" : label,
  }));
}

export function renderCompositeAxisText(
  domain: CompositeAxisDomain | undefined,
  height: number,
  width: number,
  side: "left" | "right",
  format?: CompositeAxisValueFormatter,
): string[] {
  const rows = Array.from({ length: Math.max(1, height) }, () => " ".repeat(Math.max(0, width)));
  for (const { ratio, label } of compositeAxisTickLabels(domain, width, format)) {
    const row = clamp(Math.round(ratio * Math.max(height - 1, 0)), 0, Math.max(height - 1, 0));
    rows[row] = padTo(label, width, side === "left" ? "right" : "left");
  }
  return rows;
}
