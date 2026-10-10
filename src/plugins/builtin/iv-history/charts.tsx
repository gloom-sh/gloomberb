import { useMemo } from "react";
import { CompositeChart } from "../../../components";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { formatCompositeSeriesValue } from "../../../components/chart/composite/format";
import { staticSeries } from "../../../components/chart/static/series";
import { useThemeColors, useThemeId } from "../../../theme/theme-context";
import { themeSeriesColors } from "../../../theme/series-colors";
import type { ResolvedSeries } from "../../../time-series/types";
import { formatPoints } from "./format";
import type { DatedValue, IvHistoryModel } from "./model";

const PANELS = [{ id: "vol", height: 3 }, { id: "spread", height: 1 }];
/** The chart drawing blue: IV90 must read apart from amber IV30 in every theme. */
const IV90_COLOR = "#4c9aff";
/** The quote capture point must stand apart from the amber IV30 line it continues. */
const QUOTE_COLOR = "#c084fc";
/** IV1Y: pink, apart from amber IV30, blue IV90, green HV and the violet quote points. */
const IV365_COLOR = "#f783ac";
/**
 * Palette slots for a theme with its own series colours (the colour-blind
 * ones), where the up colour HV takes elsewhere is the same blue as IV90.
 */
const THEMED_SLOTS = { iv30: 1, iv90: 0, hv: 2, quote: 5, iv365: 4 } as const;

function volSeries(id: string, label: string, color: string, points: readonly DatedValue[], panelId: string,
  style: ResolvedSeries["style"] = "line"): ResolvedSeries {
  return { ...staticSeries(points.map((point) => ({ date: point.date, observedAt: point.date, value: point.value == null ? null : point.value * 100 })),
    { id, label, color, style }), unit: "%", unitGroup: "volatility", panelId, observationKind: "market" };
}

/** The IV-HV spread is a difference of two vols: volatility points, not a percentage. */
const SPREAD_UNIT = { unit: "pts", unitGroup: "derived-unit:volatility-points" };

function formatLegendValue(value: number, series: ResolvedSeries): string {
  return series.id === "spread" ? `${formatPoints(value / 100)} pts` : formatCompositeSeriesValue(value, series);
}

function ivHistorySeries(model: IvHistoryModel, colors: { iv30: string; iv90: string; iv365: string; hv: string; quote: string; spread: string },
  hvLabel: string): ResolvedSeries[] {
  return [
    volSeries("iv30", "IV 30d", colors.iv30, model.iv30, "vol"),
    volSeries("iv90", "IV 90d", colors.iv90, model.iv90, "vol"),
    // Drawn only once there is a 1Y close, so an empty legend entry never suggests one.
    ...(model.iv365.length ? [volSeries("iv365", "IV 1Y", colors.iv365, model.iv365, "vol")] : []),
    volSeries("hv", hvLabel, colors.hv, model.hv, "vol"),
    ...(model.quoteIv30.length ? [volSeries("iv30-quote", "IV 30d quote", colors.quote, model.quoteIv30, "vol", "points")] : []),
    { ...volSeries("spread", `IV 30d - ${hvLabel}`, colors.spread, model.spread, "spread", "columns"), ...SPREAD_UNIT },
  ];
}

export function IvHistoryChart({ model, width, height, hvLabel, focused = false }: { model: IvHistoryModel; width: number; height: number; hvLabel: string; focused?: boolean }) {
  const colors = useThemeColors();
  const themed = themeSeriesColors(useThemeId());
  const palette = resolveChartPalette(colors);
  const series = useMemo(() => ivHistorySeries(model, themed
    ? { iv30: themed[THEMED_SLOTS.iv30]!, iv90: themed[THEMED_SLOTS.iv90]!, iv365: themed[THEMED_SLOTS.iv365]!, hv: themed[THEMED_SLOTS.hv]!,
      quote: themed[THEMED_SLOTS.quote]!, spread: colors.textDim }
    : { iv30: colors.warning, iv90: IV90_COLOR, iv365: IV365_COLOR, hv: colors.positive, quote: QUOTE_COLOR, spread: colors.textDim },
  hvLabel), [model, colors, themed, hvLabel]);
  return <CompositeChart series={series} panels={PANELS} width={width} height={height} focused={focused} navigable={false} showLegend showTimeAxis formatValue={formatLegendValue}
    remoteKind="implied-volatility-history"
    colors={{ background: palette.bgColor, grid: palette.gridColor, crosshair: palette.crosshairColor, text: colors.text,
      textDim: palette.axisColor, negative: colors.negative }} />;
}
