/**
 * Geo layers on the world map: SVG on the desktop and the web, cells and a
 * bitmap in the terminal, and the hit test both share. Everything is placed
 * with the venue map's own projection, so pan and zoom move the layers too.
 */
import { createElement, memo, useMemo } from "react";
import type { GeoCluster, GeoFeature } from "../../../api-client/geo";
import { drawCircle, drawLine, parseHex } from "../../../components/chart/native/raster/primitives";
import type { NativeChartBitmap } from "../../../components/chart/native/chart-rasterizer";
import { featureAnchor, featureLines } from "./layers";
import type { WorldMapPoint } from "./model";

export interface GeoMapLayer {
  id: string;
  name: string;
  geometry: "point" | "line" | "area";
  color: string;
  features: readonly GeoFeature[];
  clusters: readonly GeoCluster[];
}

export interface GeoMapSelection {
  layerId: string;
  id: string;
  longitude: number;
  latitude: number;
}

export interface GeoMapOverlay {
  layers: readonly GeoMapLayer[];
  selected: GeoMapSelection | null;
  /** The selected entity's recent track, oldest first. */
  trail: readonly (readonly [number, number])[] | null;
}

export type GeoHit =
  | { kind: "feature"; layerId: string; feature: GeoFeature }
  | { kind: "cluster"; layerId: string; cluster: GeoCluster };

type Project = (longitude: number, latitude: number) => WorldMapPoint;

/** Four hues as far apart as the map's four layers can be; green stays the venues'. */
const DARK_PALETTE = ["#4dabf7", "#ffa94d", "#e599f7", "#ffe066"];
const LIGHT_PALETTE = ["#1971c2", "#d9480f", "#ae3ec9", "#b08800"];

/** The colour of the nth layer on the map, so the layers shown together never share one. */
export function geoLayerColor(index: number, dark: boolean): string {
  const palette = dark ? DARK_PALETTE : LIGHT_PALETTE;
  return palette[((index % palette.length) + palette.length) % palette.length]!;
}

function distanceToSegment(point: WorldMapPoint, from: WorldMapPoint, to: WorldMapPoint): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length));
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy));
}

function insideRing(point: WorldMapPoint, ring: readonly WorldMapPoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index]!;
    const b = ring[previous]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** What sits under a point: a marker or cluster first, then a line, then an area. */
export function hitTestGeo(
  overlay: GeoMapOverlay,
  point: WorldMapPoint,
  project: Project,
  maxDistance: number,
): GeoHit | null {
  let best: GeoHit | null = null;
  let bestDistance = maxDistance;
  for (const layer of overlay.layers) {
    for (const cluster of layer.clusters) {
      const at = project(cluster.lon, cluster.lat);
      const distance = Math.hypot(at.x - point.x, at.y - point.y);
      if (distance <= bestDistance) {
        best = { kind: "cluster", layerId: layer.id, cluster };
        bestDistance = distance;
      }
    }
    if (layer.geometry !== "point") continue;
    for (const feature of layer.features) {
      const [longitude, latitude] = featureAnchor(feature);
      const at = project(longitude, latitude);
      const distance = Math.hypot(at.x - point.x, at.y - point.y);
      if (distance <= bestDistance) {
        best = { kind: "feature", layerId: layer.id, feature };
        bestDistance = distance;
      }
    }
  }
  if (best) return best;
  const lineDistance = maxDistance * 0.7;
  bestDistance = lineDistance;
  for (const layer of overlay.layers) {
    if (layer.geometry !== "line") continue;
    for (const feature of layer.features) {
      for (const line of featureLines(feature)) {
        for (let index = 1; index < line.length; index += 1) {
          const from = project(line[index - 1]![0], line[index - 1]![1]);
          const to = project(line[index]![0], line[index]![1]);
          const distance = distanceToSegment(point, from, to);
          if (distance <= bestDistance) {
            best = { kind: "feature", layerId: layer.id, feature };
            bestDistance = distance;
          }
        }
      }
    }
  }
  if (best) return best;
  for (const layer of overlay.layers) {
    if (layer.geometry !== "area") continue;
    for (const feature of layer.features) {
      const ring = featureLines(feature)[0];
      if (ring && insideRing(point, ring.map(([longitude, latitude]) => project(longitude, latitude)))) {
        return { kind: "feature", layerId: layer.id, feature };
      }
    }
  }
  return null;
}

