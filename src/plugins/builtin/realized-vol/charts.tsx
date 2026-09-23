import { useRealizedVolEvidence, type RealizedVolEvidenceStatus } from "./evidence";
import { useMemo } from "react";
import { CompositeChart } from "../../../components";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { blendHex } from "../../../theme/color-utils";
import { useThemeColors } from "../../../theme/theme-context";
import type { VolatilityConeStatistics } from "../shared/volatility";
import { coneChartSeries, realizedChartSeries, type RealizedChartInput } from "./chart-model";

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

export function VolatilityConeChart({ rows, width, height, evidence, focused = false }: { rows: readonly VolatilityConeStatistics[]; width: number; height: number; evidence: RealizedVolEvidenceStatus; focused?: boolean }) {
  const { colors, chart } = useChartColors();
  const series = useMemo(() => coneChartSeries(rows, [colors.textDim, colors.borderFocused, colors.positive, colors.warning]), [rows, colors]);
  useRealizedVolEvidence(series, evidence);
  const min = rows[0]?.window ?? 10, max = rows.at(-1)?.window ?? 260;
  const tickRows = rows.filter((row) => width >= 90 || (row.window !== 20 && (width >= 60 || row.window !== 30)));
  // Composite charts leave a small right margin; the explicit viewport makes numeric ticks exact.
  return <CompositeChart series={series} panels={[{ id: "main" }]} width={width} height={height} colors={chart}
    focused={focused} navigable={false} showLegend showTimeAxis remoteKind="volatility-cone"
    viewport={{ start: new Date(min * 86_400_000), end: new Date(max * 86_400_000) }} clipToViewport
    xAxis={{ ticks: tickRows.map((row) => ({ ratio: (row.window - min) / Math.max(1, max - min), label: `${row.window}${row.window === max ? " sessions" : ""}` })),
      formatCursor: (ratio) => `${Math.round(min + ratio * (max - min))} sessions` }} />;
}
