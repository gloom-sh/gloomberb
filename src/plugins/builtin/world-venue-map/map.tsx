import { createElement, useMemo, useRef } from "react";
import type { CloudWorldVenuePayload } from "../../../api-client";
import { ChartSurface, Text, useNativeRenderer, useUiHost } from "../../../ui";
import { useThemeColors } from "../../../theme/theme-context";
import { resolveNativeBitmapSize, shouldRenderNativeBitmap } from "../../../components/chart/native/bitmap-support";
import { drawCircle, drawLine, fillOpaque, parseHex } from "../../../components/chart/native/raster/primitives";
import type { NativeChartBitmap } from "../../../components/chart/native/chart-rasterizer";
import { getLocalPlotPointer, type ChartMouseEvent } from "../../../components/chart/core/pointer";
import {
  closestWorldVenueCluster,
  clusterWorldVenues,
  projectWorldPoint,
  type WorldVenueCluster,
} from "./model";
import { WORLD_OUTLINES } from "./world-outlines";

interface WorldVenueMapProps {
  venues: readonly CloudWorldVenuePayload[];
  selectedMic: string | null;
  width: number;
  height: number;
  onSelect: (venue: CloudWorldVenuePayload) => void;
}

function clusterVenue(cluster: WorldVenueCluster, selectedMic: string | null): CloudWorldVenuePayload {
  return cluster.venues.find((venue) => venue.mic === selectedMic)
    ?? cluster.venues.find((venue) => venue.isOpen)
    ?? cluster.venues[0]!;
}

function isSelectedCluster(cluster: WorldVenueCluster, selectedMic: string | null): boolean {
  return cluster.venues.some((venue) => venue.mic === selectedMic);
}

function drawWorldOutlines(
  pixels: Uint8Array,
  width: number,
  height: number,
  color: ReturnType<typeof parseHex>,
  thickness: number,
) {
  for (const outline of WORLD_OUTLINES) {
    for (let index = 1; index < outline.length; index += 1) {
      const previous = outline[index - 1]!;
      const current = outline[index]!;
      if (previous[1] < -60 || current[1] < -60) continue;
      const from = projectWorldPoint(previous[0], previous[1], width, height);
      const to = projectWorldPoint(current[0], current[1], width, height);
      if (Math.abs(to.x - from.x) > width / 2) continue;
      drawLine(pixels, width, height, from.x, from.y, to.x, to.y, color, thickness);
    }
  }
}

const DIGITS: Record<string, readonly string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

function drawClusterCount(
  bitmap: NativeChartBitmap,
  x: number,
  y: number,
  count: number,
  color: ReturnType<typeof parseHex>,
  scale: number,
) {
  const value = String(count);
  const glyphWidth = 3 * scale;
  const gap = scale;
  const totalWidth = value.length * glyphWidth + (value.length - 1) * gap;
  const left = Math.round(x - totalWidth / 2);
  const top = Math.round(y - (5 * scale) / 2);
  for (let digitIndex = 0; digitIndex < value.length; digitIndex += 1) {
    const glyph = DIGITS[value[digitIndex]!]!;
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        if (glyph[row]![column] !== "1") continue;
        const x0 = left + digitIndex * (glyphWidth + gap) + column * scale;
        const y0 = top + row * scale;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const pixelX = x0 + dx;
            const pixelY = y0 + dy;
            if (pixelX < 0 || pixelY < 0 || pixelX >= bitmap.width || pixelY >= bitmap.height) continue;
            const offset = (pixelY * bitmap.width + pixelX) * 4;
            bitmap.pixels[offset] = color.r;
            bitmap.pixels[offset + 1] = color.g;
            bitmap.pixels[offset + 2] = color.b;
            bitmap.pixels[offset + 3] = color.a;
          }
        }
      }
    }
  }
}