/** An SVG path through coordinate runs, broken where a run crosses the date line. */
function pathFor(lines: readonly (readonly (readonly [number, number])[])[], project: Project, close: boolean): string {
  let path = "";
  for (const line of lines) {
    let previous: number | null = null;
    let drawing = false;
    for (const [longitude, latitude] of line) {
      if (previous !== null && Math.abs(longitude - previous) > 180) drawing = false;
      previous = longitude;
      const at = project(longitude, latitude);
      path += `${drawing ? "L" : "M"}${at.x.toFixed(2)} ${at.y.toFixed(2)}`;
      drawing = true;
    }
    if (close && drawing) path += "Z";
  }
  return path;
}

interface GeoSvgProps {
  overlay: GeoMapOverlay;
  /** Projection at the whole-world view; the group transform pans and zooms it. */
  baseProject: Project;
  /** Projection at the current view, for markers that keep their size. */
  project: Project;
  transform: string;
  /** Width of the map in its own units, which sizes the cluster badges. */
  mapWidth: number;
  background: string;
  selectedColor: string;
}

/** Few markers (chokepoints, terminals) are drawn large; thousands (ships) small. */
function markerSize(count: number): number {
  return count <= 24 ? 9 : count <= 400 ? 6 : 4;
}

const GeoFeaturePaths = memo(function GeoFeaturePaths({ layer, baseProject, background }: { layer: GeoMapLayer; baseProject: Project; background: string }) {
  const shapes = useMemo(() => {
    if (layer.geometry === "point") {
      // One path of zero-length runs: round caps draw every marker the same size at any zoom.
      return [{
        id: "points",
        d: layer.features.map((feature) => {
          const [longitude, latitude] = featureAnchor(feature);
          const at = baseProject(longitude, latitude);
          return `M${at.x.toFixed(2)} ${at.y.toFixed(2)}h0`;
        }).join(""),
      }];
    }
    return layer.features.map((feature) => ({
      id: feature.id,
      d: pathFor(featureLines(feature), baseProject, layer.geometry === "area"),
      label: feature.label,
    }));
  }, [baseProject, layer.features, layer.geometry]);
  if (layer.geometry === "point") {
    const size = markerSize(layer.features.length);
    return (
      <g data-geo-layer={layer.id}>
        <path d={shapes[0]!.d} fill="none" stroke={background} strokeWidth={size + 2.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <path d={shapes[0]!.d} fill="none" stroke={layer.color} strokeWidth={size} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </g>
    );
  }
  return (
    <g data-geo-layer={layer.id}>
      {shapes.map((shape) => (
        <path
          key={shape.id}
          d={shape.d}
          fill={layer.geometry === "area" ? layer.color : "none"}
          fillOpacity={layer.geometry === "area" ? 0.2 : undefined}
          stroke={layer.color}
          strokeOpacity={layer.geometry === "area" ? 0.75 : 0.9}
          strokeWidth={layer.geometry === "area" ? 1 : 1.6}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}, (previous, next) => previous.layer.features === next.layer.features
  && previous.layer.color === next.layer.color
  && previous.layer.geometry === next.layer.geometry
  && previous.baseProject === next.baseProject
  && previous.background === next.background);

/** Below this width (in cells) a cluster is a density dot; a count would not fit in a badge that small. */
const NUMBERED_CLUSTER_MIN_WIDTH = 72;

/** In map units (about a cell), growing with the count. */
function clusterRadius(count: number, numbered: boolean): number {
  return numbered
    ? Math.max(1.05, Math.min(2.4, 0.8 + Math.sqrt(count) * 0.22))
    : Math.max(0.3, Math.min(0.9, 0.22 + Math.sqrt(count) * 0.11));
}

/** The geo layers, drawn under the venue markers. */
export function GeoSvgLayers({ overlay, baseProject, project, transform, mapWidth, background, selectedColor }: GeoSvgProps) {
  const trailPath = overlay.trail && overlay.trail.length > 1 ? pathFor([overlay.trail], baseProject, false) : null;
  const selectedLayer = overlay.selected ? overlay.layers.find((layer) => layer.id === overlay.selected!.layerId) : null;
  const selectedFeature = selectedLayer?.features.find((feature) => feature.id === overlay.selected!.id) ?? null;
  const selectedAt = overlay.selected ? project(overlay.selected.longitude, overlay.selected.latitude) : null;
  const ordered = [...overlay.layers].sort((left, right) => geometryOrder(left.geometry) - geometryOrder(right.geometry));
  return (
    <g data-gloom-role="geo-layers">
      <g transform={transform}>
        {ordered.map((layer) => <GeoFeaturePaths key={layer.id} layer={layer} baseProject={baseProject} background={background} />)}
        {selectedFeature && selectedLayer && selectedLayer.geometry !== "point" ? (
          <path
            d={pathFor(featureLines(selectedFeature), baseProject, selectedLayer.geometry === "area")}
            fill="none"
            stroke={selectedColor}
            strokeWidth={2.6}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {trailPath ? (
          <path
            d={trailPath}
            fill="none"
            stroke={selectedColor}
            strokeWidth={1.6}
            strokeDasharray="3 3"
            strokeOpacity={0.85}
            vectorEffect="non-scaling-stroke"
            data-gloom-role="geo-trail"
          />
        ) : null}
      </g>
      {overlay.layers.flatMap((layer) => layer.clusters.map((cluster) => {
        const at = project(cluster.lon, cluster.lat);
        const numbered = mapWidth >= NUMBERED_CLUSTER_MIN_WIDTH;
        const radius = clusterRadius(cluster.count, numbered);
        return (
          <g key={`${layer.id}:${cluster.id}`} data-geo-cluster={layer.id}>
            <title>{`${cluster.count.toLocaleString("en-US")} ${layer.name.toLowerCase()}`}</title>
            <circle cx={at.x} cy={at.y} r={radius} fill={layer.color} fillOpacity={numbered ? 0.88 : 0.6} stroke={background} strokeWidth={0.14} />
            {!numbered ? null : createElement("text", {
              x: at.x,
              y: at.y,
              dy: "0.34em",
              fill: background,
              fontSize: Math.max(0.8, Math.min(1.3, radius * 0.72)),
              fontWeight: "700",
              fontFamily: "inherit",
              textAnchor: "middle",
              pointerEvents: "none",
            }, compactCount(cluster.count))}
          </g>
        );
      }))}
      {selectedAt && (!selectedLayer || selectedLayer.geometry === "point" || !selectedFeature) ? (
        <circle
          cx={selectedAt.x}
          cy={selectedAt.y}
          r={0.85}
          fill="none"
          stroke={selectedColor}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          data-gloom-role="geo-selected"
        />
      ) : null}
    </g>
  );
}

function geometryOrder(geometry: GeoMapLayer["geometry"]): number {
  return geometry === "area" ? 0 : geometry === "line" ? 1 : 2;
}

function compactCount(count: number): string {
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(count);
}

function cellLine(grid: string[][], from: WorldMapPoint, to: WorldMapPoint, glyph: string) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y))));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * step) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * step) / steps);
    const row = grid[y];
    if (!row || x < 0 || x >= row.length) continue;
    if (row[x] === " " || row[x] === ".") row[x] = glyph;
  }
}

