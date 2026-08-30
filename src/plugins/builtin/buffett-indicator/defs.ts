import type { FredSeriesRequest } from "../../../data/fred-series";
import { blendHex, colors } from "../../../theme/colors";

export type BuffettRangeId = "10Y" | "25Y" | "ALL";

export type SeriesSource =
  | { kind: "fred" }
  | { kind: "yahoo-index"; symbol: string };

export interface SeriesDef {
  seriesId: string;
  scaleToBillions: number;
  request: Pick<FredSeriesRequest, "limit" | "sortOrder">;
  source: SeriesSource;
}

export type ValuationZoneId =
  | "significantly-undervalued"
  | "modestly-undervalued"
  | "fair"
  | "modestly-overvalued"
  | "significantly-overvalued";

export interface ZoneHit {
  id: ValuationZoneId;
  label: string;
  color: string;
}

export interface ZoneScaleBand {
  from: number;
  to: number;
  color: string;
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export const GDP: SeriesDef = {
  seriesId: "GDP",
  scaleToBillions: 1,
  request: { limit: 340, sortOrder: "desc" },
  source: { kind: "fred" },
};

export const WILSHIRE_NUMERATOR: SeriesDef = {
  seriesId: "WILL5000PRFC",
  scaleToBillions: 1,
  request: { limit: 10000, sortOrder: "desc" },
  source: { kind: "yahoo-index", symbol: "^W5000" },
};

export const BUFFETT_SERIES_DEFS: readonly SeriesDef[] = [WILSHIRE_NUMERATOR, GDP];

export const BUFFETT_STALE_AFTER_MS = 5 * 24 * 60 * 60 * 1000;

export const RANGE_WINDOWS_MS: { readonly [K in BuffettRangeId]: number | null } = {
  "10Y": 10 * MS_PER_YEAR,
  "25Y": 25 * MS_PER_YEAR,
  ALL: null,
};

export const ZONE_TABLE: readonly {
  max: number | null;
  id: ValuationZoneId;
  label: string;
}[] = [
  { max: 75, id: "significantly-undervalued", label: "Significantly Undervalued" },
  { max: 90, id: "modestly-undervalued", label: "Modestly Undervalued" },
  { max: 115, id: "fair", label: "Fair Valued" },
  { max: 135, id: "modestly-overvalued", label: "Modestly Overvalued" },
  { max: null, id: "significantly-overvalued", label: "Significantly Overvalued" },
];

/** Market cap equal to one year of GDP — baseline, not a sample average. */
export const PARITY_RATIO = 100;

export const ZONE_SCALE_MAX = 250;

/** Ratio edges for the five valuation bands on the color scale. */
export const ZONE_SCALE_EDGES = [0, 75, 90, 115, 135, ZONE_SCALE_MAX] as const;

export const ZONE_SCALE_TICKS = [0, 75, 100, 135, ZONE_SCALE_MAX] as const;

function zoneColor(id: ValuationZoneId): string {
  switch (id) {
    case "significantly-undervalued":
      return blendHex(colors.positive, "#000000", 0.2);
    case "modestly-undervalued":
      return colors.positive;
    case "fair":
      return colors.textBright;
    case "modestly-overvalued":
      return blendHex(colors.warning, colors.negative, 0.25);
    case "significantly-overvalued":
      return blendHex(colors.negative, "#000000", 0.2);
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

export function zoneScaleBands(max: number = ZONE_SCALE_MAX): ZoneScaleBand[] {
  let from = 0;
  return ZONE_TABLE.map((row) => {
    const to = row.max == null ? max : row.max;
    const band = { from, to, color: zoneColor(row.id) };
    from = row.max ?? from;
    return band;
  });
}

/**
 * Map a ratio onto the color-scale column axis.
 * Each valuation band gets equal width so fair (~100) sits near the visual center
 * instead of being pushed left by the long 135–250 overvalued span.
 */
export function zoneScaleMarkerColumn(value: number, width: number, max: number = ZONE_SCALE_MAX): number {
  if (width <= 1) return 0;
  const edges = zoneScaleEdges(max);
  const bands = edges.length - 1;
  const clamped = Math.max(0, Math.min(max, value));
  let bandIdx = bands - 1;
  for (let i = 0; i < bands; i += 1) {
    if (clamped < edges[i + 1]! || i === bands - 1) {
      bandIdx = i;
      break;
    }
  }
  const lo = edges[bandIdx]!;
  const hi = edges[bandIdx + 1]!;
  const t = hi === lo ? 0 : (clamped - lo) / (hi - lo);
  const seg = (width - 1) / bands;
  return Math.round(bandIdx * seg + t * seg);
}

/** Inverse of zoneScaleMarkerColumn: column → ratio for painting equal-width bands. */
export function zoneScaleColumnRatio(column: number, width: number, max: number = ZONE_SCALE_MAX): number {
  if (width <= 1) return 0;
  const edges = zoneScaleEdges(max);
  const bands = edges.length - 1;
  const pos = (column / Math.max(width - 1, 1)) * bands;
  const bandIdx = Math.min(bands - 1, Math.max(0, Math.floor(pos)));
  const t = Math.min(1, Math.max(0, pos - bandIdx));
  const lo = edges[bandIdx]!;
  const hi = edges[bandIdx + 1]!;
  return lo + t * (hi - lo);
}

function zoneScaleEdges(max: number): number[] {
  if (max === ZONE_SCALE_MAX) return [...ZONE_SCALE_EDGES];
  return [0, 75, 90, 115, 135, max];
}

export function classifyZone(ratio: number): ZoneHit {
  for (const row of ZONE_TABLE) {
    if (row.max == null || ratio < row.max) {
      return { id: row.id, label: row.label, color: zoneColor(row.id) };
    }
  }
  const last = ZONE_TABLE[ZONE_TABLE.length - 1]!;
  return { id: last.id, label: last.label, color: zoneColor(last.id) };
}

export function seriesRequest(def: SeriesDef): FredSeriesRequest {
  return { seriesId: def.seriesId, limit: def.request.limit, sortOrder: def.request.sortOrder };
}
