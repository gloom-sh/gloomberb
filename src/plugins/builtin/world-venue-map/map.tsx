import { createElement, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { CloudWorldVenuePayload } from "../../../api-client";
import { Box, ChartSurface, Text, useNativeRenderer, useUiCapabilities, useUiHost } from "../../../ui";
import { useThemeColors } from "../../../theme/theme-context";
import { blendHex, parseHex as parseRgb, relativeLuminance } from "../../../theme/color-utils";
import { resolveNativeBitmapSize, shouldRenderNativeBitmap } from "../../../components/chart/native/bitmap-support";
import { drawCircle, drawLine, fillOpaque, parseHex } from "../../../components/chart/native/raster/primitives";
import type { NativeChartBitmap } from "../../../components/chart/native/chart-rasterizer";
import { getLocalPlotPointer, type ChartMouseEvent } from "../../../components/chart/core/pointer";
import { usePaneFooter } from "../../../components/layout/pane/footer";
import {
  clampWorldMapViewport,
  closestWorldVenueCluster,
  clusterWorldVenues,
  DEFAULT_WORLD_MAP_VIEWPORT,
  MAX_WORLD_MAP_ZOOM,
  panWorldMapViewport,
  projectWorldPoint,
  savedWorldMapViewport,
  unprojectWorldPoint,
  zoomWorldMapViewport,
  type WorldMapPoint,
  type WorldMapViewport,
  type WorldVenueCluster,
} from "./model";
import { WORLD_OUTLINES } from "./world-outlines";
import { drawGeoBitmap, hitTestGeo, rasterGeoCells, type GeoHit, type GeoMapOverlay } from "./geo-draw";
import { GeoSvgLayers, MapIconSwatch, toneColor, type MapMatrix, type SymbolTones } from "./geo-svg";
import { BasemapLayer, type BasemapPalette } from "./basemap-layer";
import { loadCountryLabels, type CountryLabel, type GeoBox } from "./basemap";
import { COUNTRY_LABEL_FONT_PX, layoutCountryLabels, type LabelObstacle, type PlacedCountryLabel } from "./country-labels";
import { layerSymbol, shipClass, usesClassTones, type MapSymbolId, type SymbolTone } from "./map-symbols";
import { geoViewForViewport, sameGeoView, WORLD_GEO_VIEW, type GeoView } from "./layers";

/** Where the map should look: a new key centres it, at least at `zoom`. */
export interface WorldMapFocus {
  key: string;
  longitude: number;
  latitude: number;
  zoom?: number;
}

interface WorldVenueMapProps {
  venues: readonly CloudWorldVenuePayload[];
  selectedMic: string | null;
  width: number;
  height: number;
  onSelect: (venue: CloudWorldVenuePayload) => void;
  /** Geo layers drawn on the same projection; without them the map is the venue map alone. */
  overlay?: GeoMapOverlay;
  onSelectGeo?: (hit: Extract<GeoHit, { kind: "feature" }>) => void;
  /** The area and zoom in view, as the layers request it. */
  onViewChange?: (view: GeoView) => void;
  focus?: WorldMapFocus | null;
  /** How far the map may zoom; geo layers go closer than venues. */
  maxZoom?: number;
  /**
   * Where the map was when this pane last drew it (saved pane state). A pane
   * docked, undocked, popped out or reloaded mounts a new map; it opens here.
   */
  savedViewport?: unknown;
  /** The view once it has rested for a moment, for the pane to keep. */
  onViewportSettled?: (viewport: WorldMapViewport) => void;
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
  overlay?: GeoMapOverlay,
): NativeChartBitmap {
  const bitmap = { width, height, pixels: new Uint8Array(width * height * 4) };
  fillOpaque(bitmap.pixels, parseHex(colors.bg));
  drawWorldOutlines(bitmap.pixels, width, height, parseHex(colors.textDim, 0.62), Math.max(1, width / 900));
  if (overlay) {
    drawGeoBitmap(bitmap, overlay, (longitude, latitude) => projectWorldPoint(longitude, latitude, width, height), colors.selectedText);
  }

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
  overlay?: GeoMapOverlay,
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
  const project = (longitude: number, latitude: number) => projectWorldPoint(longitude, latitude, width, height, cellAspect);
  if (overlay) rasterGeoCells(grid, overlay, project);
  for (const cluster of clusterWorldVenues(venues, width, height, cellAspect)) {
    const x = Math.round(cluster.x);
    const y = Math.round(cluster.y);
    grid[y]![x] = isSelectedCluster(cluster, selectedMic)
      ? "@"
      : cluster.venues.length > 1
        ? String(Math.min(cluster.venues.length, 9))
        : cluster.isOpen ? "O" : "o";
  }
  if (overlay?.selected) {
    const point = project(overlay.selected.longitude, overlay.selected.latitude);
    const row = grid[Math.round(point.y)];
    if (row && Math.round(point.x) >= 0 && Math.round(point.x) < width) row[Math.round(point.x)] = "@";
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
    return renderWorldBitmap(props.venues, props.selectedMic, size.pixelWidth, size.pixelHeight, colors, props.overlay);
  }, [
    cellHeightPx,
    cellWidthPx,
    colors,
    nativeCharts,
    pixelRatio,
    props.height,
    props.overlay,
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
    () => renderAsciiMap(props.venues, props.selectedMic, props.width, props.height, cellAspect, props.overlay),
    [cellAspect, props.height, props.overlay, props.selectedMic, props.venues, props.width],
  );

  // The terminal map never pans or zooms, so it always covers the world.
  const onViewChange = props.onViewChange;
  useEffect(() => {
    onViewChange?.(WORLD_GEO_VIEW);
  }, [onViewChange]);

  const selectAt = (event: ChartMouseEvent) => {
    const pointer = getLocalPlotPointer(event, surfaceRef.current, renderer);
    if (!pointer) return;
    if (props.overlay) {
      const hit = hitTestGeo(
        props.overlay,
        { x: pointer.cellX, y: pointer.cellY },
        (longitude, latitude) => projectWorldPoint(longitude, latitude, props.width, props.height, cellAspect),
        2.5,
      );
      if (hit?.kind === "feature") {
        props.onSelectGeo?.(hit);
        return;
      }
    }
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

/** Desktop rows are about twice as tall as they are wide; the measured surface replaces this once it is laid out. */
const DESKTOP_MAP_ASPECT = 2.12;
const MAP_PAN_THRESHOLD_PX = 4;
const MAP_CLICK_HIT_PX = 14;
const MAP_DOUBLE_CLICK_ZOOM = 1.8;
/** Share of the plot a selected venue may sit inside before the map pans to it. */
const MAP_FOLLOW_MARGIN = 0.06;
/** How long the view rests before the pane keeps it. */
const VIEWPORT_SETTLE_MS = 400;

/**
 * Whether a map of this many cells can be drawn. A pane mid-layout (a new
 * window, a dock move) can hand the map a width of one cell for a frame; a
 * projection from that has no scale, and a focus applied to it loses its
 * centre.
 */
function mapHasArea(width: number, height: number): boolean {
  return width > 2 && height > 1;
}

/** A venue dot's radius in view units, larger for a cluster of venues. */
function venueDotRadius(count: number): number {
  return Math.max(0.55, Math.min(1.5, 0.45 + Math.sqrt(count) * 0.22));
}

/** Country names are laid out again once the view has rested this long, not on every drag frame. */
const LABEL_SETTLE_MS = 150;
/** Room a selected or hovered marker keeps clear of country names, in pixels. */
const LABEL_MARKER_CLEARANCE_PX = 14;

/** The country names, from their lazy chunk; none until it arrives, none in a build without map data. */
function useCountryLabels(): readonly CountryLabel[] | null {
  const [labels, setLabels] = useState<readonly CountryLabel[] | null>(null);
  useEffect(() => {
    let current = true;
    loadCountryLabels().then((loaded) => {
      if (current) setLabels(loaded);
    }, () => {});
    return () => {
      current = false;
    };
  }, []);
  return labels;
}

/** Country names under the markers: small, quiet, never in the way of a click. */
function CountryNames({ labels, project, unitPx, color, halo }: {
  labels: readonly PlacedCountryLabel[];
  project: (longitude: number, latitude: number) => WorldMapPoint;
  unitPx: number;
  color: string;
  halo: string;
}) {
  if (!labels.length) return null;
  const fontSize = COUNTRY_LABEL_FONT_PX / unitPx;
  return createElement(
    "g",
    {
      "data-gloom-role": "country-labels",
      fill: color,
      stroke: halo,
      strokeWidth: 3 / unitPx,
      strokeOpacity: 0.8,
      strokeLinejoin: "round",
      paintOrder: "stroke",
      fontSize,
      fontFamily: "inherit",
      textAnchor: "middle",
      pointerEvents: "none",
    },
    ...labels.map((label) => {
      const at = project(label.longitude, label.latitude);
      return createElement("text", { key: label.name, x: at.x, y: at.y, dy: "0.35em" }, label.name);
    }),
  );
}

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

/** The surface's size in pixels, once laid out. */
function useElementSize(ref: { current: HTMLElement | null }): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setSize((current) => current && Math.abs(current.width - rect.width) < 0.5 && Math.abs(current.height - rect.height) < 0.5
        ? current
        : { width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

interface HoverState {
  hit: GeoHit;
  x: number;
  y: number;
}

function hoverLabel(hit: GeoHit, overlay: GeoMapOverlay): { title: string; detail: string | null } {
  const layer = overlay.layers.find((entry) => entry.id === hit.layerId);
  if (hit.kind === "cluster") {
    return { title: `${hit.cluster.count.toLocaleString("en-US")} ${layer?.name.toLowerCase() ?? ""}`.trim(), detail: null };
  }
  const props = hit.feature.props;
  if (usesClassTones(hit.layerId) || hit.feature.entityKind === "vessel") {
    const kind = shipClass(hit.feature);
    const speed = typeof props.speedKn === "number" && props.speedKn >= 1 ? `${props.speedKn.toFixed(0)} kn` : null;
    return { title: hit.feature.label, detail: [kind.charAt(0).toUpperCase() + kind.slice(1), speed].filter(Boolean).join(" · ") };
  }
  return { title: hit.feature.label, detail: null };
}

function DesktopWorldVenueMap(props: WorldVenueMapProps) {
  const colors = useThemeColors();
  const maxZoom = props.maxZoom ?? MAX_WORLD_MAP_ZOOM;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const surfaceSize = useElementSize(surfaceRef);
  const [viewport, setViewport] = useState<WorldMapViewport>(
    () => savedWorldMapViewport(props.savedViewport, maxZoom) ?? DEFAULT_WORLD_MAP_VIEWPORT,
  );
  const sized = mapHasArea(props.width, props.height);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<HoverState | null>(null);
  const hoverFrame = useRef<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  // The view box takes the surface's own proportions, so the drawing fills it
  // and a pointer maps to the same place it is drawn.
  const plotHeight = surfaceSize ? (props.width * surfaceSize.height) / surfaceSize.width : props.height * DESKTOP_MAP_ASPECT;
  const unitPx = surfaceSize ? surfaceSize.width / Math.max(props.width, 1) : 8;
  const zoomed = viewport.zoom > 1;
  const clusters = useMemo(
    () => clusterWorldVenues(props.venues, props.width, plotHeight, 1, viewport),
    [plotHeight, props.venues, props.width, viewport],
  );

  const project = useCallback(
    (longitude: number, latitude: number) => projectWorldPoint(longitude, latitude, props.width, plotHeight, 1, viewport),
    [plotHeight, props.width, viewport],
  );
  // The projection is linear, so land and layers are drawn once in degrees and
  // placed with one matrix: a pan or zoom changes that matrix, not the paths.
  const matrix = useMemo<MapMatrix>(() => {
    const origin = project(0, 0);
    return { a: project(1, 0).x - origin.x, bx: origin.x, by: origin.y };
  }, [project]);
  const view = useMemo<GeoBox>(() => {
    const topLeft = unprojectWorldPoint(0, 0, props.width, plotHeight, 1, viewport);
    const bottomRight = unprojectWorldPoint(props.width, plotHeight, props.width, plotHeight, 1, viewport);
    return [topLeft.longitude, bottomRight.latitude, bottomRight.longitude, topLeft.latitude];
  }, [plotHeight, props.width, viewport]);
  const pxPerDegree = matrix.a * unitPx;
  const dark = relativeLuminance(colors.text) > relativeLuminance(colors.bg);
  const palette = useMemo<BasemapPalette>(() => ({
    land: blendHex(colors.bg, colors.text, dark ? 0.1 : 0.07),
    coast: blendHex(colors.bg, colors.textDim, dark ? 0.85 : 0.75),
    border: blendHex(colors.bg, colors.textDim, dark ? 0.42 : 0.35),
    label: blendHex(colors.bg, colors.textDim, dark ? 0.7 : 0.8),
  }), [colors.bg, colors.text, colors.textDim, dark]);
  // Five colours in all: the layer's own for cargo, amber tankers, bright
  // passenger ships, green fishing boats, and one quiet grey for the rest.
  const tones = useMemo<SymbolTones>(() => {
    const quiet = blendHex(colors.textDim, colors.text, 0.45);
    return { tanker: colors.warning, passenger: colors.textBright, fishing: colors.positive, service: quiet, other: quiet };
  }, [colors.positive, colors.text, colors.textBright, colors.textDim, colors.warning]);

  // Names are placed for the view once it rests; a drag moves the ones already placed.
  const countryLabels = useCountryLabels();
  const [labelViewport, setLabelViewport] = useState(viewport);
  useEffect(() => {
    if (labelViewport === viewport) return;
    const timer = setTimeout(() => setLabelViewport(viewport), LABEL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [labelViewport, viewport]);
  const selectedPoint = props.overlay?.selected ?? null;
  const selectedVenuePoint = props.venues.find((venue) => venue.mic === props.selectedMic) ?? null;
  const hoverAnchor = hover?.hit.kind === "feature" && hover.hit.feature.geometry.type === "Point" ? hover.hit.feature.geometry.coordinates : null;
  const placedLabels = useMemo(() => {
    if (!countryLabels?.length) return [];
    const at = (longitude: number, latitude: number) => {
      const point = projectWorldPoint(longitude, latitude, props.width, plotHeight, 1, labelViewport);
      return { x: point.x * unitPx, y: point.y * unitPx };
    };
    const markers = [
      selectedPoint ? [selectedPoint.longitude, selectedPoint.latitude] : null,
      selectedVenuePoint ? [selectedVenuePoint.longitude, selectedVenuePoint.latitude] : null,
      hoverAnchor,
    ].filter((point): point is [number, number] => point !== null);
    const obstacles: LabelObstacle[] = markers.map(([longitude, latitude]) => ({ ...at(longitude, latitude), radius: LABEL_MARKER_CLEARANCE_PX }));
    // Venue dots are few and sit on land, where the names are: a name never runs under one.
    for (const cluster of clusterWorldVenues(props.venues, props.width, plotHeight, 1, labelViewport)) {
      obstacles.push({ x: cluster.x * unitPx, y: cluster.y * unitPx, radius: (venueDotRadius(cluster.venues.length) + 0.2) * unitPx });
    }
    return layoutCountryLabels(countryLabels, {
      pxPerDegree: (at(1, 0).x - at(0, 0).x),
      toPixels: at,
      widthPx: props.width * unitPx,
      heightPx: plotHeight * unitPx,
      obstacles,
    });
  }, [countryLabels, hoverAnchor?.[0], hoverAnchor?.[1], labelViewport, plotHeight, props.venues, props.width, selectedPoint?.latitude, selectedPoint?.longitude, selectedVenuePoint, unitPx]);

  const hitRadius = useCallback((element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return rect.height <= 0 ? 2.4 : (MAP_CLICK_HIT_PX / rect.height) * plotHeight;
  }, [plotHeight]);

  const selectAt = useCallback((point: WorldMapPoint, element: HTMLElement) => {
    const hit = hitRadius(element);
    if (props.overlay) {
      const geoHit = hitTestGeo(props.overlay, point, project, Math.max(1.2, hit * 0.8));
      if (geoHit?.kind === "cluster") {
        setViewport((current) => zoomWorldMapViewport(current, props.width, plotHeight, project(geoHit.cluster.lon, geoHit.cluster.lat), 2.5, 1, maxZoom));
        return;
      }
      if (geoHit?.kind === "feature") {
        props.onSelectGeo?.(geoHit);
        return;
      }
    }
    const cluster = closestWorldVenueCluster(clusters, point.x, point.y, Math.max(1.6, hit));
    if (cluster) props.onSelect(clusterVenue(cluster, props.selectedMic));
  }, [clusters, hitRadius, maxZoom, plotHeight, project, props]);

  const onViewChange = props.onViewChange;
  const reportedViewRef = useRef<GeoView | null>(null);
  useEffect(() => {
    if (!onViewChange || !sized) return;
    const next = geoViewForViewport(viewport, props.width, plotHeight);
    if (reportedViewRef.current && sameGeoView(reportedViewRef.current, next)) return;
    reportedViewRef.current = next;
    onViewChange(next);
  }, [onViewChange, plotHeight, props.width, sized, viewport]);

  // The pane keeps the view once it rests, so a remount opens where this left off.
  const onViewportSettled = props.onViewportSettled;
  const settledViewportRef = useRef(viewport);
  useEffect(() => {
    if (!onViewportSettled || settledViewportRef.current === viewport) return;
    const timer = setTimeout(() => {
      settledViewportRef.current = viewport;
      onViewportSettled(viewport);
    }, VIEWPORT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [onViewportSettled, viewport]);

  // A new focus (an entity picked in the table) centres the map on it, once
  // the map has an area to centre it in.
  const focusKey = props.focus?.key ?? null;
  const appliedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    const focus = props.focus;
    if (!focus || !sized || appliedFocusRef.current === focus.key) return;
    appliedFocusRef.current = focus.key;
    setViewport((current) => {
      const zoom = Math.max(current.zoom, focus.zoom ?? 1);
      if (zoom <= 1) return current;
      return clampWorldMapViewport({ zoom, centerLongitude: focus.longitude, centerLatitude: focus.latitude }, props.width, plotHeight, 1, maxZoom);
    });
  }, [focusKey, sized]);

  const selectedVenue = props.venues.find((venue) => venue.mic === props.selectedMic) ?? null;
  const selectedVenueRef = useRef(selectedVenue);
  selectedVenueRef.current = selectedVenue;
  const insidePlot = useCallback((point: WorldMapPoint) => {
    const marginX = props.width * MAP_FOLLOW_MARGIN;
    const marginY = plotHeight * MAP_FOLLOW_MARGIN;
    return point.x >= marginX && point.x <= props.width - marginX && point.y >= marginY && point.y <= plotHeight - marginY;
  }, [plotHeight, props.width]);

  // Keyboard zoom holds the selected venue in place, or the middle of the map
  // when the venue is out of view, so the table's cursor stays on the map.
  const zoomBy = useCallback((factor: number) => {
    setViewport((current) => {
      const venue = selectedVenueRef.current;
      const anchor = venue ? projectWorldPoint(venue.longitude, venue.latitude, props.width, plotHeight, 1, current) : null;
      const point = anchor && insidePlot(anchor) ? anchor : { x: props.width / 2, y: plotHeight / 2 };
      return zoomWorldMapViewport(current, props.width, plotHeight, point, factor, 1, maxZoom);
    });
  }, [insidePlot, maxZoom, plotHeight, props.width]);

  // A venue picked in the table pans a zoomed map to it when it is out of view.
  // Only a new selection moves the map, so a drag away from it stays put.
  useEffect(() => {
    const venue = selectedVenueRef.current;
    if (!venue) return;
    setViewport((current) => {
      if (current.zoom <= 1) return current;
      const point = projectWorldPoint(venue.longitude, venue.latitude, props.width, plotHeight, 1, current);
      if (insidePlot(point)) return current;
      return clampWorldMapViewport({ ...current, centerLongitude: venue.longitude, centerLatitude: venue.latitude }, props.width, plotHeight, 1, maxZoom);
    });
  }, [props.selectedMic]);

  const atMaxZoom = viewport.zoom >= maxZoom;
  usePaneFooter("world-venue-map:zoom", () => ({
    hints: [
      { id: "zoom-in", key: "+", label: " zoom in", title: "Zoom In", onPress: () => zoomBy(MAP_DOUBLE_CLICK_ZOOM), disabled: atMaxZoom },
      ...(zoomed ? [
        { id: "zoom-out", key: "-", label: " zoom out", title: "Zoom Out", onPress: () => zoomBy(1 / MAP_DOUBLE_CLICK_ZOOM) },
        { id: "zoom-reset", key: "0", label: " reset zoom", title: "Reset Zoom", onPress: () => setViewport(DEFAULT_WORLD_MAP_VIEWPORT) },
      ] : []),
    ],
    // "=" is "+" without Shift, as it is for charts.
    keys: [{ id: "zoom-in-equals", key: "=", label: "", onPress: () => zoomBy(MAP_DOUBLE_CLICK_ZOOM) }],
  }), [atMaxZoom, zoomBy, zoomed]);

  useEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const point = clientToMapPoint(event, element, props.width, plotHeight);
      const factor = wheelZoomFactor(event);
      setViewport((current) => zoomWorldMapViewport(current, props.width, plotHeight, point, factor, 1, maxZoom));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [maxZoom, plotHeight, props.width]);

  useEffect(() => () => {
    if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
  }, []);
  // What sits under the pointer, at most once a frame: its name shows beside it.
  const trackHover = (clientX: number, clientY: number, element: HTMLElement) => {
    if (!props.overlay) return;
    if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = null;
      if (dragRef.current?.moved || !props.overlay) return;
      const point = clientToMapPoint({ clientX, clientY }, element, props.width, plotHeight);
      const hit = hitTestGeo(props.overlay, point, project, Math.max(1.2, hitRadius(element) * 0.8));
      const rect = element.getBoundingClientRect();
      setHover(hit ? { hit, x: clientX - rect.left, y: clientY - rect.top } : null);
    });
  };

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

  const hovered = hover && !dragging ? hover : null;
  const tooltip = hovered && props.overlay ? hoverLabel(hovered.hit, props.overlay) : null;

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
          if (!drag || drag.pointerId !== event.pointerId) {
            if (event.pointerType !== "touch") trackHover(event.clientX, event.clientY, event.currentTarget);
            return;
          }
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
          setViewport((current) => panWorldMapViewport(current, props.width, plotHeight, delta.x, delta.y, 1, maxZoom));
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={(event) => {
          const point = clientToMapPoint(event, event.currentTarget, props.width, plotHeight);
          setViewport((current) => zoomWorldMapViewport(current, props.width, plotHeight, point, MAP_DOUBLE_CLICK_ZOOM, 1, maxZoom));
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
          cursor: dragging ? "grabbing" : hovered ? "pointer" : zoomed ? "grab" : "default",
          background: colors.bg,
        }}
      >
        {sized ? (
          <svg
            viewBox={`0 0 ${props.width} ${plotHeight}`}
            width="100%"
            height="100%"
            aria-hidden="true"
            style={{ display: "block", background: colors.bg, pointerEvents: "none" }}
          >
            <BasemapLayer matrix={matrix} view={view} pxPerDegree={pxPerDegree} palette={palette} />
            <CountryNames labels={placedLabels} project={project} unitPx={unitPx} color={palette.label} halo={colors.bg} />
            {props.overlay ? (
              <GeoSvgLayers
                overlay={props.overlay}
                matrix={matrix}
                project={project}
                view={view}
                unitPx={unitPx}
                mapWidthPx={surfaceSize?.width ?? props.width * 8}
                background={colors.bg}
                selectedColor={colors.selectedText}
                textColor={colors.textBright}
                tones={tones}
                hovered={hovered?.hit ?? null}
              />
            ) : null}
            {clusters.map((cluster) => {
              const selected = isSelectedCluster(cluster, props.selectedMic);
              const venue = clusterVenue(cluster, props.selectedMic);
              const radius = venueDotRadius(cluster.venues.length);
              return (
                <g key={cluster.id}>
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
        ) : null}
        {tooltip && hovered ? (
          <MapTooltip
            title={tooltip.title}
            detail={tooltip.detail}
            x={hovered.x}
            y={hovered.y}
            width={surfaceSize?.width ?? 0}
          />
        ) : null}
        {props.overlay && sized ? <GeoLegend overlay={props.overlay} venues={props.venues.length > 0} tones={tones} /> : null}
      </div>
    </Box>
  );
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = parseRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The name under the pointer, beside it and inside the map. */
function MapTooltip({ title, detail, x, y, width }: { title: string; detail: string | null; x: number; y: number; width: number }) {
  const colors = useThemeColors();
  const flip = width > 0 && x > width - 200;
  return createElement(
    "div",
    {
      "data-gloom-role": "geo-hover",
      style: {
        position: "absolute",
        left: flip ? undefined : x + 14,
        right: flip ? width - x + 14 : undefined,
        top: Math.max(4, y - 30),
        padding: "3px 8px",
        background: colors.panel,
        border: `1px solid ${colors.border}`,
        borderRadius: 4,
        color: colors.textBright,
        fontSize: "0.85em",
        lineHeight: 1.35,
        whiteSpace: "nowrap",
        pointerEvents: "none",
      },
    },
    title,
    detail ? createElement("span", { style: { color: colors.textDim, marginLeft: 8 } }, detail) : null,
  );
}

interface LegendItem {
  id: string;
  name: string;
  color: string;
  symbol: MapSymbolId | null;
  line?: boolean;
}

/** Which icon and colour is which layer, once there is more than one on the map. Ships open their class key on hover. */
function GeoLegend({ overlay, venues, tones }: { overlay: GeoMapOverlay; venues: boolean; tones: SymbolTones }) {
  const colors = useThemeColors();
  const [classesOpen, setClassesOpen] = useState(false);
  const items: LegendItem[] = [
    ...(venues ? [{ id: "venues", name: "Venues", color: colors.positive, symbol: "dot" as const }] : []),
    // Only what is drawn: a layer below its zoom or unable to serve has nothing to explain.
    ...overlay.layers
      .filter((layer) => layer.features.length > 0 || layer.clusters.length > 0)
      .map((layer) => ({
        id: layer.id,
        name: layer.name,
        color: layer.color,
        symbol: layer.geometry === "point" || layer.geometry === "area" ? layerSymbol(layer.id, layer.features[0]) : null,
        line: layer.geometry === "line",
      })),
  ];
  if (items.length < 2) return null;
  const ships = overlay.layers.find((layer) => usesClassTones(layer.id));
  return createElement(
    "div",
    {
      "data-gloom-role": "geo-legend",
      style: {
        position: "absolute",
        left: 6,
        bottom: 6,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 6,
        color: colors.textDim,
        fontSize: "0.85em",
        pointerEvents: "none",
      },
    },
    classesOpen && ships ? createElement(
      "div",
      {
        "data-gloom-role": "geo-legend-classes",
        style: {
          display: "grid",
          gridTemplateColumns: "14px auto",
          alignItems: "center",
          gap: "3px 8px",
          padding: "6px 9px",
          background: colors.panel,
          border: `1px solid ${colors.border}`,
          borderRadius: 4,
        },
      },
      ...SHIP_CLASS_KEY.flatMap(({ id, label, tone, symbol }) => [
        createElement("span", { key: `${id}:icon` }, <MapIconSwatch symbol={symbol} color={toneColor(ships, tone, tones)} background={colors.bg} />),
        createElement("span", { key: `${id}:label` }, label),
      ]),
    ) : null,
    createElement(
      "div",
      // A soft backing so the names read over coastlines and markers.
      { style: { display: "flex", flexWrap: "wrap", gap: "4px 14px", padding: "3px 6px", borderRadius: 4, background: withAlpha(colors.bg, 0.78) } },
      ...items.map((item) => createElement(
        "span",
        {
          key: item.id,
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            ...(item.id === ships?.id ? { pointerEvents: "auto", cursor: "default" } : {}),
          },
          ...(item.id === ships?.id ? {
            // A mouse opens the key on hover; a touch toggles it.
            onPointerEnter: (event: ReactPointerEvent) => {
              if (event.pointerType === "mouse") setClassesOpen(true);
            },
            onPointerLeave: (event: ReactPointerEvent) => {
              if (event.pointerType === "mouse") setClassesOpen(false);
            },
            onPointerDown: (event: ReactPointerEvent) => {
              event.stopPropagation();
              if (event.pointerType !== "mouse") setClassesOpen((open) => !open);
            },
          } : {}),
        },
        item.line
          ? createElement("span", { style: { width: 12, height: 2, borderRadius: 1, background: item.color } })
          : <MapIconSwatch symbol={item.symbol ?? "dot"} color={item.color} background={colors.bg} />,
        item.name,
      )),
    ),
  );
}

const SHIP_CLASS_KEY: { id: string; label: string; tone: SymbolTone; symbol: MapSymbolId }[] = [
  { id: "tanker", label: "Tanker", tone: "tanker", symbol: "ship" },
  { id: "cargo", label: "Cargo", tone: "layer", symbol: "ship" },
  { id: "passenger", label: "Passenger", tone: "passenger", symbol: "ship" },
  { id: "fishing", label: "Fishing", tone: "fishing", symbol: "ship-small" },
  { id: "service", label: "Tug and special", tone: "service", symbol: "ship-small" },
  { id: "other", label: "Other", tone: "other", symbol: "ship-other" },
];

export function WorldVenueMap(props: WorldVenueMapProps) {
  return useUiCapabilities().nativePaneChrome === true
    ? <DesktopWorldVenueMap {...props} />
    : <TerminalWorldVenueMap {...props} />;
}
