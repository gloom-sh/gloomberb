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
import { getCachedBuffettBundle, loadBuffettBundle, errorForMode } from "./client";
import {
  BUFFETT_MODES,
  PARITY_RATIO,
  ZONE_SCALE_MAX,
  ZONE_SCALE_TICKS,
  selectBuffettView,
  zoneScaleBands,
  zoneScaleMarkerColumn,
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

const WIKIPEDIA_ARTICLE_URL = "https://en.wikipedia.org/wiki/Buffett_indicator";

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

/** Row for the mean caption — one above the 100% line so the stroke does not cover it. */
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

/** Same zone colors as the history line, laid out on a 0–250% axis with a marker at now. */
function ZoneColorScale({
  value,
  width,
  markerColor,
}: {
  value: number;
  width: number;
  markerColor: string;
}) {
  const scaleWidth = Math.max(12, width);
  const bands = zoneScaleBands();
  const marker = zoneScaleMarkerColumn(value, scaleWidth);
  const cells: Array<{ char: string; color: string }> = [];

  for (let column = 0; column < scaleWidth; column += 1) {
    const ratio = scaleWidth === 1 ? 0 : (column / (scaleWidth - 1)) * ZONE_SCALE_MAX;
    const band = bands.find((entry) => ratio >= entry.from && ratio < entry.to) ?? bands[bands.length - 1]!;
    cells.push({
      char: column === marker ? "●" : "━",
      color: column === marker ? markerColor : band.color,
    });
  }

  const underLabel = scaleWidth >= 48 ? "undervalued" : scaleWidth >= 28 ? "under" : "";
  const overLabel = scaleWidth >= 48 ? "overvalued" : scaleWidth >= 28 ? "over" : "";
  const fairLabel = scaleWidth >= 64 ? "fair" : "";
  const captionCells: Array<{ char: string; color: string }> = Array.from(
    { length: scaleWidth },
    () => ({ char: " ", color: colors.textDim }),
  );
  const placeCaption = (label: string, start: number) => {
    for (let index = 0; index < label.length; index += 1) {
      const column = start + index;
      if (column < 0 || column >= scaleWidth) continue;
      captionCells[column] = { char: label[index]!, color: colors.textDim };
    }
  };
  if (underLabel) placeCaption(underLabel, 0);
  if (overLabel) placeCaption(overLabel, scaleWidth - overLabel.length);
  if (fairLabel) {
    const fairStart = zoneScaleMarkerColumn(PARITY_RATIO, scaleWidth) - Math.floor(fairLabel.length / 2);
    const underEnd = underLabel.length;
    const overStart = scaleWidth - overLabel.length;
    if (fairStart >= underEnd + 1 && fairStart + fairLabel.length <= overStart - 1) {
      placeCaption(fairLabel, fairStart);
    }
  }

  const ticks = scaleWidth >= 40
    ? ZONE_SCALE_TICKS
    : ZONE_SCALE_TICKS.filter((tick) => tick === 0 || tick === PARITY_RATIO || tick === ZONE_SCALE_MAX);
  const tickCells: Array<{ char: string; color: string }> = Array.from(
    { length: scaleWidth },
    () => ({ char: " ", color: colors.textDim }),
  );
  for (const tick of ticks) {
    const label = tick === PARITY_RATIO ? "100" : String(tick);
    const center = zoneScaleMarkerColumn(tick, scaleWidth);
    const start = Math.max(0, Math.min(scaleWidth - label.length, center - Math.floor(label.length / 2)));
    for (let index = 0; index < label.length; index += 1) {
      tickCells[start + index] = {
        char: label[index]!,
        color: tick === PARITY_RATIO ? colors.textMuted : colors.textDim,
      };
    }
  }

  const chunkRow = (row: Array<{ char: string; color: string }>) => {
    const chunks: Array<{ text: string; color: string }> = [];
    for (const cell of row) {
      const last = chunks[chunks.length - 1];
      if (last && last.color === cell.color) last.text += cell.char;
      else chunks.push({ text: cell.char, color: cell.color });
    }
    return chunks;
  };
  const captionChunks = chunkRow(captionCells);
  const barChunks = chunkRow(cells);
  const tickChunks = chunkRow(tickCells);

  return (
    <Box flexDirection="column" width={scaleWidth} gap={0}>
      {underLabel || overLabel ? (
        <Box flexDirection="row" height={1} overflow="hidden">
          {captionChunks.map((chunk, index) => (
            <Text key={`caption:${index}`} fg={chunk.color}>{chunk.text}</Text>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="row" height={1} overflow="hidden">
        {barChunks.map((chunk, index) => (
          <Text key={`bar:${index}`} fg={chunk.color}>{chunk.text}</Text>
        ))}
      </Box>
      <Box flexDirection="row" height={1} overflow="hidden">
        {tickChunks.map((chunk, index) => (
          <Text key={`tick:${index}`} fg={chunk.color}>{chunk.text}</Text>
        ))}
      </Box>
    </Box>
  );
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
  const error = state.status === "error"
    ? state.message
    : view
      ? errorForMode(bundle?.errors ?? [], view.displayedMode)
      : bundle?.errors[0] ?? null;
  const footerInfo = useMemo(() => footerInfoFromView(view, state), [state, view]);

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

  const sourceLabel = BUFFETT_MODES[view.displayedMode].label;
  const showFallbackSource = view.displayedMode !== view.requestedMode;
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
              {showFallbackSource ? (
                <>
                  <Text fg={colors.textDim}>{" · "}</Text>
                  <Text fg={colors.warning}>{sourceLabel}</Text>
                </>
              ) : null}
            </Box>
          </Box>

          <Box flexDirection="row" height={1} gap={2} overflow="hidden" justifyContent="flex-end">
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
              The Buffett Indicator is the total value of US stocks divided by GDP. At 100%, the market is worth one year of economic output. Warren Buffett popularized the ratio in a December 2001 Fortune essay with Carol Loomis, drawn from a Sun Valley talk after the 1990s boom. He called it probably the best single measure of where valuations stand at any given moment.
            </Text>
            <Text fg={colors.textDim} wrapMode="word" wrapText>
              He treated it as a market-wide compass, not a trade timer. After that boom, 70 to 80% looked cheap and the 200% peak in 1999 and 2000 looked like fire. It is still the usual whole-market valuation check, though interest rates, buybacks, and a larger listed share of the economy have all raised what fair looks like versus 2001, which is why this pane also shows the gap versus trend (σ). Significantly undervalued is below 75%, fair 90 to 115%, significantly overvalued above 135%. Wilshire is a daily full-cap proxy; Z.1 is the Fed's quarterly corporate-equities series.
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
