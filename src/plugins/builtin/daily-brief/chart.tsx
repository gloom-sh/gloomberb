import { useCallback, useEffect, useMemo } from "react";
import { resolveChartPalette, Spinner, StaticChartSurface, loadingText, unavailableText } from "../../../components";
import { COMPOSITE_RIGHT_OFFSET_RATIO } from "../../../components/chart/composite/time-scale";
import type { StaticChartXMarker } from "../../../components/chart/static/chart-surface";
import { useAsyncResource, useAutoRefresh, useMarketData } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PricePoint } from "../../../types/financials";
import { Box, Text } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { esChartMarkers, esChartStart, esMarkerRatio } from "./chart-window";
import { ES_BAR_MS, useEsSessionSeries } from "./live-session";
import { loadSessionPoints } from "./session-history";

const NO_POINTS: PricePoint[] = [];

export function EsSessionChart({
  width,
  height,
  focused,
  now,
  reloadToken,
}: {
  width: number;
  height: number;
  focused: boolean;
  now: number;
  reloadToken: number;
}) {
  const colors = useThemeColors();
  const provider = useMarketData();
  const start = esChartStart(now);
  const loader = useCallback(async () => {
    if (!provider) return [] as PricePoint[];
    return loadSessionPoints(provider, "ES=F", ["", "CME"], start, Date.now());
  }, [provider, start]);
  const history = useAsyncResource(provider ? loader : null, { keepPreviousData: true });
  const reloadHistory = history.reload;
  useEffect(() => {
    if (reloadToken === 0) return;
    void reloadHistory();
  }, [reloadHistory, reloadToken]);
  useAutoRefresh(history.updatedAt, () => { void reloadHistory(); });

  const points = useEsSessionSeries(history.data ?? NO_POINTS, provider, focused, start);
  const palette = useMemo(() => resolveChartPalette({
    bg: colors.bg,
    border: colors.border,
    borderFocused: colors.borderFocused,
    text: colors.text,
    textDim: colors.textDim,
    positive: colors.positive,
    negative: colors.negative,
  }), [colors]);
  const projected = useMemo(() => points.map((point) => {
    const close = point.close;
    return {
      date: point.date,
      open: point.open ?? close,
      high: point.high ?? Math.max(point.open ?? close, close),
      low: point.low ?? Math.min(point.open ?? close, close),
      close,
      volume: point.volume ?? 0,
    };
  }), [points]);
  const markers = useMemo<StaticChartXMarker[]>(() => {
    const first = projected[0]?.date.getTime();
    const last = projected[projected.length - 1]?.date.getTime();
    if (first == null || last == null) return [];
    return esChartMarkers(start, Math.max(now, last)).flatMap((marker) => {
      const xRatio = esMarkerRatio(marker.at, first, last, COMPOSITE_RIGHT_OFFSET_RATIO);
      return xRatio == null ? [] : [{ id: marker.id, xRatio, label: marker.label, color: colors.textDim }];
    });
  }, [colors.textDim, now, projected, start]);

  if (projected.length === 0) {
    return (
      <Box width={width} height={height} flexShrink={0} paddingX={1}>
        {history.loading ? <Spinner label={loadingText()} /> : <Text fg={colors.textDim}>{unavailableText("ES history")}</Text>}
      </Box>
    );
  }

  return (
    <Box width={width} height={height} flexShrink={0}>
      <StaticChartSurface
        points={projected}
        width={width}
        height={height}
        mode="candles"
        calendarSpaced
        timeZone="America/New_York"
        cadenceMs={ES_BAR_MS}
        colors={palette}
        focused={focused}
        showTimeAxis
        yAxisLabel="ES"
        yAxisColor={colors.textDim}
        formatYAxisValue={(value) => formatNumber(value)}
        xMarkers={markers.length > 0 ? markers : undefined}
      />
    </Box>
  );
}
