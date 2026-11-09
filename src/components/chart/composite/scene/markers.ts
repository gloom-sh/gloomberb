// Markers on a composite chart scene's panels: the last price, the previous
// close and the volume profile.
import type { ResolvedSeries } from "../../../../time-series/types";
import type { CompositePanelScene, CompositeProjectedPoint } from "../types";
import { isFiniteNumber } from "../../../../utils/guards";
import { volumeProfile } from "../../../../time-series/trader-studies";
import { normalizedSourcePoints } from "./points";
import { projectCompositeValue } from "./projection";

/**
 * Unit groups a price can wear, raw or transformed. Volume, oscillators and
 * other derived study outputs are deliberately absent: a level line there
 * would mark a quantity that has no last price to read.
 */
const PRICE_UNIT_GROUPS = /^(?:price|currency|percent|index|log)(?::|$)/;

/**
 * The chart's primary price series: the first exchange-traded price, in
 * authored order. Study outputs are appended after the series they derive
 * from, so an overlay indicator never wins over the price it follows.
 */
function primaryPriceSeries(series: readonly ResolvedSeries[]): ResolvedSeries | null {
  return series.find((entry) => (
    entry.timeBasis?.kind === "market"
    && PRICE_UNIT_GROUPS.test(entry.unitGroup.toLowerCase())
  )) ?? null;
}

function lastCloseOf(points: readonly CompositeProjectedPoint[], heikinAshi = false): number | null {
  const last = points.at(-1);
  if (!last) return null;
  // A Heikin Ashi close is an average; the marker names the price that traded.
  if (heikinAshi && isFiniteNumber(last.point.rawValue)) return last.point.rawValue;
  return isFiniteNumber(last.point.close) ? last.point.close : last.value;
}

/** Marks the newest close of the primary price series on the panel that draws it. */
export function attachLastPriceMarker(
  panels: CompositePanelScene[],
  series: readonly ResolvedSeries[],
): void {
  const primary = primaryPriceSeries(series);
  if (!primary) return;
  const panel = panels.find((entry) => entry.id === primary.panelId);
  const projected = panel?.series.find((entry) => entry.source.id === primary.id);
  const domain = panel?.axes[primary.axis];
  if (!panel || !projected || !domain) return;
  // A rejected or missing latest bar cannot make an older close current.
  const latest = normalizedSourcePoints(primary).at(-1);
  if (latest?.point.provenance?.priceHistoryIntegrity || latest?.value === null) return;
  const value = lastCloseOf(projected.points, primary.style === "heikin-ashi");
  if (value === null) return;
  const yRatio = projectCompositeValue(value, domain);
  // An axis scaled by hand can leave the last close off the panel.
  if (yRatio === null || (domain.manual && (yRatio < 0 || yRatio > 1))) return;
  panel.lastPrice = {
    seriesId: primary.id,
    color: primary.color,
    axis: primary.axis,
    value,
    yRatio,
  };
}

/** Marks the previous session's close a one-day chart carries on its price series. */
export function attachPriorClose(panels: CompositePanelScene[], series: readonly ResolvedSeries[]): void {
  const entry = series.find((candidate) => isFiniteNumber(candidate.priorClose));
  const panel = entry ? panels.find((candidate) => candidate.id === entry.panelId) : undefined;
  const domain = entry ? panel?.axes[entry.axis] : undefined;
  if (!entry || !panel || !domain || !panel.series.some((candidate) => candidate.source.id === entry.id)) return;
  const yRatio = projectCompositeValue(entry.priorClose!, domain);
  // Off the axis it marks nothing; the axis follows the session's own bars.
  if (yRatio === null || yRatio < 0 || yRatio > 1) return;
  panel.priorClose = { axis: entry.axis, value: entry.priorClose!, yRatio };
}

/**
 * Profiles a volume-profile study over its bars in view and takes its points
 * off the panel, so it draws as a histogram rather than a line or cursor dots.
 */
export function attachVolumeProfile(panel: CompositePanelScene): void {
  const entry = panel.series.find((series) => series.source.profile);
  const domain = entry ? panel.axes[entry.source.axis] : undefined;
  if (!entry || !domain) return;
  const bars = entry.points.flatMap(({ point, value }) => {
    const close = isFiniteNumber(point.close) ? point.close : value;
    const volume = point.volume;
    if (!isFiniteNumber(volume)) return [];
    return [{
      time: point.date.getTime(),
      high: isFiniteNumber(point.high) ? point.high : close,
      low: isFiniteNumber(point.low) ? point.low : close,
      close,
      volume,
    }];
  });
  entry.points = [];
  const profile = volumeProfile(bars, entry.source.profile!.rows);
  const pocRatio = profile ? projectCompositeValue(profile.poc, domain) : null;
  if (!profile || pocRatio === null) return;
  panel.volumeProfile = {
    seriesId: entry.source.id,
    color: entry.source.color,
    rows: profile.rows.flatMap((row) => {
      const lowRatio = projectCompositeValue(row.low, domain);
      const highRatio = projectCompositeValue(row.high, domain);
      return lowRatio === null || highRatio === null
        ? []
        : [{ lowRatio, highRatio, volume: row.volume, valueArea: row.valueArea }];
    }),
    maxVolume: profile.maxVolume,
    poc: profile.poc,
    pocRatio,
  };
}
