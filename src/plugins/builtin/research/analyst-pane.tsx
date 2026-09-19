import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, TextAttributes } from "../../../ui";
import {
  DataTableView,
  StaticChartSurface,
  usePaneFooter,
  type DataTableCell,
  type DataTableKeyEvent,
} from "../../../components";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import type { AnalystResearchData } from "../../../types/financials";
import { blendHex, colors, priceColor } from "../../../theme/colors";
import { displayWidth, formatPercent } from "../../../utils/format";
import { useAssetData } from "../../runtime";
import { handleRefreshKey, useClampSelectedIndex } from "../shared/table-pane";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { useBoundTicker as useSymbolBinding, useTickerRequest } from "../shared/ticker-request";
import { loadAnalystResearch } from "./client";
import {
  DEFAULT_RATING_SORT,
  analystTargetCurrency,
  formatAnalystPrice,
  formatPriceTarget,
  buildAnalystFooterInfo,
  buildAnalystTargetHistory,
  buildRatingColumns,
  formatRatingTarget,
  nextRatingSortPreference,
  ratingTargetDelta,
  sortRatingRows,
  targetUpside,
  type AnalystTargetHistoryPoint,
  type RatingColumn,
  type RatingSortPreference,
} from "./analyst-model";

export {
  buildRatingColumns,
  formatRatingTarget,
  nextRatingSortPreference,
  sortRatingRows,
  type RatingSortPreference,
} from "./analyst-model";

/** Enough of the pane to keep a readable table under the chart. */
const MIN_CHART_PANE_HEIGHT = 16;
const MIN_CHART_POINTS = 3;

function ratingActionColor(action: string | undefined): string {
  const normalized = action?.toLowerCase() ?? "";
  if (normalized.includes("upgrade")) return colors.positive;
  if (normalized.includes("downgrade")) return colors.negative;
  return colors.textDim;
}

function ratingTargetBackground(delta: number | null): string | undefined {
  if (delta == null || delta === 0) return undefined;
  return blendHex(colors.bg, delta > 0 ? colors.positive : colors.negative, 0.42);
}

function targetHistoryPoints(history: AnalystTargetHistoryPoint[]): ProjectedChartPoint[] {
  return history.map((point) => ({
    date: new Date(`${point.date}T00:00:00Z`),
    open: point.average,
    high: point.average,
    low: point.average,
    close: point.average,
    volume: 0,
  }));
}

/**
 * The reported target and its upside stay in the body because the chart under
 * them is a different measure: the rest of the consensus context lives in the
 * status bar rather than in a fixed block above the actions.
 */
function AnalystHeadline({ data, legend, width }: {
  data: AnalystResearchData | null;
  legend: string | null;
  width: number;
}) {
  const target = data?.priceTarget;
  const upside = targetUpside(target);
  const currency = analystTargetCurrency(data);

  // The table body already reports loading, error, and empty states.
  if (!data) return null;

  const averageText = formatAnalystPrice(target?.average, currency);
  const upsideText = upside != null ? formatPercent(upside) : "-";
  const headlineWidth = displayWidth(`${averageText} avg target ${upsideText} upside`);
  // A legend the row cannot hold would crowd the number it explains.
  const fittedLegend = legend && width - 2 - headlineWidth - 2 >= displayWidth(legend) ? legend : null;

  return (
    <Box flexDirection="row" paddingX={1} height={1} flexShrink={0} overflow="hidden">
      <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{averageText}</Text>
      <Text fg={colors.textDim}> avg target </Text>
      <Text fg={upside == null ? colors.textDim : priceColor(upside)}>{upsideText}</Text>
      <Text fg={colors.textDim}> upside</Text>
      {fittedLegend ? (
        <>
          <Box flexGrow={1} />
          <Text fg={colors.textMuted}>{fittedLegend}</Text>
        </>
      ) : null}
    </Box>
  );
}

function TargetHistoryChart({
  history,
  currency,
  width,
  height,
}: {
  history: AnalystTargetHistoryPoint[];
  currency: string | undefined;
  width: number;
  height: number;
}) {
  const points = useMemo(() => targetHistoryPoints(history), [history]);
  const first = history[0]?.average;
  const last = history.at(-1)?.average;
  // Read the line the way the table reads a raise or a cut.
  const palette = resolveChartPalette(colors, first == null || last == null || last === first
    ? "neutral"
    : last > first ? "positive" : "negative");

  return (
    <Box flexDirection="column" paddingX={1} height={height} flexShrink={0}>
      <StaticChartSurface
        points={points}
        width={Math.max(10, width - 2)}
        height={height}
        mode="step"
        calendarSpaced
        colors={palette}
        showTimeAxis
        timeAxisColor={colors.textDim}
        yAxisColor={colors.textDim}
        formatYAxisValue={(value) => formatPriceTarget(value, currency)}
      />
    </Box>
  );
}

