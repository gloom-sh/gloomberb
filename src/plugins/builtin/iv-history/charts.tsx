import { useMemo } from "react";
import { CompositeChart } from "../../../components";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { staticSeries } from "../../../components/chart/static/series";
import { useThemeColors } from "../../../theme/theme-context";
import type { ResolvedSeries } from "../../../time-series/types";
import type { DatedValue, IvHistoryModel } from "./model";

const PANELS = [{ id: "vol", height: 3 }, { id: "spread", height: 1 }];
/** The chart drawing blue: IV90 must read apart from amber IV30 in every theme. */
const IV90_COLOR = "#4c9aff";

function volSeries(id: string, label: string, color: string, points: readonly DatedValue[], panelId: string,
  style: ResolvedSeries["style"] = "line"): ResolvedSeries {
  return { ...staticSeries(points.map((point) => ({ date: point.date, observedAt: point.date, value: point.value == null ? null : point.value * 100 })),
    { id, label, color, style }), unit: "%", unitGroup: "volatility", panelId, observationKind: "market" };
}

export function ivHistorySeries(model: IvHistoryModel, colors: { iv30: string; iv90: string; hv: string; quote: string; spread: string },
  hvLabel: string): ResolvedSeries[] {
  return [
    volSeries("iv30", "IV 30d", colors.iv30, model.iv30, "vol"),
    volSeries("iv90", "IV 90d", colors.iv90, model.iv90, "vol"),
    volSeries("hv", hvLabel, colors.hv, model.hv, "vol"),
    ...(model.quoteIv30.length ? [volSeries("iv30-quote", "IV 30d live", colors.quote, model.quoteIv30, "vol", "points")] : []),
    volSeries("spread", "IV 30d - HV", colors.spread, model.spread, "spread", "columns"),
  ];
}

export function IvHistoryChart({ model, width, height, hvLabel }: { model: IvHistoryModel; width: number; height: number; hvLabel: string }) {
  const colors = useThemeColors();
  const palette = resolveChartPalette(colors);
  const series = useMemo(() => ivHistorySeries(model, { iv30: colors.warning, iv90: IV90_COLOR, hv: colors.positive,
    quote: colors.textBright, spread: colors.textDim }, hvLabel), [model, colors, hvLabel]);
  return <CompositeChart series={series} panels={PANELS} width={width} height={height} navigable={false} showLegend showTimeAxis
    remoteKind="implied-volatility-history"
    colors={{ background: palette.bgColor, grid: palette.gridColor, crosshair: palette.crosshairColor, text: colors.text,
      textDim: palette.axisColor, negative: colors.negative }} />;
}
