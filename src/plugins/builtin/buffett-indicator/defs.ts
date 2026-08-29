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

export const ZONE_SCALE_TICKS = [0, 75, 100, 135, ZONE_SCALE_MAX] as const;

function zoneColor(id: ValuationZoneId): string {
  switch (id) {
    case "significantly-undervalued":
      return colors.positive;
    case "modestly-undervalued":
      return blendHex(colors.bg, colors.positive, 0.55);
    case "fair":
      return colors.textBright;
    case "modestly-overvalued":
      return colors.warning;
    case "significantly-overvalued":
      return colors.negative;
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

export function zoneScaleMarkerColumn(value: number, width: number, max: number = ZONE_SCALE_MAX): number {
  if (width <= 1) return 0;
  const clamped = Math.max(0, Math.min(max, value));
  return Math.round((clamped / max) * (width - 1));
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
