import { useCompanyDisclosureLinks } from "../company-kpis/related";
import { useCallback, useEffect, useMemo } from "react";
import { Box, ScrollBox, Text } from "../../../ui";
import {
  useAssetData,
  useAsyncResource,
  useAutoRefresh,
  usePaneSettingValue,
  usePluginPaneState,
} from "../../../public/react";
import {
  buildSectionedRows,
  ChartTableHeader,
  DataTableStackView,
  DataTableView,
  EMPTY_TABLE_CELL,
  EmptyState,
  isSectionedItemRow,
  KeyValueRow,
  PaneStatusBody,
  Prose,
  renderSectionedRowHeader,
  spanAxisFormatter,
  useChartTableSelection,
  usePaneNoticeFooter,
  usePaneStatusLinkFooter,
  usePaneTabs,
  type ChartTableChart,
  type DataTableCell,
  type DataTableColumn,
  type SectionedRow,
  type StatItem,
} from "../../../components";
import { fitChartTableColumns } from "../../../components/chart-table";
import { isAccessDenied } from "../../../api-client/errors";
import { listingIdentity } from "../shared/ticker-request";
import type {
  EstimateObservation,
  EstimatePeriod,
  EstimateSurprise,
} from "../../../api-client/estimate-revisions";
import { staticSeries } from "../../../components/chart/static/series";
import { useThemeColors } from "../../../theme/theme-context";
import type { ThemeColors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { MISSING_VALUE, formatCompact, formatPercentileRank, formatPercentRaw } from "../../../utils/format";
import { formatDetailDate } from "../../../utils/datetime-format";
import { canonicalExchange } from "../../../utils/exchanges";
import { isNotMeaningful, NOT_MEANINGFUL_TEXT } from "../../../utils/growth";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { beatMissSeries, slotAxis } from "../shared/beat-miss-chart";
import { SignInWall } from "../cloud/auth-actions";
import {
  isCloudSessionRequired,
  useResearchCloudSession,
} from "../shared/research-cloud-session";
import { cachedEstimates, loadEstimates } from "./client";
import {
  estimateCount as count,
  estimateCurrent,
  estimateEps as eps,
  estimateHistory,
  estimatePercent as percent,
  estimatePercentile,
  estimatePoints,
  estimateDifference,
  estimateSurprise,
  NO_ESTIMATE_PERIODS_TITLE,
  periodColumns,
  periodTitle,
  estimateDay,
  pinnedEstimatePeriods,
  revisionNotices,
  sharedPeriodCurrency,
  sortPeriods,
} from "./model";

import {
  nextEstimateSort,
  sortEstimateHistory,
  sortEstimateSurprises,
  type EstimateSort,
} from "./sorting";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";

const clearDeniedEstimates = (error: unknown) =>
  isAccessDenied(error) || (error instanceof Error && isCloudSessionRequired(error.message));

const TABS = [
  { value: "revisions", label: "Revisions" },
  { value: "surprises", label: "Surprises" },
  { value: "guidance", label: "Guidance" },
];
const HISTORY: DataTableColumn[] = [
  { id: "date", label: "OBSERVED", width: 12, align: "left" },
  { id: "average", label: "EPS", width: 11, align: "right" },
  { id: "low", label: "LOW", width: 10, align: "right" },
  { id: "high", label: "HIGH", width: 10, align: "right" },
  { id: "analysts", label: "ANALYSTS", width: 10, align: "right" },
  { id: "source", label: "SOURCE", width: 20, align: "left", flexGrow: 1 },
];
/** The reports the Surprises chart draws, the latest: as many as EVT's Earnings view. */
const SURPRISE_BARS = 12;
const SURPRISE_PANELS = [{ id: "main" }];
const surpriseId = (row: EstimateSurprise) => `${row.date}:${row.dateType}`;
const surpriseDate = (row: EstimateSurprise) => new Date(`${row.date}T00:00:00Z`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A report's day on the chart's axis, `Nov '26`. */
const reportMonth = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1] ?? ""} '${date.slice(2, 4)}`;

/**
 * Surprises' columns: the report's date, its estimate and actual with the
 * surprise. The currency heads the EPS columns when every report shares it,
 * the date's kind shows only when it varies, and a 1Y percentile only where
 * the source gives one.
 */