function renderWorldBitmap(
  venues: readonly CloudWorldVenuePayload[],
  selectedMic: string | null,
  width: number,
  height: number,
  colors: ReturnType<typeof useThemeColors>,
): NativeChartBitmap {
  const bitmap = { width, height, pixels: new Uint8Array(width * height * 4) };
  fillOpaque(bitmap.pixels, parseHex(colors.bg));
  drawWorldOutlines(bitmap.pixels, width, height, parseHex(colors.textDim, 0.62), Math.max(1, width / 900));

  const clusters = clusterWorldVenues(venues, width, height);
  for (const cluster of clusters) {
    const selected = isSelectedCluster(cluster, selectedMic);
    const radius = Math.max(3, Math.min(14, 3 + Math.sqrt(cluster.venues.length) * 1.7));
    if (selected) {
      drawCircle(bitmap.pixels, width, height, cluster.x, cluster.y, radius + 2.5, parseHex(colors.selected));
    }
    drawCircle(
      bitmap.pixels,
      width,
      height,
      cluster.x,
      cluster.y,
      radius,
      parseHex(cluster.isOpen ? colors.positive : colors.textMuted),
    );
    if (cluster.venues.length > 1) {
      drawClusterCount(bitmap, cluster.x, cluster.y, cluster.venues.length, parseHex(colors.bg), width >= 700 ? 2 : 1);
    }
  }
  return bitmap;
}

function renderAsciiMap(
  venues: readonly CloudWorldVenuePayload[],
  selectedMic: string | null,
  width: number,
  height: number,
): string[] {
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
  for (const outline of WORLD_OUTLINES) {
    for (const coordinate of outline) {
      const point = projectWorldPoint(coordinate[0], coordinate[1], width, height);
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      if (grid[y]?.[x] === " ") grid[y]![x] = ".";
    }
  }
  for (const cluster of clusterWorldVenues(venues, width, height)) {
    const x = Math.round(cluster.x);
    const y = Math.round(cluster.y);
    grid[y]![x] = isSelectedCluster(cluster, selectedMic)
      ? "@"
      : cluster.venues.length > 1
        ? String(Math.min(cluster.venues.length, 9))
        : cluster.isOpen ? "O" : "o";
  }
  return grid.map((row) => row.join(""));
}

function TerminalWorldVenueMap(props: WorldVenueMapProps) {
  const colors = useThemeColors();
  const renderer = useNativeRenderer();
  const surfaceRef = useRef<any>(null);
  const { nativeCharts, cellWidthPx = 8, cellHeightPx = 18, pixelRatio = 1 } = useUiHost().capabilities ?? {};
  const rendererCapabilities = renderer.capabilities;
  const rendererResolution = renderer.resolution;
  const rendererTerminalWidth = renderer.terminalWidth;
  const rendererTerminalHeight = renderer.terminalHeight;
  const bitmap = useMemo(() => {
    if (!shouldRenderNativeBitmap(renderer, nativeCharts === true)) return null;
    const size = resolveNativeBitmapSize({
      width: props.width,
      height: props.height,
      resolution: rendererResolution,
      terminalWidth: rendererTerminalWidth,
      terminalHeight: rendererTerminalHeight,
      cellWidthPx,
      cellHeightPx,
      pixelRatio,
    });
    return renderWorldBitmap(props.venues, props.selectedMic, size.pixelWidth, size.pixelHeight, colors);
  }, [
    cellHeightPx,
    cellWidthPx,
    colors,
    nativeCharts,
    pixelRatio,
    props.height,
    props.selectedMic,
    props.venues,
    props.width,
    renderer,
    rendererCapabilities,
    rendererResolution,
    rendererTerminalHeight,
    rendererTerminalWidth,
  ]);
  const clusters = useMemo(
    () => clusterWorldVenues(props.venues, props.width, props.height),
    [props.height, props.venues, props.width],
  );
  const ascii = useMemo(
    () => renderAsciiMap(props.venues, props.selectedMic, props.width, props.height),
    [props.height, props.selectedMic, props.venues, props.width],
  );

  const selectAt = (event: ChartMouseEvent) => {
    const pointer = getLocalPlotPointer(event, surfaceRef.current, renderer);
    if (!pointer) return;
    const cluster = closestWorldVenueCluster(clusters, pointer.cellX, pointer.cellY, 4);
    if (cluster) props.onSelect(clusterVenue(cluster, props.selectedMic));
  };

  return (
    <ChartSurface
      ref={surfaceRef}
      width={props.width}
      height={props.height}
      flexDirection="column"
      bitmaps={bitmap ? [bitmap] : null}
      onMouseDown={selectAt}
      data-gloom-role="world-venue-map"
      aria-label="World venue map"
    >
      {ascii.map((line, index) => <Text key={index} fg={colors.textDim}>{line}</Text>)}
    </ChartSurface>
  );
}

