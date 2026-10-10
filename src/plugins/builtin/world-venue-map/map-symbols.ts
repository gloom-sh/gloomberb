/**
 * The map's icons: one shared set every point layer picks from by layer id,
 * then by entity kind, and a plain dot for anything else, so a layer the
 * server adds without an app release still draws. Each icon is a path in a
 * 16-unit box centred on the feature and pointing north; the desktop and web
 * draw it as SVG, the terminal uses its cell glyph.
 */
import type { GeoFeature } from "../../../api-client/geo";

export type MapSymbolId =
  | "ship"
  | "ship-small"
  | "ship-other"
  | "ship-still"
  | "port"
  | "airport"
  | "aircraft"
  | "terminal"
  | "field"
  | "chokepoint"
  | "dot";

export interface MapSymbol {
  /** Path in a 16-unit box centred on the anchor, pointing north. */
  d: string;
  /** Solid shapes are filled; line art is stroked. */
  paint: "fill" | "stroke";
  /** Drawn size in pixels of the 16-unit box. */
  size: number;
  /** Few, large features (a strait, an LNG terminal) stay icons at any density. */
  landmark?: boolean;
  /** Degrees it is drawn turned when nothing gives it a heading: the airport sign's plane flies north-east. */
  pose?: number;
  /** What the terminal draws in the cell. */
  cell: string;
}

const HULL = "M0 -8C2.4 -5.4 3.4 -2.6 3.4 0.6V6.4Q3.4 7.6 2.2 7.6H-2.2Q-3.4 7.6 -3.4 6.4V0.6C-3.4 -2.6 -2.4 -5.4 0 -8Z";

export const MAP_SYMBOLS: Record<MapSymbolId, MapSymbol> = {
  ship: { d: HULL, paint: "fill", size: 13, cell: "■" },
  "ship-small": { d: HULL, paint: "fill", size: 10, cell: "▪" },
  "ship-other": { d: "M0 -7.5L5 6.5L0 3.6L-5 6.5Z", paint: "fill", size: 10, cell: "•" },
  "ship-still": { d: "M0 -3.6A3.6 3.6 0 1 1 0 3.6A3.6 3.6 0 1 1 0 -3.6Z", paint: "fill", size: 10, cell: "•" },
  port: {
    d: "M0 -4.2V6.6M-3.2 -2.2H3.2M-5.6 1.6Q-5 6.4 0 6.6Q5 6.4 5.6 1.6M-5.6 1.6L-6.8 3.2M5.6 1.6L6.8 3.2M0 -7.6A1.7 1.7 0 1 1 0 -4.2A1.7 1.7 0 1 1 0 -7.6Z",
    paint: "stroke",
    size: 14,
    cell: "□",
  },
  airport: {
    d: "M0 -8C0.8 -8 1.2 -7.2 1.2 -6.2V-2.4L7.6 1.6V3.4L1.2 1.4V5L3.2 6.6V8L0 7.1L-3.2 8V6.6L-1.2 5V1.4L-7.6 3.4V1.6L-1.2 -2.4V-6.2C-1.2 -7.2 -0.8 -8 0 -8Z",
    paint: "fill",
    size: 13,
    pose: 45,
    cell: "×",
  },
  aircraft: {
    d: "M0 -8C0.8 -8 1.2 -7.2 1.2 -6.2V-2.4L7.6 1.6V3.4L1.2 1.4V5L3.2 6.6V8L0 7.1L-3.2 8V6.6L-1.2 5V1.4L-7.6 3.4V1.6L-1.2 -2.4V-6.2C-1.2 -7.2 -0.8 -8 0 -8Z",
    paint: "fill",
    size: 13,
    cell: "^",
  },
  // A storage tank: a dome on a base, split by a band.
  terminal: {
    d: "M-6.4 7.4V-0.6C-6.4 -7.4 6.4 -7.4 6.4 -0.6V7.4ZM-7 1.2H7V3H-7Z",
    paint: "fill",
    size: 14,
    landmark: true,
    cell: "▲",
  },
  // A drop of oil.
  field: {
    d: "M0 -8C2.6 -4.2 5.6 -0.6 5.6 2.6A5.6 5.6 0 0 1 -5.6 2.6C-5.6 -0.6 -2.6 -4.2 0 -8Z",
    paint: "fill",
    size: 12,
    landmark: true,
    cell: "",
  },
  // Two banks closing on a passage.
  chokepoint: {
    d: "M-7.6 -5.4L-0.9 0L-7.6 5.4ZM7.6 -5.4L0.9 0L7.6 5.4Z",
    paint: "fill",
    size: 13,
    landmark: true,
    cell: "◆",
  },
  dot: { d: "M0 -3.4A3.4 3.4 0 1 1 0 3.4A3.4 3.4 0 1 1 0 -3.4Z", paint: "fill", size: 11, cell: "•" },
};

/** Ship classes as the layer names them, lower case; anything else reads as other. */
export type ShipClass = "tanker" | "cargo" | "passenger" | "fishing" | "tug and special" | "other";

