import { useMemo } from "react";
import { Box, ChartSurface, Span, Text, TextAttributes, useNativeRenderer, useUiCapabilities } from "../../ui";
import type { NativeChartBitmap } from "../chart/native/chart-rasterizer";
import { resolveNativeBitmapSize, shouldRenderNativeBitmap } from "../chart/native/bitmap-support";
import { drawCircle, drawLine, parseHex } from "../chart/native/raster/primitives";
import { useThemeColors } from "../../theme/theme-context";
import type { ThemeColors } from "../../theme/colors";
import {
  compactSegmentLabel,
  formatGaugeValue,
  normalizeValue,
  segmentColorForScore,
  valueToAngle,
  type SpeedometerGaugeProps,
  type SpeedometerSegment,
} from "./model";

interface GaugeCell {
  char: string;
  color?: string;
}

interface GaugeChunk {
  text: string;
  color?: string;
}

function blankGaugeLine(width: number): GaugeCell[] {
  return Array.from({ length: width }, () => ({ char: " " }));
}

function placeText(cells: GaugeCell[], label: string, center: number, color?: string): void {
  const width = cells.length;
  if (width <= 0) return;
  const text = label.length > width ? label.slice(0, width) : label;
  const start = Math.max(0, Math.min(width - text.length, Math.round(center - text.length / 2)));
  for (let index = 0; index < text.length; index += 1) {
    cells[start + index] = { char: text[index]!, color };
  }
}

function cellsToChunks(cells: GaugeCell[]): GaugeChunk[] {
  const chunks: GaugeChunk[] = [];
  for (const cell of cells) {
    const last = chunks[chunks.length - 1];
    if (last && last.color === cell.color) {
      last.text += cell.char;
    } else {
      chunks.push({ text: cell.char, color: cell.color });
    }
  }
  return chunks;
}

function labelForSegment(segment: SpeedometerSegment, gaugeWidth: number): string {
  if (gaugeWidth >= 64) return segment.label;
  const compact = compactSegmentLabel(segment);
  if (gaugeWidth >= 44) {
    return compact === "NEUTRAL" ? "NEUT" : compact;
  }
  if (compact === "EXT FEAR") return "XF";
  if (compact === "EXT GREED") return "XG";
  if (compact === "NEUTRAL") return "NEUT";
  return compact;
}

function renderLabelRow(width: number, segments: SpeedometerSegment[]): GaugeChunk[] {
  const cells = blankGaugeLine(width);
  const lastIndex = Math.max(segments.length - 1, 0);
  segments.forEach((segment, index) => {
    const center = lastIndex === 0
      ? (width - 1) / 2
      : (index / lastIndex) * (width - 1);
    placeText(cells, labelForSegment(segment, width), center, segment.color);
  });
  return cellsToChunks(cells);
}

function renderTickRow(width: number, min: number, max: number, colors: Pick<ThemeColors, "textDim">): GaugeChunk[] {
  const cells = blankGaugeLine(width);
  for (const tick of [min, min + (max - min) * 0.25, min + (max - min) * 0.5, min + (max - min) * 0.75, max]) {
    placeText(cells, formatGaugeValue(tick), normalizeValue(tick, min, max) * (width - 1), colors.textDim);
  }
  return cellsToChunks(cells);
}

function renderArcRows(
  value: number,
  min: number,
  max: number,
  width: number,
  segments: SpeedometerSegment[],
  colors: Pick<ThemeColors, "textDim" | "textBright">,
): GaugeChunk[][] {
  const dialHeight = 7;
  const dial = Array.from({ length: dialHeight }, () => blankGaugeLine(width));
  const centerX = Math.floor((width - 1) / 2);
  const centerY = dialHeight - 1;
  const radiusX = Math.max(8, (width - 4) / 2);
  const radiusY = dialHeight - 1;

  for (let step = 0; step <= 220; step += 1) {
    const normalized = step / 220;
    const score = min + normalized * (max - min);
    const angle = Math.PI - normalized * Math.PI;
    const x = Math.round(centerX + Math.cos(angle) * radiusX);
    const y = Math.round(centerY - Math.sin(angle) * radiusY);
    if (dial[y]?.[x]) {
      dial[y]![x] = { char: "●", color: segmentColorForScore(score, segments) };
    }
  }

  for (const tick of [min, min + (max - min) * 0.25, min + (max - min) * 0.5, min + (max - min) * 0.75, max]) {
    const angle = valueToAngle(tick, min, max);
    const x = Math.round(centerX + Math.cos(angle) * radiusX);
    const y = Math.round(centerY - Math.sin(angle) * radiusY);
    if (dial[y]?.[x]) {
      dial[y]![x] = { char: "│", color: colors.textDim };
    }
  }

  const pointerAngle = valueToAngle(value, min, max);
  const pointerChar = Math.abs(Math.cos(pointerAngle)) < 0.22
    ? "│"
    : Math.cos(pointerAngle) > 0
      ? "/"
      : "\\";
  for (let t = 0.14; t <= 0.75; t += 0.06) {
    const x = Math.round(centerX + Math.cos(pointerAngle) * radiusX * t);
    const y = Math.round(centerY - Math.sin(pointerAngle) * radiusY * t);
    if (dial[y]?.[x]) {
      dial[y]![x] = { char: pointerChar, color: colors.textBright };
    }
  }

  placeText(dial[centerY]!, formatGaugeValue(value), centerX, colors.textBright);
  return dial.map(cellsToChunks);
}

function GaugeLine({ chunks }: { chunks: GaugeChunk[] }) {
  return (
    <Text>
      {chunks.map((chunk, index) => (
        <Span key={`${index}-${chunk.text}`} fg={chunk.color}>{chunk.text}</Span>
      ))}
    </Text>
  );
}

