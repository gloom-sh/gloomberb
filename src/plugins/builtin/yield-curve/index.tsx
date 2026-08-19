import { Box, ScrollBox, Text } from "../../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShortcut } from "../../../react/input";
import { Button, EmptyState, Spinner, StaticChartSurface, type PaneFooterSegment } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { colors } from "../../../theme/colors";
import { resolveChartPalette } from "../../../components/chart/core/renderer";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import {
  loadYieldCurve,
  parseYieldPoints,
  isInverted,
  TREASURY_MATURITIES,
  type YieldPoint,
} from "./treasury-data";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { useAutoRefresh, useUpdatedAgo } from "../shared/auto-refresh";

function formatYield(y: number | null): string {
  if (y == null) return "—";
  return `${y.toFixed(2)}%`;
}

function formatYieldAxis(value: number): string {
  return `${value.toFixed(2)}%`;
}

function spreadBp(points: YieldPoint[]): number | null {
  const y2 = points.find((p) => p.maturity === "2Y")?.yield;
  const y10 = points.find((p) => p.maturity === "10Y")?.yield;
  if (y2 == null || y10 == null) return null;
  return Math.round((y10 - y2) * 100);
}

function YieldCurvePane({ focused, width, height }: PaneProps) {
  const [points, setPoints] = useState<YieldPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const fetchGenRef = useRef(0);

  const load = useCallback(async () => {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setLoading(true);
    setError(null);

    try {
      const data = await loadYieldCurve();
      if (fetchGenRef.current !== gen) return;
      setPoints(data);
      setLastUpdated(Date.now());
    } catch (err) {
      if (fetchGenRef.current !== gen) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (fetchGenRef.current === gen) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useAutoRefresh(lastUpdated, load);
  const updatedAgo = useUpdatedAgo(lastUpdated);

  useShortcut((ev) => {
    if (!focused) return;
    if (ev.name === "r") {
      load();
    }
  });

  const inverted = isInverted(points);
  const bp = spreadBp(points);

  const yieldStatus = useMemo<PaneFooterSegment[]>(() => [
      ...(inverted ? [{ id: "inverted", parts: [{ text: "INVERTED", tone: "warning" as const, bold: true }] }] : []),
      ...(bp != null ? [{ id: "spread", parts: [{ text: `2Y-10Y ${bp >= 0 ? "+" : ""}${bp}bp`, tone: bp < 0 ? "warning" as const : "muted" as const }] }] : []),
      ...(updatedAgo ? [{ id: "updated", parts: [{ text: `updated ${updatedAgo}`, tone: "muted" as const }] }] : []),
  ], [bp, inverted, updatedAgo]);
  usePaneStatusFooter({
    registrationId: "yield-curve",
    loading,
    error,
    info: yieldStatus,
  });

  if (loading && points.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Spinner label="Loading yield curve..." />
        </Box>
      </Box>
    );
  }

  if (error && points.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height} padding={1} gap={1}>
        <EmptyState title="Yield curve unavailable." message={error} />
      </Box>
    );
  }

  const validPoints = parseYieldPoints(points);

  const chartWidth = Math.max(10, width - 2);
  const chartHeight = Math.min(18, Math.max(8, height - 5));

  const palette = resolveChartPalette(colors, "positive");

  // Map yield points to chart points: use epoch + maturityYears*365*86400000 to space them on the x-axis
  const chartPoints: ProjectedChartPoint[] = validPoints.map((p) => ({
    date: new Date(p.maturityYears * 365 * 86400000),
    open: p.yield!,
    high: p.yield!,
    low: p.yield!,
    close: p.yield!,
    volume: 0,
  }));

  // Build maturity label row and yield value row for the table
  const colWidth = Math.max(6, Math.floor((width - 2) / TREASURY_MATURITIES.length));
  const maturityLabels = TREASURY_MATURITIES.map((m) => m.maturity.padEnd(colWidth)).join("").trimEnd();
  const yieldValues = TREASURY_MATURITIES.map((m) => {
    const pt = points.find((p) => p.maturity === m.maturity);
    return formatYield(pt?.yield ?? null).padEnd(colWidth);
  }).join("").trimEnd();

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Scrollable chart + table */}
      <ScrollBox flexGrow={1} scrollY focusable={false}>
        <Box flexDirection="column">
          {/* Chart */}
          {chartPoints.length >= 2 ? (
            <Box flexDirection="column" paddingX={1} marginTop={1}>
              <StaticChartSurface
                points={chartPoints}
                width={chartWidth}
                height={chartHeight}
                mode="line"
                colors={palette}
                yAxisLabel="Yield (%)"
                yAxisColor={colors.textDim}
                formatYAxisValue={formatYieldAxis}
              />
            </Box>
          ) : (
            <Box paddingX={1} marginTop={1}>
              <Text fg={colors.textMuted}>Not enough data for chart</Text>
            </Box>
          )}

          {/* Maturity table */}
          <Box paddingX={1} marginTop={1} height={1}>
            <Text fg={colors.textDim}>{maturityLabels}</Text>
          </Box>
          <Box paddingX={1} height={1}>
            <Text fg={colors.text}>{yieldValues}</Text>
          </Box>
        </Box>
      </ScrollBox>
    </Box>
  );
}

export const yieldCurveModule: PluginModule = {
  panes: [{
    id: "yield-curve",
    name: "US Treasury Yield Curve",
    icon: "Y",
    component: YieldCurvePane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 80, height: 20 },
  }],
  paneTemplates: [{
    id: "yield-curve-pane",
    paneId: "yield-curve",
    label: "Yield Curve",
    description: "US Treasury yield curve charted from FRED data.",
    keywords: ["yield", "curve", "treasury", "bonds", "rates", "gc", "interest"],
    shortcut: { prefix: "GC" },
  }],
};