/** Colour roles; the map turns them into theme colours, the layer's own colour first. */
export type SymbolTone = "layer" | "tanker" | "passenger" | "fishing" | "service" | "other";

export interface FeatureSymbol {
  id: MapSymbolId;
  /** Degrees clockwise from north, or null for an icon that does not turn. */
  rotation: number | null;
  tone: SymbolTone;
  /** Size relative to the icon's own, for a feature that matters more (a large airport). */
  scale: number;
}

type SymbolRule = (feature: GeoFeature) => FeatureSymbol;

/** Making way at a knot or more, with a course to point along. */
const MOVING_KNOTS = 1;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function shipClass(feature: Pick<GeoFeature, "props">): ShipClass {
  const value = typeof feature.props.class === "string" ? feature.props.class.trim().toLowerCase() : "";
  switch (value) {
    case "tanker":
    case "cargo":
    case "passenger":
    case "fishing":
    case "tug and special":
      return value;
    default:
      return "other";
  }
}

const SHIP_TONES: Record<ShipClass, SymbolTone> = {
  tanker: "tanker",
  cargo: "layer",
  passenger: "passenger",
  fishing: "fishing",
  "tug and special": "service",
  other: "other",
};

const ship: SymbolRule = (feature) => {
  const kind = shipClass(feature);
  const speed = finite(feature.props.speedKn);
  const course = finite(feature.props.courseDeg);
  const tone = SHIP_TONES[kind];
  // AIS reports 360 for "no course".
  if (speed === null || speed < MOVING_KNOTS || course === null || course < 0 || course >= 360) {
    return { id: "ship-still", rotation: null, tone, scale: kind === "other" || kind === "tug and special" || kind === "fishing" ? 0.8 : 1 };
  }
  const id: MapSymbolId = kind === "other" ? "ship-other" : kind === "fishing" || kind === "tug and special" ? "ship-small" : "ship";
  return { id, rotation: course, tone, scale: 1 };
};

const fixed = (id: MapSymbolId, scale = 1): FeatureSymbol => ({ id, rotation: null, tone: "layer", scale });

const RULES: Record<string, SymbolRule> = {
  vessel: ship,
  chokepoint: () => fixed("chokepoint"),
  port: () => fixed("port"),
  // The airport sign, smaller for a medium airport.
  airport: (feature) => ({ id: "airport", rotation: null, tone: "layer", scale: String(feature.props.size).toLowerCase() === "large" ? 1 : 0.8 }),
  flight: (feature) => {
    const heading = finite(feature.props.headingDeg);
    return { id: "aircraft", rotation: heading !== null && heading >= 0 && heading < 360 ? heading : null, tone: "layer", scale: 1 };
  },
  terminal: () => fixed("terminal"),
  field: () => fixed("field"),
};

/** The layer registry: layer ids the app knows, then the kinds their entities carry. */
const LAYER_KINDS: Record<string, string> = {
  vessels: "vessel",
  chokepoints: "chokepoint",
  ports: "port",
  airports: "airport",
  flights: "flight",
  terminals: "terminal",
  "oil-gas-fields": "field",
};

const DOT: FeatureSymbol = fixed("dot");

/** Whether a layer colours its features by class (ships), beyond its own colour. */
export function usesClassTones(layerId: string): boolean {
  return LAYER_KINDS[layerId] === "vessel";
}

/** The icon a feature draws: by its layer, then its entity kind, else a dot. */
export function featureSymbol(layerId: string, feature: GeoFeature): FeatureSymbol {
  const rule = RULES[LAYER_KINDS[layerId] ?? ""] ?? RULES[feature.entityKind];
  return rule ? rule(feature) : DOT;
}

/** The icon that stands for a layer in the legend: what most of its features draw. */
export function layerSymbol(layerId: string, sample: GeoFeature | undefined): MapSymbolId {
  const kind = LAYER_KINDS[layerId] ?? sample?.entityKind ?? "";
  if (kind === "vessel") return "ship";
  if (kind === "airport") return "airport";
  if (kind === "flight") return "aircraft";
  const rule = RULES[kind];
  return rule && sample ? rule(sample).id : rule ? (kind as MapSymbolId) : "dot";
}

/**
 * Past this many features in view a point layer draws plain dots: icons that
 * dense overlap into clumps, and each pan step costs more. Measured on the
 * ships layer over the South China Sea at 1440 px: 1,300 icons took 12 ms of
 * main thread per pan step against 8 ms as dots, so 900 keeps a machine twice
 * as slow inside a 60 fps frame.
 */
export const ICON_MAX_VISIBLE = 900;

export type PointStyle = "icons" | "dots";

export function pointStyle(landmark: boolean, visible: number): PointStyle {
  return landmark || visible <= ICON_MAX_VISIBLE ? "icons" : "dots";
}

/** Icons shrink as more share the view, and on a small map, so a crowded anchorage stays readable. */
export function iconDensityScale(visible: number, mapWidthPx = Infinity): number {
  const crowd = visible <= 150 ? 1 : visible <= 450 ? 0.85 : 0.72;
  return mapWidthPx < 560 ? crowd * 0.8 : crowd;
}