function DesktopWorldVenueMap(props: WorldVenueMapProps) {
  const colors = useThemeColors();
  // Desktop rows are roughly twice as tall as they are wide. Match the SVG
  // view box to those pixels so the map fills its pane without stretching.
  const plotHeight = props.height * 2.12;
  const clusters = useMemo(
    () => clusterWorldVenues(props.venues, props.width, plotHeight),
    [plotHeight, props.venues, props.width],
  );

  const outlinePath = (outline: (typeof WORLD_OUTLINES)[number]) => {
    let drawing = false;
    let previousLongitude: number | null = null;
    return outline.map(([longitude, latitude]) => {
      if (latitude < -60 || (previousLongitude != null && Math.abs(longitude - previousLongitude) > 180)) {
        drawing = false;
        previousLongitude = longitude;
        return "";
      }
      const point = projectWorldPoint(longitude, latitude, props.width, plotHeight);
      previousLongitude = longitude;
      const command = drawing ? "L" : "M";
      drawing = true;
      return `${command}${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    }).join(" ");
  };

  return (
    <svg
      viewBox={`0 0 ${props.width} ${plotHeight}`}
      width="100%"
      height="100%"
      role="img"
      aria-label="World venue map"
      style={{ display: "block", background: colors.bg }}
    >
      {WORLD_OUTLINES.map((outline, index) => (
        <path
          key={index}
          d={outlinePath(outline)}
          fill="none"
          stroke={colors.textDim}
          strokeOpacity="0.64"
          strokeWidth="0.55"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {clusters.map((cluster) => {
        const selected = isSelectedCluster(cluster, props.selectedMic);
        const venue = clusterVenue(cluster, props.selectedMic);
        const radius = Math.max(0.55, Math.min(1.5, 0.45 + Math.sqrt(cluster.venues.length) * 0.22));
        return (
          <g
            key={cluster.id}
            role="button"
            tabIndex={0}
            aria-label={`${cluster.venues.length} venues near ${venue.city}`}
            style={{ cursor: "pointer" }}
            onMouseDown={(event) => {
              event.stopPropagation();
              props.onSelect(venue);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") props.onSelect(venue);
            }}
          >
            <title>{cluster.venues.map((item) => `${item.mic} ${item.name}`).join(", ")}</title>
            <circle
              cx={cluster.x}
              cy={cluster.y}
              r={radius + (selected ? 0.24 : 0)}
              fill={cluster.isOpen ? colors.positive : colors.textMuted}
              stroke={selected ? colors.selected : colors.bg}
              strokeWidth={selected ? 0.5 : 0.16}
              vectorEffect="non-scaling-stroke"
            />
            {cluster.venues.length > 1 ? createElement("text", {
              x: cluster.x,
              y: cluster.y,
              fill: colors.bg,
              fontSize: Math.max(0.72, radius),
              fontWeight: "700",
              fontFamily: "inherit",
              textAnchor: "middle",
              dominantBaseline: "central",
              pointerEvents: "none",
            }, cluster.venues.length) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function WorldVenueMap(props: WorldVenueMapProps) {
  return useUiHost().kind === "desktop-web"
    ? <DesktopWorldVenueMap {...props} />
    : <TerminalWorldVenueMap {...props} />;
}
