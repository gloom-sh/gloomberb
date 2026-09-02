import { createElement, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { CloudWorldVenuePayload } from "../../../api-client";
import { Box, ChartSurface, Text, useNativeRenderer, useUiHost } from "../../../ui";
import { useThemeColors } from "../../../theme/theme-context";
import { resolveNativeBitmapSize, shouldRenderNativeBitmap } from "../../../components/chart/native/bitmap-support";
import { drawCircle, drawLine, fillOpaque, parseHex } from "../../../components/chart/native/raster/primitives";
import type { NativeChartBitmap } from "../../../components/chart/native/chart-rasterizer";
import { getLocalPlotPointer, type ChartMouseEvent } from "../../../components/chart/core/pointer";
import {
  closestWorldVenueCluster,
  clusterWorldVenues,
  DEFAULT_WORLD_MAP_VIEWPORT,
  panWorldMapViewport,
  projectWorldPoint,
  zoomWorldMapViewport,
  type WorldMapPoint,
  type WorldMapViewport,
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
  const left = Math.round(x - (totalWidth - 1) / 2);
  const top = Math.round(y - (5 * scale - 1) / 2);
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
      drawCircle(bitmap.pixels, width, height, cluster.x, cluster.y, radius + 2.5, parseHex(colors.selectedText));
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
  cellAspect: number,
): string[] {
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
  for (const outline of WORLD_OUTLINES) {
    for (const coordinate of outline) {
      const point = projectWorldPoint(coordinate[0], coordinate[1], width, height, cellAspect);
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      if (grid[y]?.[x] === " ") grid[y]![x] = ".";
    }
  }
  for (const cluster of clusterWorldVenues(venues, width, height, cellAspect)) {
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
  const cellAspect = cellHeightPx / Math.max(cellWidthPx, 1);
  const clusters = useMemo(
    () => clusterWorldVenues(props.venues, props.width, props.height, cellAspect),
    [cellAspect, props.height, props.venues, props.width],
  );
  const ascii = useMemo(
    () => renderAsciiMap(props.venues, props.selectedMic, props.width, props.height, cellAspect),
    [cellAspect, props.height, props.selectedMic, props.venues, props.width],
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

const DESKTOP_MAP_ASPECT = 2.12;
const MAP_PAN_THRESHOLD_PX = 4;
const MAP_CLICK_HIT_PX = 14;
const MAP_DOUBLE_CLICK_ZOOM = 1.8;

function wheelZoomFactor(event: WheelEvent): number {
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
  return Math.exp(-delta * 0.002);
}

function clientToMapPoint(
  event: { clientX: number; clientY: number },
  element: HTMLElement,
  width: number,
  height: number,
): WorldMapPoint {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.width <= 0 ? 0 : ((event.clientX - rect.left) / rect.width) * width,
    y: rect.height <= 0 ? 0 : ((event.clientY - rect.top) / rect.height) * height,
  };
}

function clientDeltaToMapDelta(
  deltaX: number,
  deltaY: number,
  element: HTMLElement,
  width: number,
  height: number,
): WorldMapPoint {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.width <= 0 ? 0 : (deltaX / rect.width) * width,
    y: rect.height <= 0 ? 0 : (deltaY / rect.height) * height,
  };
}

function DesktopWorldVenueMap(props: WorldVenueMapProps) {
  const colors = useThemeColors();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<WorldMapViewport>(DEFAULT_WORLD_MAP_VIEWPORT);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  // Desktop rows are roughly twice as tall as they are wide. Matching the SVG
  // view box to those pixels lets the contained world projection keep its shape.
  const plotHeight = props.height * DESKTOP_MAP_ASPECT;
  const zoomed = viewport.zoom > 1;
  const clusters = useMemo(
    () => clusterWorldVenues(props.venues, props.width, plotHeight, 1, viewport),
    [plotHeight, props.venues, props.width, viewport],
  );
  const outlinePaths = useMemo(() => WORLD_OUTLINES.map((outline) => {
    let drawing = false;
    let previousLongitude: number | null = null;
    return outline.map(([longitude, latitude]) => {
      if (latitude < -60 || (previousLongitude != null && Math.abs(longitude - previousLongitude) > 180)) {
        drawing = false;
        previousLongitude = longitude;
        return "";
      }
      const point = projectWorldPoint(longitude, latitude, props.width, plotHeight, 1, viewport);
      previousLongitude = longitude;
      const command = drawing ? "L" : "M";
      drawing = true;
      return `${command}${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    }).join(" ");
  }), [plotHeight, props.width, viewport]);

  const selectAt = useCallback((point: WorldMapPoint, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const hit = rect.height <= 0 ? 2.4 : (MAP_CLICK_HIT_PX / rect.height) * plotHeight;
    const cluster = closestWorldVenueCluster(clusters, point.x, point.y, Math.max(1.6, hit));
    if (cluster) props.onSelect(clusterVenue(cluster, props.selectedMic));
  }, [clusters, plotHeight, props]);

  useEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const point = clientToMapPoint(event, element, props.width, plotHeight);
      const factor = wheelZoomFactor(event);
      setViewport((current) => zoomWorldMapViewport(current, props.width, plotHeight, point, factor));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [plotHeight, props.width]);

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) selectAt(clientToMapPoint(event, event.currentTarget, props.width, plotHeight), event.currentTarget);
  };

  return (
    <Box width={props.width} height={props.height} overflow="hidden">
      <div
        ref={surfaceRef}
        data-gloom-role="world-venue-map"
        data-zoomed={zoomed ? "true" : "false"}
        role="application"
        aria-label="World venue map"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          dragRef.current = {
            pointerId: event.pointerId,
            lastX: event.clientX,
            lastY: event.clientY,
            originX: event.clientX,
            originY: event.clientY,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const travel = Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY);
          if (!drag.moved && travel < MAP_PAN_THRESHOLD_PX) return;
          if (viewportRef.current.zoom <= 1) return;
          drag.moved = true;
          const delta = clientDeltaToMapDelta(
            event.clientX - drag.lastX,
            event.clientY - drag.lastY,
            event.currentTarget,
            props.width,
            plotHeight,
          );
          drag.lastX = event.clientX;
          drag.lastY = event.clientY;
          setDragging(true);
          setViewport((current) => panWorldMapViewport(current, props.width, plotHeight, delta.x, delta.y));
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(event) => {
          const point = clientToMapPoint(event, event.currentTarget, props.width, plotHeight);
          setViewport((current) => zoomWorldMapViewport(current, props.width, plotHeight, point, MAP_DOUBLE_CLICK_ZOOM));
        }}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          touchAction: "none",
          userSelect: "none",
          cursor: dragging ? "grabbing" : zoomed ? "grab" : "pointer",
          background: colors.bg,
        }}
      >
        <svg
          viewBox={`0 0 ${props.width} ${plotHeight}`}
          width="100%"
          height="100%"
          aria-hidden="true"
          style={{ display: "block", background: colors.bg, pointerEvents: "none" }}
        >
          {outlinePaths.map((path, index) => (
            <path
              key={index}
              d={path}
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
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    props.onSelect(venue);
                  }
                }}
              >
                <title>{`${cluster.venues.length} venue${cluster.venues.length === 1 ? "" : "s"} near ${venue.city}: ${cluster.venues.map((item) => `${item.mic} ${item.name}`).join(", ")}`}</title>
                <circle
                  cx={cluster.x}
                  cy={cluster.y}
                  r={radius + (selected ? 0.24 : 0)}
                  fill={cluster.isOpen ? colors.positive : colors.textMuted}
                  stroke={selected ? colors.selectedText : colors.bg}
                  strokeWidth={selected ? 0.35 : 0.16}
                  vectorEffect="non-scaling-stroke"
                />
                {cluster.venues.length > 1 ? createElement("text", {
                  x: cluster.x,
                  y: cluster.y,
                  fill: colors.bg,
                  dy: "0.34em",
                  fontSize: Math.max(0.62, Math.min(0.95, radius * 0.78)),
                  fontWeight: "700",
                  fontFamily: "inherit",
                  textAnchor: "middle",
                  pointerEvents: "none",
                }, cluster.venues.length) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </Box>
  );
}

export function WorldVenueMap(props: WorldVenueMapProps) {
  return useUiHost().kind === "desktop-web"
    ? <DesktopWorldVenueMap {...props} />
    : <TerminalWorldVenueMap {...props} />;
}
