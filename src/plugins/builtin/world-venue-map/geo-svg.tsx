/**
 * Geo layers on the desktop and web map, as SVG. Areas, lines, dots and icons
 * sit in degrees under the map's one transform, so a pan or a zoom changes an
 * attribute and a CSS variable instead of every feature. Icons keep their
 * pixel size through that transform with a counter-scale the group carries.
 * Clusters, the selection ring and the hover ring are placed in view units.
 */
import { createElement, memo, useMemo, type CSSProperties } from "react";
import type { GeoCluster, GeoFeature } from "../../../api-client/geo";
import type { GeoBox } from "./basemap";
import type { GeoHit, GeoMapLayer, GeoMapOverlay } from "./geo-draw";
import { featureAnchor, featureLines } from "./layers";
import {
  featureSymbol,
  iconDensityScale,
  MAP_SYMBOLS,
  pointStyle,
  usesClassTones,
  type MapSymbolId,
  type PointStyle,
  type SymbolTone,
} from "./map-symbols";
import type { WorldMapPoint } from "./model";

type Project = (longitude: number, latitude: number) => WorldMapPoint;

/** Degrees to view units: x = a * longitude + bx, y = by - a * latitude. */
export interface MapMatrix {
  a: number;
  bx: number;
  by: number;
}

/** Theme colours for the tones other than a layer's own. */
export type SymbolTones = Record<Exclude<SymbolTone, "layer">, string>;

export function matrixTransform(matrix: MapMatrix): string {
  return `matrix(${matrix.a} 0 0 ${matrix.a} ${matrix.bx} ${matrix.by})`;
}

/** The icon counter-scale lives here: degrees per screen pixel. */
const ICON_SCALE_VAR = "--gloom-map-icon";

export function toneColor(layer: Pick<GeoMapLayer, "color">, tone: SymbolTone, tones: SymbolTones): string {
  return tone === "layer" ? layer.color : tones[tone];
}

function inView(view: GeoBox, longitude: number, latitude: number): boolean {
  return longitude >= view[0] && longitude <= view[2] && latitude >= view[1] && latitude <= view[3];
}

/** How many of a point layer's features are on screen. */
function visibleFeatureCount(features: readonly GeoFeature[], view: GeoBox): number {
  let count = 0;
  for (const feature of features) {
    const [longitude, latitude] = featureAnchor(feature);
    if (inView(view, longitude, latitude)) count += 1;
  }
  return count;
}

/** A path through coordinate runs in degrees, broken where a run crosses the date line. */
function degreePath(lines: readonly (readonly (readonly [number, number])[])[], close: boolean): string {
  let path = "";
  for (const line of lines) {
    let previous: number | null = null;
    let drawing = false;
    for (const [longitude, latitude] of line) {
      if (previous !== null && Math.abs(longitude - previous) > 180) drawing = false;
      previous = longitude;
      path += `${drawing ? "L" : "M"}${longitude} ${-latitude}`;
      drawing = true;
    }
    if (close && drawing) path += "Z";
  }
  return path;
}

function turn(symbol: MapSymbolId, rotation: number | null): string {
  const angle = rotation ?? MAP_SYMBOLS[symbol].pose ?? null;
  return angle === null ? "" : ` rotate(${Math.round(angle)}deg)`;
}

function iconTransform(symbol: MapSymbolId, longitude: number, latitude: number, rotation: number | null, size: number): string {
  return `translate(${longitude}px, ${-latitude}px)${turn(symbol, rotation)} scale(var(${ICON_SCALE_VAR})) scale(${(size / 16).toFixed(4)})`;
}

interface IconProps {
  symbol: MapSymbolId;
  color: string;
  background: string;
  transform?: string;
}