function surpriseColumns(rows: readonly EstimateSurprise[], width: number): DataTableColumn[] {
  const currencies = new Set(rows.map((row) => row.currency));
  const [only] = currencies;
  const unit = currencies.size === 1 && only ? ` ${only}` : "";
  return fitChartTableColumns<DataTableColumn>([
    { id: "date", label: "DATE", width: 11, align: "left" },
    ...(new Set(rows.map((row) => row.dateType)).size > 1 ? [{ id: "dateType", label: "DATE TYPE", width: 18, align: "left" as const }] : []),
    ...(currencies.size > 1 ? [{ id: "currency", label: "CCY", width: 4, align: "left" as const }] : []),
    { id: "estimate", label: `EST EPS${unit}`, width: Math.max(8, 7 + unit.length), align: "right" },
    { id: "actual", label: `ACT EPS${unit}`, width: Math.max(8, 7 + unit.length), align: "right" },
    { id: "percent", label: "SURPRISE", width: 9, align: "right" },
    { id: "percentile", label: "PCTL 1Y", width: 8, align: "right", omitWhenEmpty: true },
    // The beat or miss in EPS, as EVT's detail says it; it takes the width the figures leave, so they sit together.
    { id: "difference", label: "VS EST", width: 8, align: "left", flexGrow: 1 },
  ], width, ["dateType", "percentile", "difference"]);
}

/** The consensus over time, recorded and as lookbacks reported it, as the Revisions chart and a period's detail draw it. */
function consensusSeries(period: EstimatePeriod, colors: ThemeColors) {
  return [
    staticSeries(estimatePoints(period.recorded), { id: "recorded", label: "Recorded", color: colors.positive, calendarSpaced: true }),
    staticSeries(estimatePoints(period.lookbacks), { id: "lookbacks", label: "Reported lookback", color: colors.warning, calendarSpaced: true }),
  ];
}
const consensusPoints = (period: EstimatePeriod) => estimateHistory(period).filter((row) => row.average != null).length;

type PeriodItem = SectionedRow<EstimatePeriod>;
const historyId = (row: EstimateObservation) => `${row.source}:${row.date}`;
const historyDate = (row: EstimateObservation) => new Date(`${row.date}T00:00:00Z`);
const historySource = (row: EstimateObservation) => row.source === "gloom" ? "Recorded" : "Reported lookback";
/** EPS ticks with the decimals the plotted range needs. */
const formatEpsAxis = spanAxisFormatter((value, digits) => value.toFixed(digits), 2);

/**
 * One fiscal period: its consensus figures, the EPS history as recorded and
 * as reported in lookbacks, then every observation. The selected observation
 * is the chart's cursor.
 */
