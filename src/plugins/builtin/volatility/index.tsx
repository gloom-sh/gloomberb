import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, TextAttributes } from "../../../ui";
import { useShortcut } from "../../../react/input";
import {
  StaticChartSurface,
  usePaneFooter,
  type PaneFooterSegment,
} from "../../../components";
import { ListView } from "../../../components/ui/list-view";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { resolveChartPalette } from "../../../components/chart/core/renderer";
import type { PaneProps } from "../../../types/plugin";
import { colors } from "../../../theme/colors";
import type { PluginModule } from "../plugin-module";
import { getCachedVolatilityData, loadVolatilityData } from "./client";
import type { TermState, VolatilityData } from "./model";

function formatValue(value: number | null, suffix = ""): string {
  return value == null || !Number.isFinite(value) ? "--" : `${value.toFixed(2)}${suffix}`;
}

function termColor(state: TermState): string {
  if (state === "contango") return colors.positive;
  if (state === "backwardation") return colors.warning;
  return colors.textMuted;
}

function TermChart({ data, width, height }: { data: VolatilityData; width: number; height: number }) {
  const points: ProjectedChartPoint[] = data.termPoints.flatMap((point, index) => point.value == null ? [] : [{
    date: new Date(index * 86_400_000),
    open: point.value,
    high: point.value,
    low: point.value,
    close: point.value,
    volume: 0,
  }]);
  if (points.length < 2) {
    return <Box paddingX={1}><Text fg={colors.warning}>Term structure partial: aligned closes unavailable.</Text></Box>;
  }
  const colWidth = Math.max(10, Math.floor((width - 2) / data.termPoints.length));
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <StaticChartSurface
        points={points}
        width={Math.max(12, width - 2)}
        height={Math.max(5, Math.min(10, height))}
        mode="line"
        colors={resolveChartPalette(colors, "positive")}
        yAxisLabel="Index"
        yAxisColor={colors.textDim}
        formatYAxisValue={(value) => value.toFixed(1)}
      />
      <Text fg={colors.textDim}>{data.termPoints.map((point) => point.tenor.padEnd(colWidth)).join("").trimEnd()}</Text>
      <Text fg={colors.text}>{data.termPoints.map((point) => formatValue(point.value).padEnd(colWidth)).join("").trimEnd()}</Text>
    </Box>
  );
}

export function VolatilityPane({ paneId, focused, width, height }: PaneProps) {
  const [initial] = useState(getCachedVolatilityData);
  const [data, setData] = useState<VolatilityData | null>(initial?.data ?? null);
  const [loading, setLoading] = useState(!initial);
  const [stale, setStale] = useState(initial?.stale ?? false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const generation = useRef(0);

  const load = useCallback(async (force = false) => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await loadVolatilityData(force);
      if (generation.current !== current) return;
      setData(result.data);
      setStale(result.stale);
      setError(result.errors[0] ?? null);
    } catch (loadError) {
      if (generation.current !== current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  const refresh = useCallback(() => { void load(true); }, [load]);
  useShortcut((event) => {
    if (!focused) return;
    if (event.name === "r") refresh();
    else if (["left", "up", "k"].includes(event.name ?? "")) setSelected((value) => Math.max(0, value - 1));
    else if (["right", "down", "j"].includes(event.name ?? "")) setSelected((value) => Math.min(1, value + 1));
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  const footerInfo = useMemo<PaneFooterSegment[]>(() => [
    ...(data?.termState && data.termState !== "partial" ? [{
      id: "term-state",
      parts: [{ text: data.termState.toUpperCase(), tone: data.termState === "backwardation" ? "warning" as const : "value" as const, bold: true }],
    }] : []),
    ...(data?.termState === "partial" ? [{ id: "partial", parts: [{ text: "PARTIAL", tone: "warning" as const, bold: true }] }] : []),
    ...(stale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
    ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
    ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
  ], [data?.termState, error, loading, stale]);
  usePaneFooter(paneId, () => ({
    info: footerInfo,
    hints: [{ id: "refresh", key: "r", label: "efresh", onPress: refresh, disabled: loading }],
  }), [footerInfo, loading, paneId, refresh]);

  if (!data && loading) {
    return <Box width={width} height={height} justifyContent="center" alignItems="center"><Text fg={colors.textMuted}>Loading volatility data...</Text></Box>;
  }
  if (!data) {
    return <Box width={width} height={height} padding={1}><Text fg={colors.negative}>{error ?? "Volatility data unavailable"}</Text></Box>;
  }

  const selectedMetric = data.metrics[selected] ?? data.metrics[0]!;
  return (
    <Box flexDirection="column" width={width} height={height} paddingBottom={1}>
          <Box paddingX={1}><Text fg={colors.textMuted}>FRED · daily close · delayed</Text></Box>
          <Box flexDirection="row" paddingX={1} marginTop={1}>
            <Text fg={colors.textDim}>VXV/VIX </Text>
            <Text fg={termColor(data.termState)} attributes={TextAttributes.BOLD}>{formatValue(data.ratio)}</Text>
            <Text fg={colors.textDim}>{`  slope ${formatValue(data.slope, " pts")}  as of ${data.termDate ?? "--"}`}</Text>
          </Box>
          <Box marginTop={1} height={2}>
            <ListView
              items={data.metrics.map((metric) => ({
                id: metric.seriesId,
                label: `${metric.label.padEnd(8)} ${formatValue(metric.value).padStart(7)}   ${metric.tenor} · ${metric.date ?? "--"}`,
              }))}
              selectedIndex={selected}
              onSelect={setSelected}
              renderRow={(item, state, index) => (
                <Text
                  fg={state.selected ? colors.selectedText : colors.text}
                  attributes={state.selected ? TextAttributes.BOLD : 0}
                  onMouseDown={() => setSelected(index)}
                  onMouseUp={() => setSelected(index)}
                >
                  {state.selected ? "▸ " : "  "}{item.label}
                </Text>
              )}
              height={2}
              surface="plain"
              remoteLabel="Volatility tenors"
            />
          </Box>
          <Box paddingX={1}><Text fg={colors.textDim}>{selectedMetric.title}</Text></Box>
          <TermChart data={data} width={width} height={Math.floor(height * 0.35)} />
    </Box>
  );
}

export const volatilityModule: PluginModule = {
  panes: [{
    id: "volatility-term-structure",
    name: "VIX Term Structure",
    icon: "V",
    component: VolatilityPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 76, height: 23 },
  }],
  paneTemplates: [{
    id: "volatility-term-structure-pane",
    paneId: "volatility-term-structure",
    label: "VIX Term Structure",
    description: "Aligned daily VIX and three-month volatility closes from FRED.",
    keywords: ["vix", "volatility", "term structure", "contango", "backwardation", "macro"],
    shortcut: { prefix: "VIX" },
  }],
};
