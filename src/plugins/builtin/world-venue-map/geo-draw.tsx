/**
 * Geo layers on the world map: the model both renderers draw, the hit test
 * they share, and the terminal's cells and bitmap. The desktop and web draw the
 * same layers as SVG in `geo-svg.tsx`. Everything is placed with the venue
 * map's own projection, so pan and zoom move the layers too.
 */
import type { GeoCluster, GeoFeature } from "../../../api-client/geo";
import { drawCircle, drawLine, parseHex } from "../../../components/chart/native/raster/primitives";
import type { NativeChartBitmap } from "../../../components/chart/native/chart-rasterizer";
import { featureAnchor, featureLines } from "./layers";
import { featureSymbol, MAP_SYMBOLS } from "./map-symbols";
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

/**
 * Four hues as far apart as the map's four layers can be; green stays the
 * venues'. Violet comes second so the layer beside ships never reads as their
 * amber tankers.
 */
const DARK_PALETTE = ["#4dabf7", "#e599f7", "#ffa94d", "#ffe066"];
const LIGHT_PALETTE = ["#1971c2", "#ae3ec9", "#d9480f", "#b08800"];

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

/** A ship's class or a layer's icon as one terminal cell; anything unknown is a bullet. */
export function cellGlyph(layerId: string, feature: GeoFeature): string {
  const symbol = featureSymbol(layerId, feature);
  if (symbol.id === "ship" || symbol.id === "ship-small" || symbol.id === "ship-other" || symbol.id === "ship-still") {
    return SHIP_CELLS[symbol.tone] ?? "•";
  }
  return MAP_SYMBOLS[symbol.id].cell || "•";
}

const SHIP_CELLS: Partial<Record<string, string>> = {
  tanker: "●",
  layer: "■",
  passenger: "○",
  fishing: "▪",
  service: "▫",
  other: "•",
};

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
 * The terminal's reduced map: lines and area edges as dots, markers as their
 * icon's cell glyph (a ship's by its class), clusters as their count (`+` past
 * nine), the selection as `@`.
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
      place(longitude, latitude, cellGlyph(layer.id, feature));
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
