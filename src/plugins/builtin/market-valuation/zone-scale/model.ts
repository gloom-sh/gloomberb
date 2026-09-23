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
  /** Caption over the low end of the scale; "overvalued" when the bands run expensive to cheap. */
  leftLabel: string;
  rightLabel: string;
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

  // Some measures (dividend yield, excess CAPE yield) are cheaper when higher, so
  // their bands start at overvalued and the end captions swap with them.
  const inverted = raw[0]?.id.endsWith("overvalued") ?? false;
  const underLabel = width >= 48 ? "undervalued" : width >= 28 ? "under" : "";
  const overLabel = width >= 48 ? "overvalued" : width >= 28 ? "over" : "";

  return {
    bands,
    markerFraction: zoneScaleFraction(indicator, value),
    ticks: keep.map((tick) => ({
      label: indicator.formatValue(tick),
      fraction: zoneScaleFraction(indicator, tick),
    })),
    leftLabel: inverted ? overLabel : underLabel,
    rightLabel: inverted ? underLabel : overLabel,
    fairLabel: width >= 64 ? "fair" : "",
  };
}