function renderGaugeBitmap(
  value: number,
  min: number,
  max: number,
  segments: SpeedometerSegment[],
  pixelWidth: number,
  pixelHeight: number,
  colors: Pick<ThemeColors, "textDim" | "textBright">,
): NativeChartBitmap {
  const pixels = new Uint8Array(pixelWidth * pixelHeight * 4);
  const centerX = pixelWidth / 2;
  const centerY = pixelHeight * 0.84;
  const radius = Math.min(pixelWidth * 0.42, pixelHeight * 0.72);
  const arcThickness = Math.max(4, Math.min(pixelWidth, pixelHeight) * 0.038);

  for (const segment of segments) {
    const start = valueToAngle(segment.from, min, max);
    const end = valueToAngle(segment.to, min, max);
    const steps = Math.max(8, Math.ceil(Math.abs(end - start) * radius * 0.36));
    const color = parseHex(segment.color, 0.9);
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      const angle = start + (end - start) * t;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY - Math.sin(angle) * radius;
      drawCircle(pixels, pixelWidth, pixelHeight, x, y, arcThickness, color);
    }
  }

  for (const tick of [min, min + (max - min) * 0.25, min + (max - min) * 0.5, min + (max - min) * 0.75, max]) {
    const angle = valueToAngle(tick, min, max);
    const innerX = centerX + Math.cos(angle) * (radius - arcThickness * 1.45);
    const innerY = centerY - Math.sin(angle) * (radius - arcThickness * 1.45);
    const outerX = centerX + Math.cos(angle) * (radius + arcThickness * 1.25);
    const outerY = centerY - Math.sin(angle) * (radius + arcThickness * 1.25);
    drawLine(pixels, pixelWidth, pixelHeight, innerX, innerY, outerX, outerY, parseHex(colors.textDim, 0.8), Math.max(1, arcThickness * 0.22));
  }

  const angle = valueToAngle(value, min, max);
  const needleEndX = centerX + Math.cos(angle) * (radius * 0.76);
  const needleEndY = centerY - Math.sin(angle) * (radius * 0.76);
  drawLine(pixels, pixelWidth, pixelHeight, centerX, centerY, needleEndX, needleEndY, parseHex(colors.textBright, 0.98), Math.max(3, arcThickness * 0.48));

  return { width: pixelWidth, height: pixelHeight, pixels };
}

export function TerminalSpeedometerGauge({
  value,
  valueLabel,
  width,
  segments,
  min,
  max,
  currentLabel,
  minWidth,
  maxWidth,
}: Required<SpeedometerGaugeProps>) {
  const colors = useThemeColors();
  const {
    nativeCharts,
    cellWidthPx = 8,
    cellHeightPx = 18,
    pixelRatio = 1,
  } = useUiCapabilities();
  const nativeRenderer = useNativeRenderer();
  const gaugeWidth = Math.max(minWidth, Math.min(maxWidth, Math.floor(width - 4)));
  const labelRow = useMemo(() => renderLabelRow(gaugeWidth, segments), [gaugeWidth, segments]);
  const tickRow = useMemo(
    () => renderTickRow(gaugeWidth, min, max, colors),
    [colors.textDim, gaugeWidth, max, min],
  );
  const arcRows = useMemo(
    () => renderArcRows(value, min, max, gaugeWidth, segments, colors),
    [colors.textBright, colors.textDim, gaugeWidth, max, min, segments, value],
  );
  const rendererCapabilities = nativeRenderer.capabilities;
  const rendererResolution = nativeRenderer.resolution;
  const rendererTerminalWidth = nativeRenderer.terminalWidth;
  const rendererTerminalHeight = nativeRenderer.terminalHeight;
  const bitmap = useMemo<NativeChartBitmap | null>(() => {
    if (!shouldRenderNativeBitmap(nativeRenderer, nativeCharts === true)) return null;
    const bitmapSize = resolveNativeBitmapSize({
      width: gaugeWidth,
      height: arcRows.length,
      resolution: rendererResolution,
      terminalWidth: rendererTerminalWidth,
      terminalHeight: rendererTerminalHeight,
      cellWidthPx,
      cellHeightPx,
      pixelRatio,
    });
    return renderGaugeBitmap(
      value,
      min,
      max,
      segments,
      bitmapSize.pixelWidth,
      bitmapSize.pixelHeight,
      colors,
    );
  }, [
    arcRows.length,
    cellHeightPx,
    cellWidthPx,
    colors.textBright,
    colors.textDim,
    gaugeWidth,
    max,
    min,
    nativeCharts,
    nativeRenderer,
    pixelRatio,
    rendererCapabilities,
    rendererResolution,
    rendererTerminalHeight,
    rendererTerminalWidth,
    segments,
    value,
  ]);

  return (
    <Box flexDirection="column" alignItems="center" marginTop={1}>
      <GaugeLine chunks={labelRow} />
      <ChartSurface width={gaugeWidth} height={arcRows.length} flexDirection="column" bitmaps={bitmap ? [bitmap] : null}>
        {arcRows.map((chunks, index) => (
          <GaugeLine key={index} chunks={chunks} />
        ))}
      </ChartSurface>
      <GaugeLine chunks={tickRow} />
      <Box flexDirection="row" marginTop={1}>
        <Text fg={colors.textDim}>{currentLabel} </Text>
        <Text fg={segmentColorForScore(value, segments)} attributes={TextAttributes.BOLD}>{valueLabel}</Text>
      </Box>
    </Box>
  );
}