/**
 * The terminal's reduced map: lines and area edges as dots, markers as
 * bullets, clusters as their count (9+ past nine), the selection as `@`.
 */
export function rasterGeoCells(grid: string[][], overlay: GeoMapOverlay, project: Project): void {
  for (const layer of overlay.layers) {
    if (layer.geometry === "point") continue;
    for (const feature of layer.features) {
      for (const line of featureLines(feature)) {
        for (let index = 1; index < line.length; index += 1) {
          const previous = line[index - 1]!;
          const current = line[index]!;
          if (Math.abs(current[0] - previous[0]) > 180) continue;
          cellLine(grid, project(previous[0], previous[1]), project(current[0], current[1]), layer.geometry === "area" ? "░" : "·");
        }
      }
    }
  }
  if (overlay.trail) {
    for (let index = 1; index < overlay.trail.length; index += 1) {
      cellLine(grid, project(overlay.trail[index - 1]![0], overlay.trail[index - 1]![1]), project(overlay.trail[index]![0], overlay.trail[index]![1]), "·");
    }
  }
  const place = (longitude: number, latitude: number, glyph: string) => {
    const at = project(longitude, latitude);
    const row = grid[Math.round(at.y)];
    const x = Math.round(at.x);
    if (row && x >= 0 && x < row.length) row[x] = glyph;
  };
  for (const layer of overlay.layers) {
    if (layer.geometry !== "point") continue;
    for (const feature of layer.features) {
      const [longitude, latitude] = featureAnchor(feature);
      place(longitude, latitude, "•");
    }
  }
  for (const layer of overlay.layers) {
    for (const cluster of layer.clusters) place(cluster.lon, cluster.lat, cluster.count > 9 ? "+" : String(cluster.count));
  }
  if (overlay.selected) place(overlay.selected.longitude, overlay.selected.latitude, "@");
}

