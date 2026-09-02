import { blendHex, colors } from "../../../theme/colors";

export type ValuationRangeId = "10Y" | "25Y" | "ALL";

/** Columns of Shiller's monthly dataset the pane can chart. */
export type ShillerField =
  | "price"
  | "dividend"
  | "earnings"
  | "cpi"
  | "longRate"
  | "cape"
  | "excessCapeYield";

/**
 * Every leg resolves through the Gloom Cloud proxy. Nothing here talks to Yahoo or
 * FRED directly, which is what lets the pane run in the hosted browser build.
 */
export type SeriesSource =
  | { kind: "fred"; seriesId: string; limit: number }
  | { kind: "market-history"; symbol: string; exchange: string; startDate: string }
  | { kind: "shiller"; field: ShillerField };

export interface SeriesDef {
  /** Stable identity for caching and for de-duplicating legs shared by indicators. */
  key: string;
  /** Multiplier that brings a raw observation into billions of dollars. */
  scaleToBillions: number;
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

/**
 * Upper edge of a valuation band, in the indicator's own units, ascending.
 * `max: null` is the open top band. Bands carry their own id, so an indicator
 * where a high reading means cheap (a yield spread) simply lists them in the
 * opposite order rather than needing an inversion flag.
 */
export interface ZoneBand {
  max: number | null;
  id: ValuationZoneId;
  label: string;
}

export interface ZoneScaleBand {
  id: ValuationZoneId;
  from: number;
  to: number;
  color: string;
}

/** A ratio of two series, or a single series that is already the measure. */
export type IndicatorInput =
  | {
    kind: "ratio";
    numerator: SeriesDef;
    denominator: SeriesDef;
    /**
     * Set only when both legs are dollar amounts worth showing. A ratio of two
     * index columns has no meaningful level to print, so it omits this.
     */
    levels?: { numeratorLabel: string; denominatorLabel: string };
  }
  | { kind: "direct"; series: SeriesDef };

export interface IndicatorDef {
  id: string;
  /** Full name for the detail heading and catalog copy. */
  label: string;
  /** Fits the summary table's INDICATOR column. */
  shortLabel: string;
  description: string;
  input: IndicatorInput;
  /** Multiplies the raw value: 100 renders a quotient as a percent. */
  ratioScale: number;
  formatValue: (value: number) => string;
  zones: readonly ZoneBand[];
  zoneScale: {
    min: number;
    max: number;
    /** Band edges, low to high, from `min` to `max`. Each band gets equal width. */
    edges: readonly number[];
    ticks: readonly number[];
  };
  /** Horizontal line drawn on the chart, e.g. Buffett's 100% parity. */
  reference: { value: number; label: string } | null;
  /** Y-axis gridline spacing, in the indicator's own units. */
  chartGridStep: number;
  /**
   * Log-linear suits a level that compounds. A measure that can sit at or below
   * zero, like an excess yield, needs the linear fit.
   */
  trendModel: "log" | "linear";
  /** How old the newest observation may get before the pane flags it stale. */
  staleAfterMs: number;
  notes: string[];
  link: { url: string; label: string } | null;
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export const RANGE_WINDOWS_MS: { readonly [K in ValuationRangeId]: number | null } = {
  "10Y": 10 * MS_PER_YEAR,
  "25Y": 25 * MS_PER_YEAR,
  ALL: null,
};

export function zoneColor(id: ValuationZoneId): string {
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

/** Column-width form of the zone name for the summary table. */
export function shortZoneLabel(id: ValuationZoneId): string {
  switch (id) {
    case "significantly-undervalued":
      return "Sig. under";
    case "modestly-undervalued":
      return "Under";
    case "fair":
      return "Fair";
    case "modestly-overvalued":
      return "Over";
    case "significantly-overvalued":
      return "Sig. over";
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

/**
 * True when a bigger number means a more expensive market. A yield-shaped measure
 * runs the other way, and lists its bands starting at overvalued to say so. The
 * summary table uses this to put every row on one "expensive" scale, so a column
 * can be read straight down.
 */
export function higherIsExpensive(indicator: IndicatorDef): boolean {
  return indicator.zones[0]?.id !== "significantly-overvalued";
}

export function classifyZone(indicator: IndicatorDef, value: number): ZoneHit {
  for (const band of indicator.zones) {
    if (band.max == null || value < band.max) {
      return { id: band.id, label: band.label, color: zoneColor(band.id) };
    }
  }
  const last = indicator.zones[indicator.zones.length - 1]!;
  return { id: last.id, label: last.label, color: zoneColor(last.id) };
}

export function zoneScaleBands(indicator: IndicatorDef): ZoneScaleBand[] {
  const { min, max } = indicator.zoneScale;
  let from = min;
  return indicator.zones.map((band) => {
    const to = band.max == null ? max : band.max;
    const entry = { id: band.id, from, to, color: zoneColor(band.id) };
    from = band.max ?? from;
    return entry;
  });
}

/**
 * Position a value on the scale as a 0..1 fraction. Each valuation band gets equal
 * width so fair sits near the visual center instead of being pushed to one side by
 * a long open-ended band.
 */
export function zoneScaleFraction(indicator: IndicatorDef, value: number): number {
  const edges = indicator.zoneScale.edges;
  const bands = edges.length - 1;
  if (bands <= 0) return 0;
  const { min, max } = indicator.zoneScale;
  const clamped = Math.max(min, Math.min(max, value));
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
  return (bandIdx + t) / bands;
}

/** Inverse of zoneScaleFraction: scale position back to the indicator's units. */
export function zoneScaleValueAt(indicator: IndicatorDef, fraction: number): number {
  const edges = indicator.zoneScale.edges;
  const bands = edges.length - 1;
  if (bands <= 0) return 0;
  const pos = Math.min(bands, Math.max(0, fraction * bands));
  const bandIdx = Math.min(bands - 1, Math.floor(pos));
  const lo = edges[bandIdx]!;
  const hi = edges[bandIdx + 1]!;
  return lo + (pos - bandIdx) * (hi - lo);
}

export function zoneScaleMarkerColumn(
  indicator: IndicatorDef,
  value: number,
  width: number,
): number {
  if (width <= 1) return 0;
  return Math.round(zoneScaleFraction(indicator, value) * (width - 1));
}

export function zoneScaleColumnValue(
  indicator: IndicatorDef,
  column: number,
  width: number,
): number {
  if (width <= 1) return 0;
  return zoneScaleValueAt(indicator, column / Math.max(width - 1, 1));
}

/** Every leg an indicator needs, so callers can fetch without knowing its shape. */
export function indicatorSeries(indicator: IndicatorDef): SeriesDef[] {
  return indicator.input.kind === "ratio"
    ? [indicator.input.numerator, indicator.input.denominator]
    : [indicator.input.series];
}
