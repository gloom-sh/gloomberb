import {
  zoneScaleBands,
  zoneScaleFraction,
  type IndicatorDef,
  type ZoneScaleBand,
} from "../defs";

export interface ZoneScaleProps {
  indicator: IndicatorDef;
  value: number;
  width: number;
  markerColor: string;
}

export interface ZoneScaleTick {
  label: string;
  fraction: number;
}

export interface ZoneScaleGeometry {
  bands: Array<ZoneScaleBand & { from: number; to: number; startFraction: number; endFraction: number }>;
  markerFraction: number;
  ticks: ZoneScaleTick[];
  underLabel: string;
  overLabel: string;
  fairLabel: string;
}

/** Captions and ticks thin out as the pane narrows so the bar never overprints itself. */
export function zoneScaleGeometry(
  indicator: IndicatorDef,
  value: number,
  width: number,
): ZoneScaleGeometry {
  const raw = zoneScaleBands(indicator);
  const count = raw.length;
  const bands = raw.map((band, index) => ({
    ...band,
    startFraction: index / count,
    endFraction: (index + 1) / count,
  }));

  const allTicks = indicator.zoneScale.ticks;
  const keep = width >= 40
    ? allTicks
    : allTicks.filter((tick, index) =>
      index === 0 || index === allTicks.length - 1 || tick === indicator.reference?.value);

  return {
    bands,
    markerFraction: zoneScaleFraction(indicator, value),
    ticks: keep.map((tick) => ({
      label: indicator.formatValue(tick),
      fraction: zoneScaleFraction(indicator, tick),
    })),
    underLabel: width >= 48 ? "undervalued" : width >= 28 ? "under" : "",
    overLabel: width >= 48 ? "overvalued" : width >= 28 ? "over" : "",
    fairLabel: width >= 64 ? "fair" : "",
  };
}
