import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, TextAttributes, useUiCapabilities } from "../../../ui";
import {
  chartTableChromeRows,
  ChartTableHeader,
  DataTableView,
  scalarPoint,
  spanAxisFormatter,
  staticSeries,
  useChartTableSelection,
  usePaneFooter,
  type ChartTableSelection,
  type DataTableCell,
  type DataTableKeyEvent,
  type StatItem,
} from "../../../components";
import type { ResolvedSeries } from "../../../time-series/types";
import type { AnalystResearchData } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { useTickerFinancials } from "../../../market-data/hooks";
import { useLiveTickerFinancials } from "../../../state/hooks/live-ticker-financials";
import { blendHex, colors } from "../../../theme/colors";
import { formatPercent } from "../../../utils/format";
import { nextHeaderSort } from "../../../utils/sort-values";
import { useAssetData } from "../../runtime";
import { handleRefreshKey, useClampSelectedIndex } from "../../../components/data-table/table-pane";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { useBoundTicker as useSymbolBinding, useTickerRequest } from "../shared/ticker-request";
import { loadAnalystResearch } from "./client";
import {
  DEFAULT_RATING_SORT,
  analystReferencePrice,
  analystTargetCurrency,
  formatAnalystPrice,
  formatPriceTarget,
  buildAnalystFooterInfo,
  buildMeanTargetHistory,
  buildRatingColumns,
  firstRatingSortDirection,
  formatRatingTarget,
  ratingSplit,
  ratingTargetDelta,
  sortRatingRows,
  targetUpside,
  type AnalystTargetHistoryPoint,
  type RatingColumn,
  type RatingColumnId,
  type RatingSortPreference,
} from "./analyst-model";

const MIN_CHART_POINTS = 3;

type RatingRow = AnalystResearchData["ratings"][number];

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

const historyDate = (point: AnalystTargetHistoryPoint) => Date.parse(`${point.date}T00:00:00Z`);

interface AnalystQuoteBinding {
  symbol: string | null;
  ticker: TickerRecord | null;
}

/**
 * The reported consensus, its upside and the Buy/Hold/Sell split, then the
 * mean-target line over the rating actions. The upside moves with the live
 * price, so this header (not the ratings table) re-renders on it. The line is
 * rebuilt from each firm's latest dated target, which is not the reported
 * consensus: its legend names it and counts the firms in it at the cursor,
 * and leaves the level to the axis so the consensus is the one target figure.
 */
function AnalystHeader({ data, history, series, currency, width, height, tableRows, tableChromeRows, binding, link }: {
  data: AnalystResearchData | null;
  history: readonly AnalystTargetHistoryPoint[];
  series: ResolvedSeries[];
  currency: string | undefined;
  width: number;
  height: number;
  tableRows: number;
  tableChromeRows: number;
  binding: AnalystQuoteBinding;
  link: ChartTableSelection;
}) {
  const financials = useTickerFinancials(binding.ticker ? binding.symbol : null, binding.ticker);
  const target = data?.priceTarget;
  const upside = targetUpside(target, analystReferencePrice(data, financials?.quote).price);
  const formatValue = useCallback(() => "", []);
  const formatAxisValue = useMemo(
    () => spanAxisFormatter((value, digits) => formatPriceTarget(Number(value.toFixed(digits)), currency)),
    [currency],
  );
  // The terminal grid gives a label half its cell, so two columns under 44
  // cells shorten the label rather than clip it.
  const { nativePaneChrome } = useUiCapabilities();
  const consensusLabel = !nativePaneChrome && width < 44 ? "Cons." : "Consensus";
  const split = ratingSplit(data);
  // The table body already reports loading, error, and empty states.
  const figures: StatItem[] = data ? [
    { id: "target", label: consensusLabel, value: formatAnalystPrice(target?.average, currency) },
    {
      id: "upside",
      label: "Upside",
      value: upside != null ? formatPercent(upside) : "-",
      tone: upside == null || upside === 0 ? "muted" : upside > 0 ? "positive" : "negative",
    },
    ...(split ? [{
      id: "ratings",
      label: "Ratings",
      value: `${split.buy} Buy · ${split.hold} Hold · ${split.sell} Sell`,
      split: [
        { id: "buy", value: split.buy, color: colors.positive },
        { id: "hold", value: split.hold, color: colors.textMuted },
        { id: "sell", value: split.sell, color: colors.negative },
      ],
      ...(split.period ? { detail: split.period } : {}),
    }] : []),
  ] : [];
  const cursorTime = link.cursorDate?.getTime();
  const shown = cursorTime == null ? history.at(-1)
    : history.findLast((point) => historyDate(point) <= cursorTime) ?? history[0];
  const firms = shown ? `${shown.firms} firms` : "";
  return (
    <ChartTableHeader width={width} height={height} tableRows={tableRows} tableChromeRows={tableChromeRows} figures={figures}
      chart={history.length >= MIN_CHART_POINTS ? {
        series, formatValue, formatAxisValue, remoteKind: "analyst-mean-target", ...link,
        legendAccessory: <Text fg={colors.textMuted}>{firms}</Text>, legendAccessoryWidth: firms.length,
      } : null} />
  );
}

/**
 * Streams the bound symbol and keeps the status bar's reference price on it.
 * Rendered beside the table so a tick redraws the footer, not the ratings.
 */