function EstimateDetail({
  period,
  width,
  height,
  focused,
}: {
  period: EstimatePeriod;
  width: number;
  height: number;
  focused: boolean;
}) {
  const colors = useThemeColors(),
    current = estimateCurrent(period);
  const [historySort, setHistorySort] = usePluginPaneState<EstimateSort>(
    "estimate-history:sort",
    { column: "date", direction: "desc" },
  );
  const rows = useMemo(
    () => sortEstimateHistory(estimateHistory(period), historySort),
    [period, historySort],
  );
  const [selected, setSelected] = usePluginPaneState<string | null>(
    "estimate-history:row",
    null,
  );
  const selectedId = rows.some((row) => historyId(row) === selected) ? selected : rows[0] ? historyId(rows[0]) : null;
  // The legend names each line as the SOURCE column does.
  const series = useMemo(() => consensusSeries(period, colors), [period, colors]);
  const link = useChartTableSelection({
    rows, getId: historyId, getDate: historyDate, selectedId, onSelect: setSelected, focused,
  });
  const breadth = period.breadth.find((row) => row.days === 30);
  const asOf = current?.date;
  // The latest observation date is said once, on the consensus; the other
  // figures name a date only when theirs differs.
  const otherDate = (date: string | null | undefined) => date && date !== asOf ? estimateDay(date) : undefined;
  const pctl = period.percentile.percentile;
  const figures: StatItem[] = [
    {
      id: "eps",
      label: "EPS",
      value: `${eps(current?.average)}${period.currency ? ` ${period.currency}` : ""}`,
      detail: [pctl == null ? null : formatPercentileRank(pctl), asOf ? estimateDay(asOf) : null].filter(Boolean).join(" · ") || undefined,
    },
    {
      id: "change",
      label: "Change",
      value: percent(period.change.percent),
      tone: period.change.percent == null || period.change.percent === 0 ? "neutral" : period.change.percent > 0 ? "positive" : "negative",
      detail: `${estimateDay(period.change.fromDate)} to ${estimateDay(period.change.toDate)}`,
    },
    {
      id: "range",
      label: "Range",
      value: `${eps(current?.low)} to ${eps(current?.high)}`,
      detail: current?.analysts == null ? undefined : `${count(current.analysts)} analysts`,
    },
    {
      id: "breadth",
      label: "Up/down 30D",
      value: `${count(breadth?.up)} / ${count(breadth?.down)}`,
      detail: [
        breadth?.ratio == null ? null : `breadth ${percent(breadth.ratio * 100)}`,
        otherDate(breadth?.asOf),
      ].filter(Boolean).join(" · ") || undefined,
    },
    ...(period.revenue ? [{
      id: "revenue",
      label: "Revenue",
      value: `${formatCompact(period.revenue.average ?? undefined)}${period.revenue.currency ? ` ${period.revenue.currency}` : ""}`,
      detail: otherDate(period.revenue.asOf),
    }] : []),
  ];
  const hasHistory = rows.some((row) => row.average != null);
  return (
    <DataTableView<EstimateObservation>
      columns={HISTORY}
      items={rows}
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} figures={figures}
        chart={hasHistory ? {
          series, formatValue: eps, formatAxisValue: formatEpsAxis, remoteKind: "estimate-revision-history", ...link,
        } : null} />}
      selection={{
        kind: "id",
        selectedId,
        getId: historyId,
        onChange: setSelected,
      }}
      getItemKey={historyId}
      onActivate={(row) => setSelected(historyId(row))}
      sortColumnId={historySort.column}
      sortDirection={historySort.direction}
      onHeaderClick={(column) =>
        setHistorySort((old) => nextEstimateSort(old, column))
      }
      renderCell={(row, column, _index, state) => ({
        text:
          column.id === "date"
            ? estimateDay(row.date)
            : column.id === "source"
              ? historySource(row)
              : column.id === "analysts"
                ? count(row.analysts)
                : eps(row[column.id as "average" | "low" | "high"]),
        color: state.selected ? colors.selectedText : row.source === "gloom" ? colors.text : colors.warning,
      })}
      emptyStateTitle="No stored observations."
    />
  );
}
export function EstimateRevisionsPane({ width, height, focused }: PaneProps) {
  const { ticker, symbol: boundSymbol } = usePaneTickerIdentity(),
    session = useResearchCloudSession(),
    marketData = useAssetData(),
    colors = useThemeColors();
  const identity = listingIdentity(boundSymbol, ticker?.metadata.exchange ?? "");
  const symbol = identity?.symbol ?? null;
  useCompanyDisclosureLinks(boundSymbol);
  const exchange = canonicalExchange(identity?.exchange ?? "");
  const loader = useCallback(
    (force: boolean) => loadEstimates(symbol!, exchange, force, marketData ?? undefined),
    [symbol, exchange, marketData, session.requestKey],
  );
  const resource = useAsyncResource(symbol ? loader : null, {
    initialData: () => (symbol ? cachedEstimates(symbol, exchange) : null),
    clearOnError: clearDeniedEstimates,
  });
  const data = resource.data?.payload;
  const [tab, setTab] = usePaneSettingValue("tab", "revisions");
  const [pinnedPeriod] = usePaneSettingValue("period", "");
  const [frequency] = usePaneSettingValue("frequency", "quarterly");
  const [selected, setSelected] = usePluginPaneState<string | null>(
    "estimates:selected",
    null,
  );
  const [open, setOpen] = usePluginPaneState<string | null>(
    "estimates:open",
    null,
  );
  const [sort, setSort] = usePluginPaneState("estimates:sort", {
    column: "period",
    direction: "asc" as "asc" | "desc",
  });
  const [surpriseSort, setSurpriseSort] = usePluginPaneState<EstimateSort>(
    "estimates:surprise-sort",
    { column: "date", direction: "desc" },
  );
  const surpriseRows = useMemo(
    () => sortEstimateSurprises(data?.surprises ?? [], surpriseSort),
    [data, surpriseSort],
  );
  const [surprise, setSurprise] = usePluginPaneState<string | null>(
    "estimates:surprise",
    null,
  );
  const rows = useMemo(
    () => (data ? sortPeriods(data.periods, sort.column, sort.direction) : []),
    [data, sort],
  );
  // The quarters and the years each in a section of their own, in the order the header sorts.
  const periodItems = useMemo(() => buildSectionedRows<EstimatePeriod>([
    { label: "Quarters", items: rows.filter((row) => row.frequency === "quarterly") },
    { label: "Years", items: rows.filter((row) => row.frequency === "annual") },
  ], (row) => row.id), [rows]);
  const periodCurrency = useMemo(() => sharedPeriodCurrency(rows), [rows]);
  const columns = useMemo(() => periodColumns(periodCurrency), [periodCurrency]);
  const selectedPeriod = rows.find((row) => row.id === open);
  const detailOpen = tab === "revisions" && !!selectedPeriod;
  // Until one is picked, the first period analysts still estimate, else the first listed.
  const listed = periodItems.filter(isSectionedItemRow).map((item) => item.item);
  const chartedPeriod = rows.find((row) => row.id === selected) ?? listed.find((row) => row.current) ?? listed[0] ?? null;
  // The chart follows the selected period: its consensus over time, as recorded and as lookbacks reported it.
  const revisionsChart = useMemo<ChartTableChart | null>(() => {
    if (!rows.some((row) => consensusPoints(row) >= 2)) return null;
    const label = chartedPeriod ? periodTitle(chartedPeriod) : "";
    return {
      series: chartedPeriod && consensusPoints(chartedPeriod) >= 2 ? consensusSeries(chartedPeriod, colors) : [],
      empty: `No consensus history for ${label}`,
      formatValue: eps, formatAxisValue: formatEpsAxis, remoteKind: "estimate-revisions-consensus",
      legendAccessory: <Text fg={colors.textMuted}>{label}</Text>, legendAccessoryWidth: label.length,
    };
  }, [chartedPeriod, colors, rows]);
  const renderPeriodCell = useCallback((item: PeriodItem, column: DataTableColumn): DataTableCell => {
    if (!isSectionedItemRow(item)) return EMPTY_TABLE_CELL;
    const row = item.item;
    const current = estimateCurrent(row);
    const breadth = row.breadth.find((entry) => entry.days === 30);
    switch (column.id) {
      case "period": return { text: estimateDay(row.periodEnd), value: row.periodEnd, color: colors.textBright };
      case "currency": return { text: row.currency ?? MISSING_VALUE, color: colors.textDim };
      case "eps": return { text: eps(current?.average), value: current?.average ?? null, color: colors.text };
      case "percentile": return { text: estimatePercentile(row.percentile.percentile), value: row.percentile.percentile, color: colors.textDim };
      case "change": {
        const change = row.change.percent;
        return { text: percent(change), value: change, color: change == null || change === 0 ? colors.textDim : change > 0 ? colors.positive : colors.negative };
      }
      case "breadth":
        return { text: breadth?.up == null && breadth?.down == null ? MISSING_VALUE : `${count(breadth?.up)}/${count(breadth?.down)}`, color: colors.textDim };
      case "range": return { text: eps(current?.range), value: current?.range ?? null, color: colors.textDim };
      default: return { text: estimateDay(current?.date), value: current?.date ?? null, color: colors.textDim };
    }
  }, [colors]);

  // Surprises: the latest reports' estimate against the actual, as EVT's Earnings view charts them, over every report.
  const surpriseCols = useMemo(() => surpriseColumns(data?.surprises ?? [], width), [data, width]);
  const surpriseUnit = useMemo(() => {
    const currencies = new Set((data?.surprises ?? []).map((row) => row.currency));
    const [only] = currencies;
    return currencies.size === 1 && only ? only : "";
  }, [data]);
  const bars = useMemo(() => (data?.surprises ?? [])
    .filter((row) => row.actual != null || row.estimate != null)
    .toSorted((left, right) => left.date.localeCompare(right.date))
    .slice(-SURPRISE_BARS), [data]);
  const charted = useMemo(() => new Set(bars.map(surpriseId)), [bars]);
  const selectedSurprise = surpriseRows.find((row) => surpriseId(row) === surprise) ?? surpriseRows[0] ?? null;
  const chartDate = useCallback((row: EstimateSurprise) => (charted.has(surpriseId(row)) ? surpriseDate(row) : null), [charted]);
  const surpriseLink = useChartTableSelection({
    rows: surpriseRows, getId: surpriseId, getDate: chartDate, selectedId: selectedSurprise ? surpriseId(selectedSurprise) : null,
    onSelect: setSurprise, focused: focused && tab === "surprises",
  });
  const surpriseChart = useMemo<ChartTableChart | null>(() => {
    const series = beatMissSeries(bars, { actual: (row) => row.actual, estimate: (row) => row.estimate }, surpriseUnit);
    return series.length ? {
      series, panels: SURPRISE_PANELS, xAxis: slotAxis(bars, (row) => reportMonth(row.date), (row) => estimateDay(row.date)),
      remoteKind: "estimate-surprises", ...surpriseLink, formatValue: eps, formatAxisValue: formatEpsAxis,
    } : null;
  }, [bars, surpriseLink, surpriseUnit]);
  const renderSurpriseCell = useCallback((row: EstimateSurprise, column: DataTableColumn): DataTableCell => {
    switch (column.id) {
      case "date": return { text: estimateDay(row.date), value: row.date, color: colors.textDim };
      case "dateType": return { text: row.dateType, color: colors.textDim };
      case "currency": return { text: row.currency ?? MISSING_VALUE, color: colors.textDim };
      case "estimate": return { text: eps(row.estimate), value: row.estimate, color: colors.textDim };
      case "actual": return { text: eps(row.actual), value: row.actual, color: colors.text };
      case "percent": {
        const rate = estimateSurprise(row);
        if (isNotMeaningful(rate)) return { text: NOT_MEANINGFUL_TEXT, color: colors.textDim };
        if (rate == null) return { text: MISSING_VALUE, color: colors.textDim };
        const value = rate * 100;
        return { text: formatPercentRaw(value), value, color: value > 0 ? colors.positive : value < 0 ? colors.negative : colors.textDim };
      }
      case "difference": {
        const difference = estimateDifference(row);
        return difference == null ? { text: MISSING_VALUE, color: colors.textDim }
          : { text: `${difference > 0 ? "+" : ""}${eps(difference)}`, value: difference, color: colors.textDim };
      }
      default: return { text: estimatePercentile(row.percentile), value: row.percentile, color: colors.textDim };
    }
  }, [colors]);
  const pinnedTarget = useMemo(() => {
    if (!pinnedPeriod || !data) return { id: null, notice: null };
    try {
      return {
        id:
          pinnedEstimatePeriods(data.periods, pinnedPeriod, frequency)[0]?.id ??
          null,
        notice: null,
      };
    } catch (error) {
      return {
        id: null,
        notice:
          error instanceof Error
            ? error.message
            : "The selected fiscal period is unavailable.",
      };
    }
  }, [data, pinnedPeriod, frequency]);
  useEffect(() => {
    if (pinnedPeriod && data) setOpen(pinnedTarget.id);
  }, [
    pinnedPeriod,
    frequency,
    data?.symbol,
    data?.exchange,
    pinnedTarget.id,
    pinnedTarget.notice,
  ]);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => resource.reload(), { focused });
  usePaneNoticeFooter({
    registrationId: "estimates:notices",
    focused,
    notices: [
      ...(data ? revisionNotices(data) : []),
      ...(pinnedTarget.notice ? [pinnedTarget.notice] : []),
      ...(resource.data?.refreshError ? [resource.data.refreshError] : []),
    ],
  });
  usePaneStatusLinkFooter({
    registrationId: "estimates",
    focused,
    showOpenHint: tab === "guidance",
    loading: resource.loading,
    error: resource.error,
    url: tab === "guidance" ? (data?.guidance?.transcriptURL ?? null) : null,
    info: data
      ? [
          {
            id: "asof",
            parts: [
              {
                text: `${data.generatedAt.replace("T", " ").slice(0, 16)} UTC`,
                tone: "muted",
              },
            ],
          },
        ]
      : [],
    stale: !!data && resource.data?.stale,
  });
  const signInWall = !data && isCloudSessionRequired(resource.error);
  // Every tab would show the same wall, so the strip waits for data.
  const { strip: tabStrip, rows: tabRows } = usePaneTabs(!symbol || signInWall ? null : {
    tabs: TABS,
    activeValue: tab,
    onSelect: setTab,
    focused: focused && !detailOpen,
    dense: true,
  });
  if (!symbol) return <EmptyState title="Select a ticker." />;
  if (signInWall)
    return (
      <SignInWall
        placement="estimate-revisions-signin"
        action={tab === "guidance" ? "view company guidance" : "view estimate revisions"}
        needsVerification={session.needsVerification}
      />
    );
  const bodyHeight = Math.max(3, height - tabRows);
  const sortBy = (column: string) => setSort((old) => ({
    column,
    direction: old.column === column && old.direction === "desc" ? "asc" : "desc",
  }));
  return (
    <Box width={width} height={height} flexDirection="column">
      {tabStrip}
      <PaneStatusBody
        loading={resource.loading && !data}
        error={!data ? resource.error : null}
        subject="estimate revisions"
      >
        {data && tab === "revisions" ? (
          <DataTableStackView<PeriodItem>
            columns={columns}
            items={periodItems}
            focused={focused}
            rootWidth={width}
            rootHeight={bodyHeight}
            rootBefore={revisionsChart ? (
              <ChartTableHeader width={width} height={bodyHeight} tableRows={periodItems.length} tableColumns={columns} chart={revisionsChart} />
            ) : undefined}
            selection={{
              kind: "id",
              selectedId: chartedPeriod?.id ?? null,
              getId: (item) => item.key,
              onChange: (id) => setSelected(String(id)),
            }}
            getItemKey={(item) => item.key}
            isNavigable={isSectionedItemRow}
            renderSectionHeader={renderSectionedRowHeader}
            onActivate={(item) => { if (isSectionedItemRow(item)) setOpen(item.item.id); }}
            detailOpen={!!selectedPeriod}
            onBack={() => setOpen(null)}
            detailTitle={
              selectedPeriod ? periodTitle(selectedPeriod) : undefined
            }
            detailContent={
              selectedPeriod ? (
                <EstimateDetail
                  period={selectedPeriod}
                  width={width}
                  height={Math.max(3, bodyHeight - 1)}
                  focused={focused}
                />
              ) : null
            }
            sortColumnId={sort.column}
            sortDirection={sort.direction}
            onHeaderClick={sortBy}
            renderCell={renderPeriodCell}
            selectedTextOverridesCellColor
            getExportMetadata={() => (periodCurrency ? [["Currency", periodCurrency]] : [])}
            emptyStateTitle={NO_ESTIMATE_PERIODS_TITLE}
          />
        ) : null}
        {data && tab === "surprises" ? (
          <DataTableView<EstimateSurprise>
            columns={surpriseCols}
            items={surpriseRows}
            focused={focused}
            rootWidth={width}
            rootHeight={bodyHeight}
            rootBefore={surpriseChart ? (
              <ChartTableHeader width={width} height={bodyHeight} tableRows={surpriseRows.length} tableColumns={surpriseCols} chart={surpriseChart} />
            ) : undefined}
            selection={{
              kind: "id",
              selectedId: selectedSurprise ? surpriseId(selectedSurprise) : null,
              getId: surpriseId,
              onChange: setSurprise,
            }}
            getItemKey={surpriseId}
            onActivate={(row) => setSurprise(surpriseId(row))}
            sortColumnId={surpriseSort.column}
            sortDirection={surpriseSort.direction}
            onHeaderClick={(column) =>
              setSurpriseSort((old) => nextEstimateSort(old, column))
            }
            renderCell={renderSurpriseCell}
            selectedTextOverridesCellColor
            getExportMetadata={() => (surpriseUnit ? [["Currency", surpriseUnit]] : [])}
            emptyStateTitle="No comparable reported earnings."
          />
        ) : null}
        {data && tab === "guidance" ? (
          // The guidance alone: the periods' consensus is the Revisions tab's.
          <ScrollBox
            width={width}
            height={bodyHeight}
            scrollY
            focusable={false}
            paddingX={1}
          >
            {data.guidance ? (
              <>
                <KeyValueRow
                  labelWidth={16}
                  label="Call"
                  value={estimateDay(data.guidance.callDate?.slice(0, 10))}
                  detail={`FY${data.guidance.fiscalYear} Q${data.guidance.fiscalQuarter} · summary ${formatDetailDate(data.guidance.publishedAt)}`}
                />
                <Prose
                  text={data.guidance.text}
                  width={Math.max(1, width - 2)}
                  figures={false}
                />
              </>
            ) : (
              <EmptyState title="No cited guidance available." />
            )}
          </ScrollBox>
        ) : null}
      </PaneStatusBody>
    </Box>
  );
}
