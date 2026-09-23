import { useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "../../../api-client";
import {
  DataTableView,
  PaneStatusBody,
  SectionHeading,
  StatGrid,
  StaticChartSurface,
  TickerBadgeList,
  statGridRows,
  usePaneNoticeFooter,
  type DataTableColumn,
  type StatItem,
} from "../../../components";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import {
  getCachedFredSeries,
  loadCachedFredSeries,
  type FredSeriesData,
  type FredSeriesRequest,
} from "../../../data/fred-series";
import { colors } from "../../../theme/colors";
import { Box, Text, type ScrollBoxRenderable } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { resolveFredMapping, projectFredHistory, fredHistoryUnits } from "./fred-series-map";
import { actualColor, timeLabel } from "./calendar-model";
import type { EconEvent } from "./types";

interface EconDetailViewProps {
  event: EconEvent;
  width: number;
  height: number;
  focused: boolean;
}

interface HistoryRow {
  date: string;
  display: string;
}

const HISTORY_COLUMNS: DataTableColumn[] = [
  { id: "date", label: "Period", width: 12, align: "left" },
  { id: "value", label: "Value", width: 14, align: "right" },
];

function valueColor(display: string): string {
  if (display.startsWith("+")) return colors.positive;
  if (display.startsWith("-")) return colors.negative;
  return colors.text;
}

function formatCompactAxisValue(value: number, units: string): string {
  const abs = Math.abs(value);
  const normalizedUnits = units.toLowerCase();
  if (normalizedUnits.includes("percent")) {
    return `${value.toFixed(abs >= 10 ? 1 : 2)}%`;
  }
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return value.toLocaleString("en-US", { maximumFractionDigits: abs >= 10 ? 1 : 2 });
}

export function EconDetailView({ event, width, height, focused }: EconDetailViewProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshnessWarning, setFreshnessWarning] = useState<string | null>(null);
  const [data, setData] = useState<FredSeriesData | null>(null);
  const historyScrollRef = useRef<ScrollBoxRenderable>(null);

  const mapping = useMemo(() => resolveFredMapping(event.event, event.country), [event.event, event.country]);
  const request = useMemo<FredSeriesRequest | null>(() => {
    if (!mapping) return null;
    const fiveYearsAgo = new Date();
    fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
    const startDate = `${fiveYearsAgo.getFullYear()}-${String(fiveYearsAgo.getMonth() + 1).padStart(2, "0")}-${String(fiveYearsAgo.getDate()).padStart(2, "0")}`;
    return {
      seriesId: mapping.seriesId,
      startDate,
      sortOrder: "asc",
    };
  }, [mapping?.seriesId]);

  useEffect(() => {
    if (!request) {
      setData(null);
      setLoading(false);
      setError(null);
      setFreshnessWarning(null);
      return;
    }

    const cached = getCachedFredSeries(request);
    if (cached) {
      setData(cached.data);
      if (!cached.stale) {
        setLoading(false);
        setError(null);
        setFreshnessWarning(null);
        return;
      }
    } else {
      setData(null);
    }

    setLoading(true);
    setError(null);
    setFreshnessWarning(null);

    loadCachedFredSeries(
      request,
      () => apiClient.getCloudFredSeries(request.seriesId, {
        startDate: request.startDate,
        sortOrder: request.sortOrder,
      }),
    )
      .then((entry) => {
        setData(entry.data);
        setFreshnessWarning(entry.stale
          ? `Cached ${new Date(entry.fetchedAt).toISOString().slice(0, 10)} · refresh failed`
          : null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [request]);

  // A stale cache and a failed refresh are limitations of data still on
  // screen, so they sit behind the footer's warning indicator.
  usePaneNoticeFooter({
    registrationId: "econ-detail",
    notices: [freshnessWarning, data && error ? error : null].filter((notice): notice is string => !!notice),
    focused,
  });

  // The stack bar names the event; the detail opens on the release figures.
  const releaseItems: StatItem[] = [
    { id: "time", label: "Release", value: timeLabel(event.date) },
    ...(event.actual ? [{ id: "actual", label: "Actual", value: event.actual, color: actualColor(event.actual, event.forecast) }] : []),
    ...(event.forecast ? [{ id: "forecast", label: "Forecast", value: event.forecast }] : []),
    ...(event.prior ? [{ id: "prior", label: "Prior", value: event.prior }] : []),
  ];

  // A stale cache stays on screen while its refresh runs or fails.
  if (!mapping || ((loading || error) && !data)) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <StatGrid items={mapping ? [...releaseItems, { id: "series", label: "Series", value: mapping.seriesId }] : releaseItems} width={width} />
        <PaneStatusBody
          loading={!!mapping && loading && !data}
          error={mapping && !loading && !data ? error : null}
          empty={!mapping}
          emptyTitle="No historical data available for this indicator"
          align="center"
        />
      </Box>
    );
  }

  if (!data) return null;

  const { observations, info } = data;
  const projected = projectFredHistory(observations, mapping);
  const units = fredHistoryUnits(mapping, info?.units ?? "");
  const chartPoints: ProjectedChartPoint[] = projected
    .map((obs) => ({
      date: new Date(obs.date),
      open: obs.value,
      high: obs.value,
      low: obs.value,
      close: obs.value,
      volume: 0,
    }));

  const palette = resolveChartPalette(colors, "positive");
  const tableRows: HistoryRow[] = [...projected].reverse().slice(0, 12).map((obs) => ({
    date: obs.date,
    display: units.toLowerCase().includes("percent")
      ? `${obs.value.toFixed(2)}%`
      : obs.value.toLocaleString("en-US", { maximumFractionDigits: 1 }),
  }));
  // The series id names the official publisher's series; units, frequency and
  // adjustment say what the chart and the history below are measured in.
  const statItems: StatItem[] = [
    ...releaseItems,
    { id: "series", label: "Series", value: mapping.seriesId, wide: true,
      detail: [units, info?.frequency, info?.seasonalAdjustment].filter(Boolean).join(" · ") || undefined },
  ];
  const statRows = statGridRows(statItems, width);
  const relatedRows = mapping.relatedTickers.length > 0 ? 1 : 0;
  const chartHeight = Math.min(18, Math.max(9, Math.floor(height * 0.38)));
  const chartRows = chartPoints.length >= 2 ? chartHeight : 1;
  // The history table takes what is left under the chart and its heading.
  const historyHeight = Math.max(3, height - statRows - chartRows - 1 - relatedRows);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <StatGrid items={statItems} width={width} />
      {chartPoints.length >= 2 ? (
        <Box flexDirection="column" paddingX={1} height={chartHeight} flexShrink={0}>
          <StaticChartSurface
            points={chartPoints}
            width={Math.max(10, width - 2)}
            height={chartHeight}
            mode="area"
            colors={palette}
            showTimeAxis
            timeAxisColor={colors.textDim}
            yAxisColor={colors.textDim}
            formatYAxisValue={(value) => formatCompactAxisValue(value, units)}
          />
        </Box>
      ) : (
        <Box paddingX={1} height={1} flexShrink={0}>
          <Text fg={colors.textMuted}>Not enough data for chart</Text>
        </Box>
      )}

      <Box paddingX={1} height={1} flexShrink={0}>
        <SectionHeading title="Revised history · reference periods" />
      </Box>
      <DataTableView<HistoryRow>
        columns={HISTORY_COLUMNS}
        items={tableRows}
        focused={focused}
        selection={{ kind: "none" }}
        rootWidth={width}
        rootHeight={historyHeight}
        scrollRef={historyScrollRef}
        // The history has no row cursor, so j/k scroll it when a short pane
        // cannot show all twelve periods.
        onRootKeyDown={(event) => {
          const delta = isPlainKey(event, "j", "down") ? 1 : isPlainKey(event, "k", "up") ? -1 : 0;
          const body = historyScrollRef.current;
          if (!delta || !body?.viewport) return false;
          const maxScrollTop = Math.max(0, body.scrollHeight - body.viewport.height);
          body.scrollTop = Math.max(0, Math.min(maxScrollTop, body.scrollTop + delta));
          event.stopPropagation?.();
          event.preventDefault?.();
          return true;
        }}
        getItemKey={(row) => row.date}
        renderCell={(row, column) => column.id === "date"
          ? { text: row.date, color: colors.textDim }
          : { text: row.display, color: valueColor(row.display) }}
        sortColumnId={null}
        sortDirection="asc"
        emptyStateTitle="No observations."
      />

      {relatedRows ? (
        <Box paddingX={1} height={1} flexDirection="row" flexShrink={0}>
          <Text fg={colors.textDim}>Related: </Text>
          <TickerBadgeList symbols={mapping.relatedTickers} width={Math.max(8, width - 12)} liveQuote={false} />
        </Box>
      ) : null}
    </Box>
  );
}
