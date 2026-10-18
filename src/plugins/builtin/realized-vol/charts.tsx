import { useRealizedVolEvidence, type RealizedVolEvidenceStatus } from "./evidence";
import { useMemo } from "react";
import { CompositeChart } from "../../../components";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { blendHex } from "../../../theme/color-utils";
import { useThemeColors } from "../../../theme/theme-context";
import type { VolatilityConeStatistics } from "../shared/volatility";
import { coneChartSeries, coneDomain, realizedChartSeries, type RealizedChartInput } from "./chart-model";

function useChartColors() {
  const colors = useThemeColors();
  const palette = resolveChartPalette(colors);
  return { colors, chart: { background: palette.bgColor, grid: palette.gridColor, crosshair: palette.crosshairColor,
    text: colors.text, textDim: palette.axisColor, negative: colors.negative } };
}

export function RealizedVolGraph({ input, width, height, evidence, focused = false }: { input: RealizedChartInput; width: number; height: number; evidence: RealizedVolEvidenceStatus; focused?: boolean }) {
  const { colors, chart } = useChartColors();
  const series = useMemo(() => realizedChartSeries(input, [colors.positive, colors.borderFocused, colors.negative,
    colors.text, colors.textDim, blendHex(colors.positive, colors.borderFocused, 0.5), colors.warning, colors.warning], colors.textBright), [input, colors]);
  useRealizedVolEvidence(series, evidence);
  return <CompositeChart series={series} panels={[{ id: "vol", height: 2 }, { id: "price", height: 1 }]}
    width={width} height={height} focused={focused} navigable={false} showLegend showTimeAxis colors={chart} remoteKind="realized-volatility" />;
}

/** The table's selected window as the cone's cursor, as `useChartTableSelection` hands it over. */
interface ConeSelection {
  cursorDate: Date | null;
  onCursorDateChange: (date: Date | null) => void;
  onActivate: () => void;
}

export function VolatilityConeChart({ rows, width, height, evidence, selection, focused = false }: { rows: readonly VolatilityConeStatistics[]; width: number; height: number; evidence: RealizedVolEvidenceStatus; selection: ConeSelection; focused?: boolean }) {
  const { colors, chart } = useChartColors();
  const series = useMemo(() => coneChartSeries(rows, [colors.textDim, colors.borderFocused, colors.positive, colors.warning]), [rows, colors]);
  useRealizedVolEvidence(series, evidence);
  const domain = useMemo(() => coneDomain(rows), [rows]);
  // The explicit viewport makes the numeric ticks exact. The legend reads the table's selected window.
  return <CompositeChart series={series} panels={[{ id: "main" }]} width={width} height={height} colors={chart}
    focused={focused} navigable={false} showLegend showTimeAxis remoteKind="volatility-cone"
    viewport={domain.viewport} clipToViewport {...selection}
    xAxis={{ ticks: rows.map((row) => ({ ratio: domain.ratio(row.window), label: `${row.window}${row.window === domain.last ? " bars" : ""}` })),
      formatCursor: (ratio) => `${domain.window(ratio)} bars` }} />;
}