/** One icon at the origin, or wherever `transform` puts it. */
function MapIcon({ symbol, color, background, transform }: IconProps) {
  const shape = MAP_SYMBOLS[symbol];
  const style: CSSProperties | undefined = transform ? { transform } : undefined;
  if (shape.paint === "fill") {
    return <path d={shape.d} fill={color} fillRule="evenodd" stroke={background} strokeWidth={2.2} strokeLinejoin="round" paintOrder="stroke" style={style} />;
  }
  return (
    <g style={style}>
      <path d={shape.d} fill="none" stroke={background} strokeWidth={4.2} strokeLinecap="round" strokeLinejoin="round" />
      <path d={shape.d} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

/** The legend's swatch: the real icon at its own size, in the layer's colour. */
export function MapIconSwatch({ symbol, color, background, size = 14 }: { symbol: MapSymbolId; color: string; background: string; size?: number }) {
  return createElement(
    "svg",
    { width: size, height: size, viewBox: "-9 -9 18 18", "aria-hidden": "true", style: { display: "block", overflow: "visible" } },
    <MapIcon symbol={symbol} color={color} background={background} transform={turn(symbol, null).trim() || undefined} />,
  );
}

interface PointLayerProps {
  layer: GeoMapLayer;
  style: PointStyle;
  /** Icon size against its own, smaller in a crowded view. */
  density: number;
  tones: SymbolTones;
  background: string;
}

const PointLayer = memo(function PointLayer({ layer, style, density, tones, background }: PointLayerProps) {
  // Ships at rest first, so the ones under way are drawn on top of an anchorage.
  const drawn = useMemo(() => layer.features.map((feature) => {
    const [longitude, latitude] = featureAnchor(feature);
    const symbol = featureSymbol(layer.id, feature);
    return { feature, longitude, latitude, symbol, color: toneColor(layer, symbol.tone, tones) };
  }).sort((left, right) => Number(left.symbol.rotation !== null) - Number(right.symbol.rotation !== null)), [layer, tones]);
  if (style === "dots") {
    // One path per colour of zero-length runs: round caps draw every dot the same size at any zoom.
    const byColor = new Map<string, string>();
    for (const item of drawn) byColor.set(item.color, `${byColor.get(item.color) ?? ""}M${item.longitude} ${-item.latitude}h0`);
    return (
      <g data-geo-layer={layer.id} data-geo-style="dots">
        {[...byColor].map(([color, d]) => (
          <g key={color}>
            <path d={d} fill="none" stroke={background} strokeWidth={6} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            <path d={d} fill="none" stroke={color} strokeWidth={4} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </g>
    );
  }
  return (
    <g data-geo-layer={layer.id} data-geo-style="icons">
      {drawn.map(({ feature, longitude, latitude, symbol, color }) => (
        <MapIcon
          key={feature.id}
          symbol={symbol.id}
          color={color}
          background={background}
          transform={iconTransform(symbol.id, longitude, latitude, symbol.rotation, MAP_SYMBOLS[symbol.id].size * symbol.scale * (MAP_SYMBOLS[symbol.id].landmark ? 1 : density))}
        />
      ))}
    </g>
  );
});

const ShapeLayer = memo(function ShapeLayer({ layer }: { layer: GeoMapLayer }) {
  const shapes = useMemo(() => layer.features.map((feature) => ({
    id: feature.id,
    d: degreePath(featureLines(feature), layer.geometry === "area"),
  })), [layer.features, layer.geometry]);
  const area = layer.geometry === "area";
  return (
    <g data-geo-layer={layer.id}>
      {shapes.map((shape) => (
        <path
          key={shape.id}
          d={shape.d}
          fill={area ? layer.color : "none"}
          fillOpacity={area ? 0.14 : undefined}
          stroke={layer.color}
          // Pipelines stay a quiet mesh under the icons; dense networks (the US Gulf Coast) would otherwise bury them.
          strokeOpacity={area ? 0.6 : 0.38}
          strokeWidth={area ? 1 : 0.9}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
});

/** An area narrower than this on screen gets its glyph, so a small field still reads. */
const AREA_MARK_MAX_PX = 48;

function degreeSpan(feature: GeoFeature): number {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const line of featureLines(feature)) {
    for (const [longitude, latitude] of line) {
      west = Math.min(west, longitude);
      east = Math.max(east, longitude);
      south = Math.min(south, latitude);
      north = Math.max(north, latitude);
    }
  }
  return Number.isFinite(west) ? Math.max(east - west, north - south) : 0;
}

/** Past this many marks in view, the fills alone say where the fields are; a pile of glyphs says nothing more. */
const AREA_MARK_MAX = 24;

/** Field glyphs sit on areas too small to see as shapes; a larger area speaks for itself. */
const AreaMarks = memo(function AreaMarks({ layer, background, pxPerDegree, view }: { layer: GeoMapLayer; background: string; pxPerDegree: number; view: GeoBox }) {
  const spans = useMemo(() => new Map(layer.features.map((feature) => [feature.id, degreeSpan(feature)])), [layer.features]);
  const marks = layer.features.flatMap((feature) => {
    const symbol = featureSymbol(layer.id, feature);
    if (symbol.id === "dot" || (spans.get(feature.id) ?? 0) * pxPerDegree > AREA_MARK_MAX_PX) return [];
    const [longitude, latitude] = featureAnchor(feature);
    return inView(view, longitude, latitude) ? [{ feature, symbol, longitude, latitude }] : [];
  });
  if (marks.length > AREA_MARK_MAX) return null;
  return (
    <g data-geo-layer-marks={layer.id}>
      {marks.map(({ feature, symbol, longitude, latitude }) => (
        <MapIcon
          key={feature.id}
          symbol={symbol.id}
          color={layer.color}
          background={background}
          transform={iconTransform(symbol.id, longitude, latitude, null, MAP_SYMBOLS[symbol.id].size * 0.8)}
        />
      ))}
    </g>
  );
});

function geometryOrder(geometry: GeoMapLayer["geometry"]): number {
  return geometry === "area" ? 0 : geometry === "line" ? 1 : 2;
}

function compactCount(count: number): string {
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(count);
}

/** Share of each colour in a cluster, from the server's per-kind counts (ships by class). */
function clusterShares(layer: GeoMapLayer, cluster: GeoCluster, tones: SymbolTones): { color: string; share: number }[] {
  const kinds = cluster.kinds ? Object.entries(cluster.kinds) : [];
  const total = kinds.reduce((sum, [, count]) => sum + count, 0);
  if (!total || !usesClassTones(layer.id)) return [{ color: layer.color, share: 1 }];
  const byColor = new Map<string, number>();
  for (const [kind, count] of kinds) {
    const tone = featureSymbol(layer.id, { props: { class: kind } } as unknown as GeoFeature).tone;
    const color = toneColor(layer, tone, tones);
    byColor.set(color, (byColor.get(color) ?? 0) + count / total);
  }
  return [...byColor].map(([color, share]) => ({ color, share })).sort((left, right) => right.share - left.share);
}

interface ClusterBadgeProps {
  layer: GeoMapLayer;
  cluster: GeoCluster;
  at: WorldMapPoint;
  unitPx: number;
  /** A small map has no room for counts: the badge is a density disc. */
  numbered: boolean;
  tones: SymbolTones;
  background: string;
  textColor: string;
}

/** Below this width in pixels a cluster is a density disc; badges with counts would cover the map. */
const NUMBERED_CLUSTER_MIN_PX = 560;

/** A count badge: a dark disc, the count, and a ring split by what the cluster holds. */
function ClusterBadge({ layer, cluster, at, unitPx, numbered, tones, background, textColor }: ClusterBadgeProps) {
  const label = compactCount(cluster.count);
  const radiusPx = numbered
    ? Math.max(9, Math.min(19, 7 + Math.sqrt(cluster.count) * 0.42, 5 + label.length * 3.6))
    : Math.max(3.5, Math.min(9, 2.5 + Math.sqrt(cluster.count) * 0.12));
  const radius = radiusPx / unitPx;
  if (!numbered) {
    return (
      <g data-geo-cluster={layer.id}>
        <circle cx={at.x} cy={at.y} r={radius} fill={layer.color} fillOpacity={0.7} stroke={background} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </g>
    );
  }
  const ring = 2.4 / unitPx;
  const ringRadius = radius;
  const shares = clusterShares(layer, cluster, tones);
  const circumference = 2 * Math.PI * ringRadius;
  let offset = 0;
  return (
    <g data-geo-cluster={layer.id}>
      <circle cx={at.x} cy={at.y} r={radius + ring * 0.9} fill={background} fillOpacity={0.9} />
      {shares.map(({ color, share }) => {
        const length = share * circumference;
        const gap = shares.length > 1 ? ring * 0.5 : 0;
        const dash = `${Math.max(0, length - gap)} ${circumference}`;
        const segment = (
          <circle
            key={color}
            cx={at.x}
            cy={at.y}
            r={ringRadius}
            fill="none"
            stroke={color}
            strokeWidth={ring}
            strokeDasharray={dash}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${at.x} ${at.y})`}
          />
        );
        offset += length;
        return segment;
      })}
      {createElement("text", {
        x: at.x,
        y: at.y,
        dy: "0.35em",
        fill: textColor,
        fontSize: Math.min(11, 7 + radiusPx * 0.2) / unitPx,
        fontWeight: "600",
        fontFamily: "inherit",
        textAnchor: "middle",
        pointerEvents: "none",
      }, label)}
    </g>
  );
}

interface GeoSvgProps {
  overlay: GeoMapOverlay;
  matrix: MapMatrix;
  /** Projection at the current view, for what is placed in view units. */
  project: Project;
  /** What the map shows, west, south, east, north. */
  view: GeoBox;
  /** Screen pixels per view unit. */
  unitPx: number;
  /** The map's width on screen. */
  mapWidthPx: number;
  background: string;
  selectedColor: string;
  textColor: string;
  tones: SymbolTones;
  hovered: GeoHit | null;
}

/** The geo layers, drawn under the venue markers. */
export function GeoSvgLayers({ overlay, matrix, project, view, unitPx, mapWidthPx, background, selectedColor, textColor, tones, hovered }: GeoSvgProps) {
  const ordered = [...overlay.layers].sort((left, right) => geometryOrder(left.geometry) - geometryOrder(right.geometry));
  const selectedLayer = overlay.selected ? overlay.layers.find((layer) => layer.id === overlay.selected!.layerId) ?? null : null;
  const selectedFeature = selectedLayer?.features.find((feature) => feature.id === overlay.selected!.id) ?? null;
  const pxPerDegree = matrix.a * unitPx;
  const iconScale = { [ICON_SCALE_VAR]: 1 / Math.max(pxPerDegree, Number.EPSILON) } as CSSProperties;
  const trailPath = overlay.trail && overlay.trail.length > 1 ? degreePath([overlay.trail], false) : null;
  const points = new Map(overlay.layers.filter((layer) => layer.geometry === "point").map((layer) => {
    const landmark = layer.features.length > 0 && MAP_SYMBOLS[featureSymbol(layer.id, layer.features[0]!).id].landmark === true;
    const visible = landmark ? 0 : visibleFeatureCount(layer.features, view);
    return [layer.id, { style: pointStyle(landmark, visible), density: iconDensityScale(visible, mapWidthPx) }] as const;
  }));
  const selectedPoint = selectedLayer?.geometry === "point" || !selectedFeature;
  const selectedAt = overlay.selected ? project(overlay.selected.longitude, overlay.selected.latitude) : null;
  const selectedSymbol = selectedFeature && selectedLayer?.geometry === "point" ? featureSymbol(selectedLayer.id, selectedFeature) : null;
  const selectedIcons = selectedSymbol ? points.get(selectedLayer!.id)?.style === "icons" : false;
  // The selected icon is drawn again on top, at full size whatever the crowd.
  const selectedSize = selectedSymbol && selectedIcons ? MAP_SYMBOLS[selectedSymbol.id].size * selectedSymbol.scale : 8;
  const hoverFeature = hovered?.kind === "feature" ? hovered : null;
  const hoverLayer = hoverFeature ? overlay.layers.find((layer) => layer.id === hoverFeature.layerId) ?? null : null;
  const hoverAt = hoverFeature && hoverLayer?.geometry === "point"
    ? project(...featureAnchor(hoverFeature.feature))
    : null;
  return (
    <g data-gloom-role="geo-layers">
      <g transform={matrixTransform(matrix)} style={iconScale}>
        {ordered.map((layer) => layer.geometry === "point"
          ? (
            <PointLayer
              key={layer.id}
              layer={layer}
              style={points.get(layer.id)?.style ?? "dots"}
              density={points.get(layer.id)?.density ?? 1}
              tones={tones}
              background={background}
            />
          )
          : <ShapeLayer key={layer.id} layer={layer} />)}
        {ordered.filter((layer) => layer.geometry === "area").map((layer) => (
          <AreaMarks key={`marks:${layer.id}`} layer={layer} background={background} pxPerDegree={pxPerDegree} view={view} />
        ))}
        {selectedFeature && selectedLayer && selectedLayer.geometry !== "point" ? (
          <path
            d={degreePath(featureLines(selectedFeature), selectedLayer.geometry === "area")}
            fill="none"
            stroke={selectedColor}
            strokeWidth={2.4}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {trailPath ? (
          // Over the other icons, on a dark casing, so the track reads through a crowded anchorage.
          <g data-gloom-role="geo-trail">
            <path d={trailPath} fill="none" stroke={background} strokeOpacity={0.85} strokeWidth={4.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            <path d={trailPath} fill="none" stroke={selectedColor} strokeWidth={1.6} strokeDasharray="4 3" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>
        ) : null}
        {selectedFeature && selectedSymbol && selectedIcons ? (
          // The selected icon again, on top of its neighbours.
          <MapIcon
            symbol={selectedSymbol.id}
            color={toneColor(selectedLayer!, selectedSymbol.tone, tones)}
            background={background}
            transform={iconTransform(selectedSymbol.id, ...featureAnchor(selectedFeature), selectedSymbol.rotation, selectedSize)}
          />
        ) : null}
      </g>
      {overlay.layers.flatMap((layer) => layer.clusters.map((cluster) => (
        <ClusterBadge
          key={`${layer.id}:${cluster.id}`}
          layer={layer}
          cluster={cluster}
          at={project(cluster.lon, cluster.lat)}
          unitPx={unitPx}
          numbered={mapWidthPx >= NUMBERED_CLUSTER_MIN_PX}
          tones={tones}
          background={background}
          textColor={textColor}
        />
      )))}
      {hoverAt && !(selectedFeature && hoverFeature?.feature.id === selectedFeature.id) ? (
        <circle cx={hoverAt.x} cy={hoverAt.y} r={(selectedSize / 2 + 4) / unitPx} fill="none" stroke={textColor} strokeOpacity={0.6} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ) : null}
      {selectedAt && selectedPoint ? (
        <g data-gloom-role="geo-selected">
          <circle cx={selectedAt.x} cy={selectedAt.y} r={(selectedSize / 2 + 5) / unitPx} fill={selectedColor} fillOpacity={0.12} stroke={background} strokeWidth={4} vectorEffect="non-scaling-stroke" />
          <circle cx={selectedAt.x} cy={selectedAt.y} r={(selectedSize / 2 + 5) / unitPx} fill="none" stroke={selectedColor} strokeWidth={1.8} vectorEffect="non-scaling-stroke" />
        </g>
      ) : null}
    </g>
  );
}
