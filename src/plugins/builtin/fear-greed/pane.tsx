import { useMemo } from "react";
import {
  EmptyState,
  PaneStatusBody,
  SectionHeading,
  SpeedometerGauge,
  StatGrid,
  usePaneStatusFooter,
  type StatItem,
} from "../../../components";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, useUiHost } from "../../../ui";
import { useAutoRefresh, useUpdatedAgo } from "../../../react/auto-refresh";
import { getCachedFearGreedData, loadFearGreed, type FearGreedLoadResult } from "./cache";
import { IndexHistoryChart, IndicatorChart } from "./charts";
import type { FearGreedData } from "./data";
import {
  FEAR_GREED_GAUGE_SEGMENTS,
  formatScore,
  ratingColor,
  ratingLabel,
} from "./format";

function previousScoreItems(data: FearGreedData): StatItem[] {
  return [
    { id: "close", label: "Prev close", value: data.overall.previousClose },
    { id: "week", label: "1 week ago", value: data.overall.previousWeek },
    { id: "month", label: "1 month ago", value: data.overall.previousMonth },
    { id: "year", label: "1 year ago", value: data.overall.previousYear },
  ].map(({ id, label, value }) => ({
    id,
    label,
    value: formatScore(value),
    ...(value == null
      ? { tone: "muted" as const }
      : { color: ratingColor(value < 25 ? "extreme fear" : value < 45 ? "fear" : value <= 55 ? "neutral" : "greed") }),
  }));
}

export function FearGreedPane({ paneId, focused, width, height }: PaneProps) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const resource = useAsyncResource<FearGreedLoadResult>(loadFearGreed, { initialData: getCachedFearGreedData });
  const { loading, reload: refresh } = resource;
  const data = resource.data?.data ?? null;
  const stale = resource.data?.stale ?? false;
  const error = resource.error ?? resource.data?.refreshError ?? null;
  const lastRefreshed = resource.data?.fetchedAt ?? null;

  const updatedAgo = useUpdatedAgo(lastRefreshed);
  useAutoRefresh(stale ? null : lastRefreshed, refresh);

  useShortcut((event) => {
    if (!focused) return;
    if (event.name === "r") {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
    }
  });

  const footerInfo = useMemo(() => [
    ...(data ? [{
      id: "score",
      parts: [
        { text: `${formatScore(data.overall.score)} ${ratingLabel(data.overall.rating)}`, color: ratingColor(data.overall.rating), bold: true },
      ],
    }] : []),
    ...(stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
    ...(updatedAgo ? [{ id: "age", parts: [{ text: `updated ${updatedAgo}`, tone: "value" as const }] }] : []),
  ], [data, stale, updatedAgo]);
  usePaneStatusFooter({ registrationId: paneId, loading, error, info: footerInfo });

  const previousScores = useMemo(() => (data ? previousScoreItems(data) : []), [data]);

  if (loading && !data) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <PaneStatusBody loading align="center" loadingLabel="Loading Fear & Greed..." />
      </Box>
    );
  }

  if (!data) {
    return <EmptyState status={error ? "error" : "empty"} title="Fear & Greed unavailable." message={error ?? undefined} />;
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <StatGrid items={previousScores} width={width} />
      <ScrollBox flexGrow={1} flexBasis={0} minHeight={0} scrollY focusable={false}>
        <Box flexDirection="column" paddingBottom={1}>
          <SpeedometerGauge
            value={data.overall.score}
            valueLabel={ratingLabel(data.overall.rating)}
            width={width}
            segments={FEAR_GREED_GAUGE_SEGMENTS}
            minWidth={isDesktopWeb ? Math.min(34, Math.max(1, width - 2)) : undefined}
          />
          <IndexHistoryChart data={data} width={width} />
          <Box paddingX={1} marginTop={2}>
            <SectionHeading title="Indicators" />
          </Box>
          {data.indicators.map((indicator) => (
            <IndicatorChart key={indicator.definition.id} indicator={indicator} width={width} />
          ))}
        </Box>
      </ScrollBox>
    </Box>
  );
}
