import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, ScrollBox, Text, TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import { StaticChartSurface } from "../../../components";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { colors } from "../../../theme/colors";
import { apiClient, type CloudFredObservationPayload } from "../../../api-client";
import { isPlainKey } from "../../../utils/keyboard";
import { useShortcut } from "../../../react/input";
import { usePluginTickerActions } from "../../runtime";
import { resolveFredMapping } from "./fred-series-map";
import {
  getCachedFredSeries,
  loadCachedFredSeries,
  type FredSeriesData,
  type FredSeriesRequest,
} from "../../../data/fred-series";
import type { EconEvent } from "./types";

interface EconDetailViewProps {
  event: EconEvent;
  width: number;
  height: number;
  focused: boolean;
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
  const { navigateTicker } = usePluginTickerActions();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshnessWarning, setFreshnessWarning] = useState<string | null>(null);
  const [data, setData] = useState<FredSeriesData | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);

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

  const scrollDetailBy = useCallback((delta: number) => {
    const scrollBox = scrollRef.current;
    if (!scrollBox?.viewport) return;
    const maxScrollTop = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height);
    scrollBox.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollBox.scrollTop + delta));
  }, []);

  useShortcut((ev) => {
    if (!focused) return;
    if (isPlainKey(ev, "j", "down")) {
      ev.stopPropagation?.();
      ev.preventDefault?.();
      scrollDetailBy(1);
    } else if (isPlainKey(ev, "k", "up")) {
      ev.stopPropagation?.();
      ev.preventDefault?.();
      scrollDetailBy(-1);
    }
  });

  if (!mapping) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <Box height={1} paddingX={1} flexDirection="row">
          <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
            {event.event}
          </Text>
        </Box>
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text fg={colors.textMuted}>No historical data available for this indicator</Text>
        </Box>
      </Box>
    );
  }

  if (loading) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <Box height={1} paddingX={1} flexDirection="row">
          <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
            {event.event}
          </Text>
          <Box flexGrow={1} />
          <Text fg={colors.textDim}>{mapping.seriesId}</Text>
        </Box>
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text fg={colors.textMuted}>Loading...</Text>
        </Box>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <Box height={1} paddingX={1} flexDirection="row">
          <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
            {event.event}
          </Text>
          <Box flexGrow={1} />
          <Text fg={colors.textDim}>{mapping.seriesId}</Text>
        </Box>
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text fg={colors.negative}>{error}</Text>
        </Box>
      </Box>
    );
  }

  if (!data) return null;

  const { observations, info } = data;
  const chartWidth = Math.max(10, width - 2);
  const chartHeight = Math.min(18, Math.max(9, Math.floor(height * 0.38)));
  const chartPoints: ProjectedChartPoint[] = observations
    .filter((obs): obs is CloudFredObservationPayload & { value: number } => obs.value != null)
    .map((obs) => ({
      date: new Date(obs.date),
      open: obs.value,
      high: obs.value,
      low: obs.value,
      close: obs.value,
      volume: 0,
    }));

  const palette = resolveChartPalette(colors, "positive");
  const descObs = [...observations].reverse();
  const ascObs = observations;
  const tableRows = descObs.slice(0, 12).map((obs) => {
    if (mapping.displayMode !== "change" || obs.value == null) {
      return { date: obs.date, display: obs.value != null ? obs.value.toLocaleString("en-US", { maximumFractionDigits: 1 }) : "—" };
    }
    const ascIdx = ascObs.findIndex((o) => o.date === obs.date);
    if (ascIdx > 0 && ascObs[ascIdx - 1]!.value != null) {
      const prior = ascObs[ascIdx - 1]!.value!;
      const pct = ((obs.value - prior) / Math.abs(prior)) * 100;
      return { date: obs.date, display: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` };
    }
    return { date: obs.date, display: obs.value.toLocaleString("en-US", { maximumFractionDigits: 1 }) };
  });
  const units = info?.units ?? "";
  const title = info?.title ?? event.event;
  const valueColor = (display: string): string => {
    if (display.startsWith("+")) return colors.positive;
    if (display.startsWith("-")) return colors.negative;
    return colors.text;
  };
  const dateColWidth = 14;
  const valueColWidth = Math.max(14, Math.floor((width - 4) * 0.3));
  const separatorLine = "─".repeat(Math.max(0, width - 2));

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1} paddingX={1} flexDirection="row">
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
          {title}
        </Text>
        <Box flexGrow={1} />
        <Text fg={colors.textDim}>{mapping.seriesId}</Text>
      </Box>
      <Box height={1} paddingX={1} flexDirection="row">
        <Text fg={colors.textMuted}>
          {[units, info?.frequency, info?.seasonalAdjustment].filter(Boolean).join(" · ")}
        </Text>
        {freshnessWarning ? (
          <>
            <Box flexGrow={1} />
            <Text fg={colors.warning}>{freshnessWarning}</Text>
          </>
        ) : null}
      </Box>

      <Box paddingX={1} flexDirection="row" height={1}>
        <Text fg={colors.textDim}>Scheduled: </Text>
        <Text fg={colors.text}>{event.time}</Text>
        {event.forecast ? (
          <>
            <Text fg={colors.textDim}>  Forecast: </Text>
            <Text fg={colors.text}>{event.forecast}</Text>
          </>
        ) : null}
        {event.prior ? (
          <>
            <Text fg={colors.textDim}>  Prior: </Text>
            <Text fg={colors.text}>{event.prior}</Text>
          </>
        ) : null}
      </Box>

      <ScrollBox ref={scrollRef} flexGrow={1} scrollY focusable={false}>
        <Box flexDirection="column">
          {chartPoints.length >= 2 ? (
            <Box flexDirection="column" paddingX={1} marginTop={1}>
              <StaticChartSurface
                points={chartPoints}
                width={chartWidth}
                height={chartHeight}
                mode="area"
                colors={palette}
                showTimeAxis
                timeAxisColor={colors.textDim}
                yAxisLabel={units ? `Value (${units})` : "Value"}
                yAxisColor={colors.textDim}
                formatYAxisValue={(value) => formatCompactAxisValue(value, units)}
              />
            </Box>
          ) : (
            <Box paddingX={1} marginTop={1}>
              <Text fg={colors.textMuted}>Not enough data for chart</Text>
            </Box>
          )}

          <Box paddingX={1} height={1} marginTop={1}>
            <Text fg={colors.border}>{separatorLine}</Text>
          </Box>

          <Box paddingX={1} height={1}>
            <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>HISTORICAL READINGS</Text>
          </Box>
          <Box paddingX={1} flexDirection="row" height={1}>
            <Box width={dateColWidth}>
              <Text fg={colors.textDim}>DATE</Text>
            </Box>
            <Box width={valueColWidth} justifyContent="flex-end">
              <Text fg={colors.textDim}>VALUE</Text>
            </Box>
          </Box>
          {tableRows.map((row) => (
            <Box key={row.date} paddingX={1} flexDirection="row" height={1}>
              <Box width={dateColWidth}>
                <Text fg={colors.textDim}>{row.date}</Text>
              </Box>
              <Box width={valueColWidth} justifyContent="flex-end">
                <Text fg={valueColor(row.display)}>{row.display}</Text>
              </Box>
            </Box>
          ))}

          {mapping.relatedTickers.length > 0 ? (
            <Box paddingX={1} height={1} marginTop={1}>
              <Text fg={colors.border}>{separatorLine}</Text>
            </Box>
          ) : null}

          {mapping.relatedTickers.length > 0 ? (
            <Box paddingX={1} height={1} flexDirection="row">
              <Text fg={colors.textDim}>Related: </Text>
              {mapping.relatedTickers.map((ticker, i) => (
                <Box
                  key={ticker}
                  marginLeft={i > 0 ? 2 : 0}
                  onMouseDown={() => {
                    navigateTicker(ticker);
                  }}
                >
                  <Text fg={colors.textBright} attributes={TextAttributes.UNDERLINE}>{ticker}</Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      </ScrollBox>
    </Box>
  );
}
