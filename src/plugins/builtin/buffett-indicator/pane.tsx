import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EmptyState,
  SegmentedControl,
  SpeedometerGauge,
  Spinner,
  StaticChartSurface,
  resolveChartPalette,
  type PaneFooterSegment,
  type SpeedometerSegment,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue } from "../../../state/app/context";
import { blendHex, colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, TextAttributes } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { useAutoRefresh } from "../shared/auto-refresh";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { getCachedBuffettBundle, loadBuffettBundle } from "./client";
import {
  BUFFETT_MODES,
  gaugeSegmentsFromZones,
  selectBuffettView,
  type BuffettBundle,
  type BuffettModeId,
  type BuffettRangeId,
  type BuffettViewModel,
} from "./model";
import { BUFFETT_DEFAULTS } from "./settings";

export type BuffettLoadState =
  | { status: "idle" }
  | { status: "loading"; previous: BuffettBundle | null }
  | { status: "ready"; bundle: BuffettBundle }
  | { status: "partial"; bundle: BuffettBundle }
  | { status: "error"; message: string; previous: BuffettBundle | null };

const MODE_OPTIONS = [
  { value: "wilshire" as const, label: "Wilshire" },
  { value: "z1" as const, label: "Z.1" },
];

const RANGE_OPTIONS = [
  { value: "10Y" as const, label: "10Y" },
  { value: "25Y" as const, label: "25Y" },
  { value: "ALL" as const, label: "All" },
];

const GAUGE_SEGMENTS: SpeedometerSegment[] = gaugeSegmentsFromZones();