/** The same layers on a terminal that draws pixels. */
export function drawGeoBitmap(bitmap: NativeChartBitmap, overlay: GeoMapOverlay, project: Project, selectedColor: string): void {
  const thickness = Math.max(1, bitmap.width / 700);
  for (const layer of overlay.layers) {
    const color = parseHex(layer.color, layer.geometry === "area" ? 0.7 : 0.95);
    if (layer.geometry === "point") {
      for (const feature of layer.features) {
        const [longitude, latitude] = featureAnchor(feature);
        const at = project(longitude, latitude);
        drawCircle(bitmap.pixels, bitmap.width, bitmap.height, at.x, at.y, Math.max(1.5, thickness * 1.6), color);
      }
    } else {
      for (const feature of layer.features) {
        for (const line of featureLines(feature)) {
          for (let index = 1; index < line.length; index += 1) {
            if (Math.abs(line[index]![0] - line[index - 1]![0]) > 180) continue;
            const from = project(line[index - 1]![0], line[index - 1]![1]);
            const to = project(line[index]![0], line[index]![1]);
            drawLine(bitmap.pixels, bitmap.width, bitmap.height, from.x, from.y, to.x, to.y, color, thickness);
          }
        }
      }
    }
    for (const cluster of layer.clusters) {
      const at = project(cluster.lon, cluster.lat);
      drawCircle(bitmap.pixels, bitmap.width, bitmap.height, at.x, at.y, Math.max(3, Math.min(12, 2.5 + Math.sqrt(cluster.count) * 0.9)), parseHex(layer.color, 0.9));
    }
  }
  const highlight = parseHex(selectedColor);
  if (overlay.trail) {
    for (let index = 1; index < overlay.trail.length; index += 1) {
      const from = project(overlay.trail[index - 1]![0], overlay.trail[index - 1]![1]);
      const to = project(overlay.trail[index]![0], overlay.trail[index]![1]);
      drawLine(bitmap.pixels, bitmap.width, bitmap.height, from.x, from.y, to.x, to.y, highlight, thickness);
    }
  }
  if (overlay.selected) {
    const at = project(overlay.selected.longitude, overlay.selected.latitude);
    drawCircle(bitmap.pixels, bitmap.width, bitmap.height, at.x, at.y, Math.max(4, thickness * 4), highlight);
  }
}