export function AnalystResearchView({ focused, width, height }: { focused: boolean; width: number; height: number }) {
  const dataProvider = useAssetData();
  const cloudSession = useResearchCloudSession();
  const { symbol, exchange } = useSymbolBinding();
  const [sortPreference, setSortPreference] = useState<RatingSortPreference>(DEFAULT_RATING_SORT);
  const loader = useCallback((nextSymbol: string, nextExchange: string, forceRefresh: boolean) => {
    if (!dataProvider) throw new Error("Analyst data unavailable");
    return loadAnalystResearch(
      dataProvider,
      nextSymbol,
      nextExchange,
      forceRefresh ? { cacheMode: "refresh" } : undefined,
    );
  }, [dataProvider, cloudSession.requestKey]);
  const { data, loading, error, reload } = useTickerRequest<AnalystResearchData>(loader, symbol, exchange);
  const authWall = !data && isCloudSessionRequired(error);
  const rows = useMemo(() => sortRatingRows(data?.ratings ?? [], sortPreference), [data?.ratings, sortPreference]);
  const ratingCurrency = analystTargetCurrency(data);
  const columns = useMemo(
    () => buildRatingColumns(data?.ratings ?? [], ratingCurrency),
    [data?.ratings, ratingCurrency],
  );
  const [selectedIdx, setSelectedIdx] = useState(0);
  useEffect(() => { setSelectedIdx(0); }, [symbol, exchange]);
  useClampSelectedIndex(rows.length, selectedIdx, setSelectedIdx);

  const targetHistory = useMemo(() => buildAnalystTargetHistory(data?.ratings ?? []), [data?.ratings]);
  const showChart = targetHistory.length >= MIN_CHART_POINTS && height >= MIN_CHART_PANE_HEIGHT;
  const chartHeight = showChart ? Math.min(10, Math.max(5, Math.floor((height - 1) * 0.3))) : 0;
  const chartFirms = targetHistory.at(-1)?.firms ?? 0;

  const renderCell = useCallback((
    row: AnalystResearchData["ratings"][number],
    column: RatingColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "date":
        return { text: row.date, color: selectedColor ?? colors.textDim };
      case "firm":
        return { text: row.firm, color: selectedColor ?? colors.textBright, attributes: TextAttributes.BOLD };
      case "action":
        return { text: row.action ?? "-", color: selectedColor ?? ratingActionColor(row.action) };
      case "current":
        return { text: row.current ?? "-", color: selectedColor ?? colors.text };
      case "target": {
        const delta = ratingTargetDelta(row);
        const hasTarget = row.currentPriceTarget != null || row.priorPriceTarget != null;
        return {
          text: formatRatingTarget(row, ratingCurrency, column),
          color: selectedColor ?? (hasTarget ? colors.textBright : colors.textDim),
          backgroundColor: rowState.selected ? undefined : ratingTargetBackground(delta),
          attributes: hasTarget ? TextAttributes.BOLD : undefined,
        };
      }
      case "prior":
        return { text: row.prior ?? "-", color: selectedColor ?? colors.textDim };
    }
  }, [ratingCurrency]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    return handleRefreshKey(event, reload, { stopPropagation: true });
  }, [reload]);
  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextRatingSortPreference(current, columnId));
  }, []);

  usePaneFooter("analyst-research", () => ({
    info: buildAnalystFooterInfo(authWall ? null : data, {
      width,
      loading,
      error: authWall ? null : error,
    }),
  }), [authWall, data, error, loading, width]);

  if (authWall) return <SignInWall action="view analyst research" needsVerification={cloudSession.needsVerification} />;

  return (
    <DataTableView<AnalystResearchData["ratings"][number], RatingColumn>
      focused={focused}
      selection={{
        kind: "index",
        selectedIndex: rows.length > 0 ? selectedIdx : -1,
        onChange: (index) => setSelectedIdx(index),
      }}
      rootWidth={width}
      rootHeight={height}
      rootBefore={(
        <>
          <AnalystHeadline
            data={data}
            width={width}
            legend={showChart ? `mean of ${chartFirms} rated firms' latest targets` : null}
          />
          {showChart ? (
            <TargetHistoryChart
              history={targetHistory}
              currency={ratingCurrency}
              width={width}
              height={chartHeight}
            />
          ) : null}
        </>
      )}
      onRootKeyDown={handleKeyDown}
      columns={columns}
      items={rows}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={(row, index) => `${row.date}:${row.firm}:${index}`}
      renderCell={renderCell}
      emptyStateTitle={loading ? "Loading analyst data..." : error ?? "No analyst data"}
    />
  );
}