function bundleOf(state: BuffettLoadState): BuffettBundle | null {
  switch (state.status) {
    case "idle":
      return null;
    case "loading":
    case "error":
      return state.previous;
    case "ready":
    case "partial":
      return state.bundle;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function fromBundle(bundle: BuffettBundle): Extract<BuffettLoadState, { status: "ready" | "partial" }> {
  return Object.keys(bundle.modes).length === 1
    ? { status: "partial", bundle }
    : { status: "ready", bundle };
}

function initialLoadState(): BuffettLoadState {
  const cached = getCachedBuffettBundle();
  return cached ? fromBundle(cached) : { status: "idle" };
}

function formatTrillions(billions: number): string {
  return `${formatNumber(billions / 1000, 1)}T`;
}

function formatSigma(sigma: number): string {
  const sign = sigma > 0 ? "+" : "";
  return `${sign}${formatNumber(sigma, 1)}σ vs trend`;
}

function formatRatioPct(ratio: number): string {
  return `${Math.round(ratio)}%`;
}

function footerInfoFromView(
  view: BuffettViewModel | null,
  state: BuffettLoadState,
): PaneFooterSegment[] {
  const info: PaneFooterSegment[] = [];
  if (view) {
    info.push({ id: "as-of", parts: [{ text: `as of ${view.asOf}`, tone: "muted" }] });
    info.push({ id: "delayed", parts: [{ text: "delayed", tone: "muted" }] });
    if (view.observationStale || view.cacheStale) {
      info.push({ id: "stale", parts: [{ text: "STALE", tone: "warning", bold: true }] });
    }
    if (view.partial || state.status === "partial") {
      info.push({ id: "partial", parts: [{ text: "PARTIAL", tone: "warning", bold: true }] });
    }
  }
  return info;
}

export function BuffettIndicatorPane({ paneId, focused, width, height }: PaneProps) {
  const [mode, setMode] = usePaneSettingValue<BuffettModeId>("mode", BUFFETT_DEFAULTS.mode);
  const [range, setRange] = usePaneSettingValue<BuffettRangeId>("range", BUFFETT_DEFAULTS.range);
  const [state, setState] = useState<BuffettLoadState>(initialLoadState);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const generation = useRef(0);

  const load = useCallback(async (force = false) => {
    const current = ++generation.current;
    setState((previous) => ({ status: "loading", previous: bundleOf(previous) }));
    try {
      const next = await loadBuffettBundle({ force });
      if (generation.current !== current) return;
      setState(fromBundle(next));
      if (!next.stale) setLastUpdated(Date.now());
    } catch (error) {
      if (generation.current !== current) return;
      setState((previous) => ({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        previous: bundleOf(previous),
      }));
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const reload = useCallback(() => {
    void load(true);
  }, [load]);
  const refresh = useCallback(() => {
    void load(false);
  }, [load]);
  useAutoRefresh(lastUpdated, refresh);

  useShortcut((event) => {
    if (!focused || event.name !== "r") return;
    if (state.status === "loading") return;
    event.preventDefault?.();
    event.stopPropagation?.();
    reload();
  });

  const bundle = bundleOf(state);
  const view = useMemo(
    () => (bundle ? selectBuffettView(bundle, mode, range) : null),
    [bundle, mode, range],
  );

  const loading = state.status === "loading" || state.status === "idle";
  const error = state.status === "error" ? state.message : bundle?.errors[0] ?? null;
  const footerInfo = useMemo(() => footerInfoFromView(view, state), [state, view]);

  usePaneStatusFooter({
    registrationId: "buffett-indicator",
    loading: state.status === "loading",
    error,
    info: footerInfo,
  });

  const palette = useMemo(() => {
    const zoneColor = view?.zone.color ?? colors.textBright;
    const base = resolveChartPalette(colors, "neutral");
    return {
      ...base,
      lineColor: zoneColor,
      fillColor: blendHex(colors.bg, zoneColor, 0.18),
      gridColor: blendHex(colors.bg, colors.border, 0.55),
    };
  }, [view?.zone.color]);

  if (!bundle && loading) {
    return (
      <Box width={width} height={height} justifyContent="center" alignItems="center">
        <Spinner label="Loading Buffett Indicator..." />
      </Box>
    );
  }

  if (!bundle || !view) {
    return (
      <Box width={width} height={height} padding={1} flexDirection="column" gap={1}>
        <EmptyState
          title="Buffett Indicator unavailable."
          message={state.status === "error" ? state.message : error ?? undefined}
        />
      </Box>
    );
  }

  const sourceLabel = BUFFETT_MODES[view.displayedMode].label;
  const showFallbackSource = view.displayedMode !== view.requestedMode;
  const chartWidth = Math.max(24, width - 2);
  const chartHeight = width >= 96 ? 12 : 10;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <ScrollBox flexGrow={1} scrollY focusable={false}>
        <Box flexDirection="column" paddingX={1} paddingBottom={1} gap={1}>
          <Box flexDirection="column" gap={0}>
            <Box flexDirection="row" height={1} overflow="hidden">
              <Text fg={view.zone.color} attributes={TextAttributes.BOLD}>
                {formatRatioPct(view.current.ratio)}
              </Text>
              <Text fg={colors.textDim}>{"  "}</Text>
              <Text fg={view.zone.color}>{view.zone.label}</Text>
              <Box flexGrow={1} />
              <Text fg={colors.textMuted}>{formatSigma(view.sigmaVsTrend)}</Text>
            </Box>
            <Box flexDirection="row" height={1} overflow="hidden">
              <Text fg={colors.textDim}>{`as of ${view.asOf}`}</Text>
              {showFallbackSource ? (
                <>
                  <Text fg={colors.textDim}>{" · "}</Text>
                  <Text fg={colors.warning}>{sourceLabel}</Text>
                </>
              ) : null}
            </Box>
          </Box>

          <SpeedometerGauge
            value={view.current.ratio}
            valueLabel={formatRatioPct(view.current.ratio)}
            width={width - 2}
            min={0}
            max={250}
            segments={GAUGE_SEGMENTS}
          />

          {view.chart.points.length >= 2 ? (
            <StaticChartSurface
              points={view.chart.points}
              width={chartWidth}
              height={chartHeight}
              mode="line"
              colors={palette}
              indicators={view.chart.overlays}
              yDomain={view.chart.yDomain}
              yAxisSide="left"
              xAxisLabels={view.chart.yearLabels}
              xAxisColor={colors.textDim}
              yAxisColor={colors.textDim}
              formatYAxisValue={(v) => formatRatioPct(v)}
            />
          ) : (
            <Box height={chartHeight} justifyContent="center" alignItems="center">
              <Text fg={colors.textMuted}>Not enough chart data</Text>
            </Box>
          )}

          <Box flexDirection="column" gap={0}>
            <Box flexDirection="row" height={1} overflow="hidden">
              <Text fg={colors.textDim}>Mkt cap </Text>
              <Text fg={colors.textBright}>{formatTrillions(view.current.marketCapBillions)}</Text>
              <Text fg={colors.textDim}>{"  GDP "}</Text>
              <Text fg={colors.textBright}>{formatTrillions(view.current.gdpBillions)}</Text>
              <Text fg={colors.textDim}>{`  ${view.gdpVintageLabel}`}</Text>
            </Box>
            <Box flexDirection="row" height={1} overflow="hidden">
              <Text fg={colors.textDim}>1Y ago </Text>
              <Text fg={colors.text}>
                {view.ratioOneYearAgo == null ? "--" : formatRatioPct(view.ratioOneYearAgo)}
              </Text>
              <Text fg={colors.textDim}>{"  ATH "}</Text>
              <Text fg={colors.text}>{`${formatRatioPct(view.allTimeHigh.ratio)} ${view.allTimeHigh.date}`}</Text>
            </Box>
            <Box flexDirection="row" height={1} overflow="hidden">
              <Text fg={colors.textDim}>ATL </Text>
              <Text fg={colors.text}>{`${formatRatioPct(view.allTimeLow.ratio)} ${view.allTimeLow.date}`}</Text>
              <Text fg={colors.textDim}>{"  %ile "}</Text>
              <Text fg={colors.textBright}>{formatNumber(view.percentile, 0)}</Text>
            </Box>
          </Box>

          <Box flexDirection="row" height={1} gap={2} overflow="hidden">
            <SegmentedControl
              options={MODE_OPTIONS}
              value={mode}
              onChange={(value) => setMode(value as BuffettModeId)}
            />
            <SegmentedControl
              options={RANGE_OPTIONS}
              value={range}
              onChange={(value) => setRange(value as BuffettRangeId)}
            />
          </Box>

          <Box flexDirection="column" gap={0} width={Math.max(1, width - 2)}>
            <Text fg={colors.textDim} wrapMode="word">
              Market cap divided by GDP. 100% means the market equals one year of output.
            </Text>
            <Text fg={colors.textDim} wrapMode="word">
              Cheap below 75%, fair 90 to 115%, rich above 135%. σ is the trend gap on this range.
            </Text>
            <Text fg={colors.textDim} wrapMode="word">
              Wilshire is daily. Z.1 is the Fed quarterly corporate-equities series.
            </Text>
          </Box>
        </Box>
      </ScrollBox>
    </Box>
  );
}