function AnalystFooter({ data, loading, error, width, binding }: {
  data: AnalystResearchData | null;
  loading: boolean;
  error: string | null;
  width: number;
  binding: AnalystQuoteBinding;
}) {
  // The upside is a percentage; about one update a second is enough for it.
  const financials = useLiveTickerFinancials(binding.ticker ? binding.symbol : null, binding.ticker, {
    surface: "detail",
    visible: false,
    weight: 40,
  });
  const reference = analystReferencePrice(data, financials?.quote);
  usePaneFooter("analyst-research", () => ({
    info: buildAnalystFooterInfo(data, { width, loading, error, reference }),
  }), [data, error, loading, reference.freshness, reference.live, reference.price, width]);
  return null;
}

export function AnalystResearchView({ focused, width, height }: { focused: boolean; width: number; height: number }) {
  const dataProvider = useAssetData();
  const cloudSession = useResearchCloudSession();
  const { symbol, exchange, ticker } = useSymbolBinding();
  const binding = useMemo<AnalystQuoteBinding>(() => ({ symbol, ticker }), [symbol, ticker]);
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

  const targetHistory = useMemo(() => buildMeanTargetHistory(data?.ratings ?? []), [data?.ratings]);
  const series = useMemo(() => {
    const first = targetHistory[0]?.average;
    const last = targetHistory.at(-1)?.average;
    // Read the line the way the table reads a raise or a cut.
    const color = first == null || last == null || last === first ? colors.textBright
      : last > first ? colors.positive : colors.negative;
    return [staticSeries(
      targetHistory.map((point) => scalarPoint(new Date(historyDate(point)), point.average)),
      { id: "mean-target", label: "Mean target", color, style: "step", calendarSpaced: true },
    )];
  }, [targetHistory]);
  // Each action sits on the line at its date; one before the line starts has no point.
  const ratingIds = useMemo(() => new Map((data?.ratings ?? []).map((row, index) => [row, String(index)])), [data?.ratings]);
  const ratingId = useCallback((row: RatingRow) => ratingIds.get(row) ?? "", [ratingIds]);
  const lineStart = targetHistory[0] ? historyDate(targetHistory[0]) : null;
  const ratingDate = useCallback((row: RatingRow) => {
    const time = Date.parse(`${row.date}T00:00:00Z`);
    return lineStart != null && Number.isFinite(time) && time >= lineStart ? new Date(time) : null;
  }, [lineStart]);
  const link = useChartTableSelection({
    rows, getId: ratingId, getDate: ratingDate,
    selectedId: rows[selectedIdx] ? ratingId(rows[selectedIdx]!) : null,
    onSelect: (id) => setSelectedIdx(Math.max(0, rows.findIndex((row) => ratingId(row) === id))),
    focused,
  });
  // The header row, plus the scrollbar row once the columns overflow the pane.
  const tableChromeRows = chartTableChromeRows(columns, width);

  const renderCell = useCallback((
    row: RatingRow,
    column: RatingColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    switch (column.id) {
      case "date":
        return { text: row.date, color: colors.textDim };
      case "firm":
        return { text: row.firm, color: colors.textBright, attributes: TextAttributes.BOLD };
      case "action":
        return { text: row.action ?? "-", color: ratingActionColor(row.action) };
      case "current":
        return { text: row.current ?? "-", color: colors.text };
      case "target": {
        const delta = ratingTargetDelta(row);
        const hasTarget = row.currentPriceTarget != null || row.priorPriceTarget != null;
        return {
          text: formatRatingTarget(row, ratingCurrency, column),
          color: hasTarget ? colors.textBright : colors.textDim,
          backgroundColor: rowState.selected ? undefined : ratingTargetBackground(delta),
          attributes: hasTarget ? TextAttributes.BOLD : undefined,
        };
      }
      case "prior":
        return { text: row.prior ?? "-", color: colors.textDim };
    }
  }, [ratingCurrency]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    return handleRefreshKey(event, reload, { stopPropagation: true });
  }, [reload]);
  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextHeaderSort(current, columnId as RatingColumnId, {
      firstDirection: firstRatingSortDirection,
    }));
  }, []);

  const footer = (
    <AnalystFooter
      data={authWall ? null : data}
      loading={loading}
      error={authWall ? null : error}
      width={width}
      binding={binding}
    />
  );

  if (authWall) {
    return (
      <>
        {footer}
        <SignInWall action="view analyst research" needsVerification={cloudSession.needsVerification} />
      </>
    );
  }

  return (
    <>
      {footer}
      <DataTableView<RatingRow, RatingColumn>
        focused={focused}
        selection={{
          kind: "index",
          selectedIndex: rows.length > 0 ? selectedIdx : -1,
          onChange: (index) => setSelectedIdx(index),
        }}
        rootWidth={width}
        rootHeight={height}
        rootBefore={(
          <AnalystHeader
            data={data}
            history={targetHistory}
            series={series}
            currency={ratingCurrency}
            width={width}
            height={height}
            tableRows={rows.length}
            tableChromeRows={tableChromeRows}
            binding={binding}
            link={link}
          />
        )}
        onRootKeyDown={handleKeyDown}
        columns={columns}
        items={rows}
        sortColumnId={sortPreference.columnId}
        sortDirection={sortPreference.direction}
        onHeaderClick={handleHeaderClick}
        getItemKey={(row, index) => `${row.date}:${row.firm}:${index}`}
        renderCell={renderCell}
        selectedTextOverridesCellColor
        emptyStateTitle={loading ? "Loading analyst data..." : error ?? "No analyst data"}
      />
    </>
  );
}
