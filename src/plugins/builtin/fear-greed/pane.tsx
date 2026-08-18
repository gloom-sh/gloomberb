import { useCallback, useEffect, useRef, useState } from "react";
import { Box, ScrollBox, Text, TextAttributes, useUiHost } from "../../../ui";
import { useShortcut } from "../../../react/input";
import { SpeedometerGauge, usePaneFooter } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import { colors } from "../../../theme/colors";
import type { FearGreedData } from "./data";
import { useAutoRefresh, useUpdatedAgo } from "../shared/auto-refresh";
import { getCachedFearGreedData, loadFearGreed } from "./cache";
import { IndicatorChart, IndexHistoryChart, PreviousScoreGrid } from "./charts";
import {
  FEAR_GREED_GAUGE_SEGMENTS,
  formatScore,
  ratingColor,
  ratingLabel,
} from "./format";

const DESKTOP_SUMMARY_STACK_WIDTH = 84;

export function FearGreedPane({ paneId, focused, width, height }: PaneProps) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const [initialCache] = useState(() => getCachedFearGreedData());
  const [data, setData] = useState<FearGreedData | null>(initialCache?.data ?? null);
  const [loading, setLoading] = useState(!initialCache || initialCache.stale);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(initialCache?.fetchedAt ?? null);
  const fetchGenRef = useRef(0);

  const load = useCallback(async (force = false) => {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setLoading(true);
    setError(null);
    try {
      const nextData = await loadFearGreed(force);
      if (fetchGenRef.current !== gen) return;
      setData(nextData);
      setLastRefreshed(getCachedFearGreedData({ allowExpired: true })?.fetchedAt ?? Date.now());
    } catch (err) {
      if (fetchGenRef.current !== gen) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (fetchGenRef.current === gen) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialCache || initialCache.stale) {
      void load();
    }
  }, [initialCache, load]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  const updatedAgo = useUpdatedAgo(lastRefreshed);
  useAutoRefresh(lastRefreshed, refresh);

  const stackDesktopSummary = isDesktopWeb && width < DESKTOP_SUMMARY_STACK_WIDTH;
  const desktopSummaryRailWidth = stackDesktopSummary ? Math.max(18, Math.min(width - 2, 42)) : 26;
  const desktopSummaryGaugeMaxWidth = Math.max(1, Math.min(width - 2, 50));
  const desktopSummaryGaugeMinWidth = Math.min(34, desktopSummaryGaugeMaxWidth);

  useShortcut((event) => {
    if (!focused) return;
    if (event.name === "r") {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
    }
  });

  const footerAge = updatedAgo ? `refreshed ${updatedAgo}` : loading ? "loading" : "";
  usePaneFooter(paneId, () => ({
    info: [
      ...(data ? [{
        id: "score",
        parts: [
          { text: `${formatScore(data.overall.score)} ${ratingLabel(data.overall.rating)}`, color: ratingColor(data.overall.rating), bold: true },
        ],
      }] : []),
      ...(footerAge ? [{ id: "age", parts: [{ text: footerAge, tone: loading ? "muted" as const : "value" as const }] }] : []),
      ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
    ],
    hints: [{ id: "refresh", key: "r", label: "efresh", onPress: refresh, disabled: loading }],
  }), [data, error, footerAge, loading, paneId, refresh]);

  if (loading && !data) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text fg={colors.textMuted}>Loading Fear & Greed...</Text>
        </Box>
      </Box>
    );
  }

  if (!data) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <Box flexGrow={1} justifyContent="center" alignItems="center" paddingX={1}>
          <Text fg={colors.negative}>{error ?? "Fear & Greed data unavailable"}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <ScrollBox flexGrow={1} scrollY focusable={false}>
        <Box flexDirection="column" paddingBottom={1}>
          {isDesktopWeb ? (
            <Box
              flexDirection={stackDesktopSummary ? "column" : "row"}
              alignItems="center"
              justifyContent="center"
              gap={stackDesktopSummary ? 0 : 4}
              paddingX={1}
            >
              <SpeedometerGauge
                value={data.overall.score}
                valueLabel={ratingLabel(data.overall.rating)}
                width={width}
                segments={FEAR_GREED_GAUGE_SEGMENTS}
                minWidth={stackDesktopSummary ? desktopSummaryGaugeMinWidth : undefined}
                maxWidth={stackDesktopSummary ? desktopSummaryGaugeMaxWidth : undefined}
                compact={stackDesktopSummary}
              />
              <Box marginTop={0}>
                <PreviousScoreGrid data={data} width={desktopSummaryRailWidth} layout="rail" />
              </Box>
            </Box>
          ) : (
            <>
              <SpeedometerGauge
                value={data.overall.score}
                valueLabel={ratingLabel(data.overall.rating)}
                width={width}
                segments={FEAR_GREED_GAUGE_SEGMENTS}
              />
              <PreviousScoreGrid data={data} width={width} />
            </>
          )}
          {loading ? (
            <Box height={1} paddingX={1} marginTop={1} justifyContent="center">
              <Text fg={colors.textMuted}>refreshing...</Text>
            </Box>
          ) : null}
          {error ? (
            <Box paddingX={1} marginTop={1}>
              <Text fg={colors.warning}>{error}</Text>
            </Box>
          ) : null}
          <IndexHistoryChart data={data} width={width} />
          <Box flexDirection="row" paddingX={1} marginTop={2} height={1}>
            <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>7 FEAR & GREED INDICATORS</Text>
          </Box>
          {data.indicators.map((indicator) => (
            <IndicatorChart key={indicator.definition.id} indicator={indicator} width={width} />
          ))}
        </Box>
      </ScrollBox>
    </Box>
  );
}
