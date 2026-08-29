import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EmptyState,
  SegmentedControl,
  Spinner,
  StaticChartSurface,
  resolveChartPalette,
  type PaneFooterSegment,
} from "../../../components";
import { ExternalLinkText } from "../../../components/ui";
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
  PARITY_RATIO,
  selectBuffettView,
  type BuffettBundle,
  type BuffettRangeId,
  type BuffettViewModel,
} from "./model";
import { BUFFETT_DEFAULTS } from "./settings";
import { ZoneColorScale } from "./zone-scale";

export type BuffettLoadState =
  | { status: "idle" }
  | { status: "loading"; previous: BuffettBundle | null }
  | { status: "ready"; bundle: BuffettBundle }
  | { status: "error"; message: string; previous: BuffettBundle | null };

const RANGE_OPTIONS = [
  { value: "10Y" as const, label: "10Y" },
  { value: "25Y" as const, label: "25Y" },
  { value: "ALL" as const, label: "All" },
];

const WIKIPEDIA_ARTICLE_URL = "https://en.wikipedia.org/wiki/Buffett_indicator";

function bundleOf(state: BuffettLoadState): BuffettBundle | null {
  switch (state.status) {
    case "idle":
      return null;
    case "loading":
    case "error":
      return state.previous;
    case "ready":
      return state.bundle;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function initialLoadState(): BuffettLoadState {
  const cached = getCachedBuffettBundle();
  return cached ? { status: "ready", bundle: cached } : { status: "idle" };
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

/** Place the mean caption one row above the 100% line. */
function meanLabelTop(
  yDomain: { min: number; max: number },
  chartHeight: number,
  hasXAxis: boolean,
): number {
  const plotHeight = Math.max(1, chartHeight - (hasXAxis ? 1 : 0));
  const range = yDomain.max - yDomain.min || 1;
  const lineRow = Math.max(
    0,
    Math.min(
      plotHeight - 1,
      Math.round((1 - (PARITY_RATIO - yDomain.min) / range) * Math.max(plotHeight - 1, 0)),
    ),
  );
  return Math.max(0, lineRow - 1);
}

function footerInfoFromView(view: BuffettViewModel | null): PaneFooterSegment[] {
  const info: PaneFooterSegment[] = [];
  if (!view) return info;
  info.push({ id: "as-of", parts: [{ text: `as of ${view.asOf}`, tone: "muted" }] });
  info.push({ id: "delayed", parts: [{ text: "delayed", tone: "muted" }] });
  if (view.observationStale || view.cacheStale) {
    info.push({ id: "stale", parts: [{ text: "STALE", tone: "warning", bold: true }] });
  }
  return info;
}

export function BuffettIndicatorPane({ paneId, focused, width, height }: PaneProps) {
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
      setState({ status: "ready", bundle: next });
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
    () => (bundle ? selectBuffettView(bundle, range) : null),
    [bundle, range],
  );

  const loading = state.status === "loading" || state.status === "idle";
  const error = state.status === "error"
    ? state.message
    : bundle?.errors[0] ?? null;
  const footerInfo = useMemo(() => footerInfoFromView(view), [view]);

  usePaneStatusFooter({
    registrationId: "buffett-indicator",
    loading: state.status === "loading",
    error,
    info: footerInfo,
  });

  const palette = {
    ...resolveChartPalette(colors, "neutral"),
    gridColor: blendHex(colors.bg, colors.border, 0.55),
  };

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

  const chartWidth = Math.max(24, width - 2);
  const chartHeight = width >= 96 ? 14 : 12;

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
            </Box>
          </Box>

          <Box flexDirection="row" height={1} gap={2} overflow="hidden" justifyContent="flex-end">
            <SegmentedControl
              options={RANGE_OPTIONS}
              value={range}
              onChange={(value) => setRange(value as BuffettRangeId)}
            />
          </Box>

          {view.chart.points.length >= 2 ? (
            <Box flexDirection="column" gap={0}>
              <ZoneColorScale
                value={view.current.ratio}
                width={chartWidth}
                markerColor={view.zone.color}
              />
              <Box position="relative" width={chartWidth} height={chartHeight}>
                <StaticChartSurface
                  points={view.chart.points}
                  width={chartWidth}
                  height={chartHeight}
                  mode="line"
                  colors={palette}
                  indicators={view.chart.overlays}
                  yDomain={view.chart.yDomain}
                  lineColors={view.chart.lineColors}
                  xAxisLabels={view.chart.yearLabels}
                  xAxisColor={colors.textDim}
                  yAxisColor={colors.textDim}
                  formatYAxisValue={(v) => formatRatioPct(v)}
                />
                <Box
                  position="absolute"
                  left={0}
                  top={meanLabelTop(
                    view.chart.yDomain,
                    chartHeight,
                    view.chart.yearLabels.length > 0,
                  )}
                  height={1}
                  overflow="hidden"
                >
                  <Text fg={colors.textMuted} attributes={TextAttributes.ITALIC | TextAttributes.DIM}>
                    mean
                  </Text>
                </Box>
              </Box>
            </Box>
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

          <Box flexDirection="column" gap={1} width={Math.max(1, width - 2)}>
            <Text fg={colors.textDim} wrapMode="word" wrapText>
              The Buffett Indicator divides the total value of US stocks by GDP: the market is priced at one year of economic output. Warren Buffett popularized the ratio in a December 2001 Fortune essay written with Carol Loomis, drawn from a Sun Valley talk at the tail of the 1990s boom, and called it probably the best single measure of where valuations stand at any given moment. It is used as a market-wide compass.
            </Text>
            <Text fg={colors.textDim} wrapMode="word" wrapText>
              70 to 80% is where stocks looked cheap, while the 200% peak of 1999 and 2000 was, in his words, "playing with fire." It is still the standard whole-market valuation check.
            </Text>
            <Text fg={colors.textDim} wrapMode="word" wrapText>
              Though interest rates, buybacks, and a larger listed share of the economy have all raised what fair looks like since 2001, this tool also shows a gap versus trend (σ) for alignment.
            </Text>
            <Text fg={colors.textDim} wrapMode="word" wrapText>
              How to read: Below 75% is significantly undervalued, 90 to 115% fair, above 135% significantly overvalued.
            </Text>
            <Text fg={colors.textDim} wrapMode="word" wrapText>
              The Math: It's the Wilshire 5000 divided by nominal GDP, times 100. The Wilshire is a daily full-cap index of US listed stocks, priced so one point is about $1B of market value, while GDP only prints quarterly and is interpolated across the days in between.
            </Text>
            <Box flexDirection="row" height={1} overflow="hidden">
              <ExternalLinkText
                url={WIKIPEDIA_ARTICLE_URL}
                label="Buffett indicator, Wikipedia"
                color={colors.text}
              />
            </Box>
          </Box>
        </Box>
      </ScrollBox>
    </Box>
  );
}
