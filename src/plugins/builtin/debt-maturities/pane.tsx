import { useCallback, useMemo, type ReactNode } from "react";
import { listingIdentity, useIssuerListing } from "../shared/ticker-request";
import { Box, ScrollBox, useUiCapabilities } from "../../../ui";
import {
  useAsyncResource,
  useAutoRefresh,
  usePaneSettingValue,
  usePluginPaneState,
  useUpdatedAgo,
} from "../../../public/react";
import {
  chartTableChromeRows,
  ChartTableHeader,
  CompositeChart,
  DataTableStackView,
  EmptyState,
  formatPercentAxis,
  KeyValueRow,
  PaneStatusBody,
  useChartTableSelection,
  usePaneNoticeFooter,
  usePaneStatusLinkFooter,
  usePaneTabs,
  type DataTableCell,
  type StatItem,
} from "../../../components";
import { ageFooterSegment } from "../../../components/layout/pane/footer";
import { colors } from "../../../theme/colors";
import type {
  DebtFact,
  DebtHistoryPoint,
  DebtMetric,
  DebtQuarter,
} from "../../../api-client/debt-maturities";
import { isAccessDenied } from "../../../api-client/errors";
import { formatCompactAxis } from "../../../components/chart-table";
import { staticSeries } from "../../../components/chart/static/series";
import type { PaneProps } from "../../../types/plugin";
import { formatPercentileRank } from "../../../utils/format";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { SignInWall } from "../cloud/auth-actions";
import {
  isCloudSessionRequired,
  useResearchCloudSession,
} from "../shared/research-cloud-session";
import { cachedDebtMaturities, loadDebtMaturities } from "./client";
import {
  HISTORY_COLUMNS,
  bucketBar,
  bucketColumns,
  bucketShare,
  datedBucketScale,
  debtAmount,
  debtFilingUrl,
  debtMetricCaption,
  debtMetricValue,
  debtNewestFilingText,
  debtNotices,
  debtPercent,
  historyAxis,
  historyBars,
  historyChartPoints,
  newerQuarter,
  quarterDebtText,
  sortedBuckets,
  sortedDebtHistory,
  type BucketColumn,
  type BucketColumnId,
  type DebtBucket,
  type DebtLatest,
  type DebtSort,
  type HistoryColumn,
  type HistoryColumnId,
} from "./model";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { WALL_CAP_RESERVE, WallBar } from "./wall-bar";

const PANELS = [{ id: "main" }];
const TABS = [
  { value: "maturities", label: "Maturities" },
  { value: "history", label: "History" },
  { value: "filing", label: "Filing" },
];
/** The near-term lines run edge to edge, one filing a slot. */
const LINE_SLOTS = { edges: false };
/** Legend, four plot rows and the year axis. */
const HISTORY_CHART_MIN_ROWS = 6;
const historyDate = (row: DebtHistoryPoint) => new Date(row.asOf);
/** Table header rows, plus the horizontal scrollbar when the columns overflow. */
const tableChrome = (columns: readonly { width: number }[], width: number) =>
  chartTableChromeRows(columns, width);

function MetricRow({ label, metric }: { label: string; metric: DebtMetric }) {
  return (
    <KeyValueRow
      labelWidth={20}
      label={label}
      value={debtMetricValue(metric)}
      detail={debtMetricCaption(metric)}
    />
  );
}
/** A detail sheet: the terminal sizes it in rows, the desktop fills to the footer. */
function DetailScroll({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  const { nativePaneChrome } = useUiCapabilities();
  return (
    <ScrollBox
      width={width}
      height={nativePaneChrome ? undefined : height}
      flexGrow={1}
      flexBasis={0}
      minHeight={0}
      scrollY
      contentOptions={{ paddingX: 1 }}
    >
      {children}
    </ScrollBox>
  );
}
function FactDetail({
  fact,
  width,
  height,
}: {
  fact: DebtFact | null;
  width: number;
  height: number;
}) {
  if (!fact)
    return (
      <EmptyState
        title="Principal not reported."
        message="No unambiguous matching fact in this filing."
      />
    );
  return (
    <DetailScroll width={width} height={height}>
      <KeyValueRow
        labelWidth={20}
        label="Principal"
        value={`${fact.value.toLocaleString("en-US")} ${fact.unit}`}
        detail={fact.end}
      />
      <KeyValueRow
        labelWidth={20}
        label="Filed"
        value={fact.filed}
        detail={fact.form}
      />
      <KeyValueRow labelWidth={20} label="Accession" value={fact.accession} />
      <KeyValueRow labelWidth={20} label="SEC concept" value={fact.tag} />
    </DetailScroll>
  );
}
/** A 10-Q amount with the concept it was filed under. */
function QuarterFactRow({ label, fact }: { label: string; fact: DebtFact | null }) {
  return (
    <KeyValueRow
      labelWidth={20}
      label={label}
      value={fact ? `${fact.value.toLocaleString("en-US")} ${fact.unit}` : "Not reported"}
      detail={fact?.tag}
    />
  );
}
function FilingDetail({
  latest,
  quarter,
  width,
  height,
}: {
  latest: DebtLatest;
  quarter: DebtQuarter | null;
  width: number;
  height: number;
}) {
  const expense = latest.interestExpenseFact,
    evidence = latest.borrowingCostEvidence;
  return (
    <DetailScroll width={width} height={height}>
      <KeyValueRow
        labelWidth={20}
        label="As of"
        value={latest.asOf}
        detail={latest.currency}
      />
      <KeyValueRow
        labelWidth={20}
        label="Filed"
        value={latest.filed}
        detail={latest.form}
      />
      <KeyValueRow labelWidth={20} label="Accession" value={latest.accession} />
      <MetricRow label="Principal total" metric={latest.totalPrincipal} />
      <MetricRow label="Annual interest" metric={latest.interestExpense} />
      <KeyValueRow
        labelWidth={20}
        label="Interest concept"
        value={expense?.tag ?? "Not reported"}
      />
      {expense?.start ? (
        <KeyValueRow
          labelWidth={20}
          label="Expense period"
          value={`${expense.start} to ${expense.end}`}
        />
      ) : null}
      <MetricRow label="Debt cost proxy" metric={latest.borrowingCostPercent} />
      <KeyValueRow
        labelWidth={20}
        label="Debt concepts"
        value={
          evidence?.closing.map((fact) => fact.tag).join(" + ") ??
          "Not established"
        }
      />
      {evidence ? (
        <KeyValueRow
          labelWidth={20}
          label="Cost period"
          value={`${evidence.periodStart} to ${evidence.periodEnd}`}
        />
      ) : null}
      <KeyValueRow
        labelWidth={20}
        label="Rank window"
        value={`${latest.totalPrincipal.percentile.windowStart} to ${latest.asOf}`}
      />
      <KeyValueRow
        labelWidth={20}
        label="Comparable filings"
        value={String(latest.totalPrincipal.percentile.sampleCount)}
        detail={`${latest.totalPrincipal.percentile.historyStart ?? "--"} to ${latest.totalPrincipal.percentile.historyEnd ?? "--"}`}
      />
      {quarter ? (
        <>
          <KeyValueRow
            labelWidth={20}
            label="Latest 10-Q"
            value={quarter.asOf}
            detail={`filed ${quarter.filed}`}
          />
          <KeyValueRow labelWidth={20} label="10-Q accession" value={quarter.accession} />
          <QuarterFactRow label="Current debt" fact={quarter.current} />
          <QuarterFactRow label="Non-current debt" fact={quarter.noncurrent} />
        </>
      ) : null}
    </DetailScroll>
  );
}
function HistoryDetail({
  point,
  width,
  height,
}: {
  point: DebtHistoryPoint;
  width: number;
  height: number;
}) {
  return (
    <DetailScroll width={width} height={height}>
      <KeyValueRow
        labelWidth={20}
        label="Currency"
        value={point.currency}
        detail={
          point.complete
            ? "Complete principal schedule"
            : "Partial principal schedule"
        }
      />
      <KeyValueRow labelWidth={20} label="Filed" value={point.filed} />
      <KeyValueRow labelWidth={20} label="Accession" value={point.accession} />
      <KeyValueRow
        labelWidth={20}
        label="Principal total"
        value={debtAmount(point.totalPrincipal)}
      />
      <KeyValueRow
        labelWidth={20}
        label="Next 12 months"
        value={debtAmount(point.next12Months)}
        detail={`${debtPercent(point.next12MonthsShare)} of total`}
      />
      <KeyValueRow
        labelWidth={20}
        label="Next 3 years"
        value={debtAmount(point.next3Years)}
        detail={`${debtPercent(point.next3YearsShare)} of total`}
      />
      <KeyValueRow
        labelWidth={20}
        label="Annual interest"
        value={debtAmount(point.interestExpense)}
        detail={point.interestExpenseTag ?? undefined}
      />
      <KeyValueRow
        labelWidth={20}
        label="Debt cost proxy"
        value={debtPercent(point.borrowingCostPercent)}
        detail={point.borrowingCostDebtTags ?? undefined}
      />
    </DetailScroll>
  );
}

export function DebtMaturitiesPane({ width, height, focused }: PaneProps) {
  const { ticker } = usePaneTickerIdentity();
  const symbol = listingIdentity(ticker?.metadata.ticker)?.symbol ?? null;
  const listing = useIssuerListing(ticker);
  const session = useResearchCloudSession();
  const loader = useCallback(
    (force: boolean) => loadDebtMaturities(symbol!, listing, force),
    [symbol, listing, session.requestKey],
  );
  const resource = useAsyncResource(symbol ? loader : null, {
    initialData: () => (symbol ? cachedDebtMaturities(symbol, listing) : null),
    clearOnError: isAccessDenied,
  });
  const [initialTab] = usePaneSettingValue("tab", "maturities");
  const [savedTab, setTab] = usePluginPaneState<string>("debt:tab", initialTab);
  const tab = TABS.some((entry) => entry.value === savedTab)
    ? savedTab
    : "maturities";
  const [bucketSort, setBucketSort] = usePluginPaneState<
    DebtSort<BucketColumnId>
  >("debt:bucketSort", { column: "label", direction: "asc" });
  const [historySort, setHistorySort] = usePluginPaneState<
    DebtSort<HistoryColumnId>
  >("debt:historySort", { column: "asOf", direction: "desc" });
  const [selectedBucket, setSelectedBucket] = usePluginPaneState<string | null>(
    "debt:selectedBucket",
    null,
  );
  const [openBucket, setOpenBucket] = usePluginPaneState<string | null>(
    "debt:openBucket",
    null,
  );
  const [selectedHistory, setSelectedHistory] = usePluginPaneState<
    string | null
  >("debt:selectedHistory", null);
  const [openHistory, setOpenHistory] = usePluginPaneState<string | null>(
    "debt:openHistory",
    null,
  );
  const data = resource.data?.payload,
    latest = data?.latest;
  const quarter = data ? newerQuarter(data) : null;
  const bucketKey = (bucket: DebtBucket) =>
    `${symbol}:${latest?.accession}:${latest?.asOf}:${bucket.id}`;
  const historyKey = useCallback(
    (point: DebtHistoryPoint) => `${symbol}:${point.accession}:${point.asOf}`,
    [symbol],
  );
  const buckets = useMemo(
    () => (latest ? sortedBuckets(latest, bucketSort) : []),
    [latest, bucketSort],
  );
  const history = useMemo(
    () => (data ? sortedDebtHistory(data, historySort) : []),
    [data, historySort],
  );
  const openBucketRow = buckets.find((row) => bucketKey(row) === openBucket);
  const openHistoryRow = history.find((row) => historyKey(row) === openHistory);
  // The first row stands selected until the user moves, so the chart's cursor shows.
  const selectedHistoryRow =
    openHistoryRow ??
    history.find((row) => historyKey(row) === selectedHistory) ??
    history[0];
  const selectedHistoryId = selectedHistoryRow ? historyKey(selectedHistoryRow) : null;
  const bars = useMemo(() => (data ? historyBars(data) : []), [data]);
  const historySeries = useMemo(
    () => [
      staticSeries(historyChartPoints(bars), {
        id: "debt-history",
        label: `Principal total (${latest?.currency ?? ""})`,
        color: colors.warning,
        style: "columns",
      }),
    ],
    [bars, latest?.currency],
  );
  const barAxis = useMemo(() => historyAxis(bars), [bars]);
  // The table shows where the wall stands now; the chart shows how its near
  // end moved across filings, the history behind the figures' percentiles.
  // One slot per filing, labelled by its fiscal year as the history chart is;
  // lines run edge to edge, so the idle legend reads the newest filing.
  const nearTermSeries = useMemo(() => bars.length < 2 ? [] : [
    staticSeries(historyChartPoints(bars, (row) => row.next12MonthsShare, LINE_SLOTS), {
      id: "due-12m", label: "Due next 12 months", color: colors.warning,
    }),
    staticSeries(historyChartPoints(bars, (row) => row.next3YearsShare, LINE_SLOTS), {
      id: "due-3y", label: "Due next 3 years", color: colors.borderFocused,
    }),
  ], [bars]);
  const nearTermAxis = useMemo(() => historyAxis(bars, LINE_SLOTS), [bars]);
  const historyLink = useChartTableSelection({
    rows: history,
    getId: historyKey,
    getDate: historyDate,
    selectedId: selectedHistoryId,
    onSelect: setSelectedHistory,
    focused: focused && !openHistoryRow,
    enabled: tab === "history",
  });
  const wallScale = latest ? datedBucketScale(latest) : 0;
  // A bucket past the dated scale keeps room at the end for its value.
  const wallReserve = buckets.some((row) => bucketBar(row, wallScale)?.capped) ? WALL_CAP_RESERVE : 0;
  const bucketColumnList = useMemo(() => bucketColumns(width), [width]);
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  // An open bucket or filing covers its tab; the tab keys wait until it closes.
  const detailOpen =
    tab === "maturities" ? !!openBucketRow : tab === "history" && !!openHistoryRow;
  const tabsFocused = focused && !detailOpen;
  const signInWall = !data && isCloudSessionRequired(resource.error);
  const { strip: tabStrip, rows: tabRows } = usePaneTabs(
    symbol && !signInWall
      ? { tabs: TABS, activeValue: tab, onSelect: setTab, focused: tabsFocused, dense: true }
      : null,
  );
  // `height` is the pane body: the footer is chrome outside it on both targets.
  const bodyHeight = Math.max(3, height - tabRows);
  // The as-of date is said once; a figure from another date carries its own.
  // Most important first: a short pane keeps the leading figures.
  const statItems = useMemo<StatItem[]>(() => {
    if (!latest) return [];
    const metric = (id: string, label: string, value: DebtMetric): StatItem => ({
      id, label, value: debtMetricValue(value),
      detail: `${formatPercentileRank(value.percentile.value, "10Y")}${value.asOf === latest.asOf ? "" : ` · ${value.asOf}`}`,
    });
    return [
      metric("principal", "Principal total", latest.totalPrincipal),
      metric("next12", "Due next 12 months", latest.next12MonthsShare),
      metric("next3", "Due next 3 years", latest.next3YearsShare),
      { id: "as-of", label: "As of", value: latest.asOf },
      // A 10-Q filed since: its own row, dated, so it never reads as the schedule's.
      ...(quarter ? [{
        id: "latest-10q", label: "Latest 10-Q", value: quarterDebtText(quarter),
        detail: `${quarter.asOf} · filed ${quarter.filed}`, wide: true,
      }] : []),
    ];
  }, [latest, quarter]);
  const historyStrip = useMemo(() => {
    const values = bars.flatMap((row) => row.totalPrincipal === null ? [] : [row.totalPrincipal]);
    const last = values.at(-1);
    return last == null || values.length < 2 ? null : {
      label: "Principal total", values, value: debtAmount(last), color: colors.warning,
    };
  }, [bars]);
  // Which filing the pane's date is, then how long ago it loaded: the age goes first in a narrow footer.
  const filingFooter = useMemo(() => {
    const [filing, ...shorter] = data ? debtNewestFilingText(data) : [];
    return [
      ...(filing ? [{ id: "filing", asOf: true, parts: [{ text: filing, tone: "muted" as const }],
        variants: shorter.map((text) => [{ text, tone: "muted" as const }]) }] : []),
      ...(data && updatedAgo ? [ageFooterSegment(updatedAgo)] : []),
    ];
  }, [data, updatedAgo]);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused });
  usePaneNoticeFooter({
    registrationId: "debt-maturities:notices",
    focused,
    notices: [
      ...(data ? debtNotices(data) : []),
      ...(resource.data?.refreshError ? [resource.data.refreshError] : []),
    ],
  });
  usePaneStatusLinkFooter({
    registrationId: "debt-maturities",
    focused,
    loading: resource.loading,
    error: resource.error,
    url:
      tab === "history" && selectedHistoryRow && data?.cik
        ? debtFilingUrl(data.cik, selectedHistoryRow.accession)
        : (latest?.filingUrl ?? data?.source.url ?? null),
    showOpenHint: true,
    info: filingFooter,
    stale: !!data && resource.data?.stale,
  });
  const renderBucket = (
    row: DebtBucket,
    column: BucketColumn,
    _index: number,
    state: { selected: boolean },
  ): DataTableCell => column.id === "wall" ? {
    text: "",
    content: (
      <WallBar
        bar={bucketBar(row, wallScale)}
        width={column.width}
        reserve={wallReserve}
        selected={state.selected}
      />
    ),
  } : ({
    text:
      column.id === "label"
        ? row.label
        : column.id === "value"
          ? debtAmount(row.value)
          : debtPercent(bucketShare(row, latest!)),
    color: state.selected
      ? colors.selectedText
      : row.value === null
        ? colors.textMuted
        : column.id === "value"
          ? colors.warning
          : colors.text,
  });
  const renderHistory = (
    row: DebtHistoryPoint,
    column: HistoryColumn,
    _index: number,
    state: { selected: boolean },
  ): DataTableCell => ({
    text:
      column.id === "asOf" || column.id === "filed"
        ? row[column.id]
        : column.id === "next12MonthsShare" || column.id === "next3YearsShare"
          ? debtPercent(row[column.id])
          : debtAmount(row[column.id]),
    color: state.selected
      ? colors.selectedText
      : row[column.id] === null
        ? colors.textMuted
        : colors.text,
  });
  if (!symbol)
    return (
      <EmptyState
        title="No ticker selected."
        message="Select a ticker to view debt maturities."
      />
    );
  if (signInWall)
    return (
      <SignInWall
        placement="debt-maturities-signin"
        action="view debt maturities"
        needsVerification={session.needsVerification}
      />
    );
  return (
    <Box width={width} height={height} flexDirection="column">
      {tabStrip}
      <PaneStatusBody
        loading={resource.loading && !data}
        error={!data ? resource.error : null}
        subject="debt maturities"
        empty={!!data && !latest}
        emptyTitle="No supported principal maturity schedule."
        emptyMessage={data?.warnings[0]}
      >
        {latest ? (
          <>
            {tab === "filing" ? (
              <FilingDetail latest={latest} quarter={quarter} width={width} height={bodyHeight} />
            ) : tab === "maturities" ? (
              <DataTableStackView<DebtBucket, BucketColumn>
                emptyStateTitle="No maturity buckets available."
                focused={focused}
                rootWidth={width}
                rootHeight={bodyHeight}
                rootBefore={
                  // The wall is drawn in the table; the chart is its near end over time.
                  <ChartTableHeader
                    width={width}
                    height={bodyHeight}
                    tableRows={buckets.length}
                    tableChromeRows={tableChrome(bucketColumnList, width)}
                    figures={statItems}
                    chart={nearTermSeries.length ? {
                      series: nearTermSeries,
                      formatValue: debtPercent,
                      formatAxisValue: formatPercentAxis,
                      xAxis: nearTermAxis,
                      remoteKind: "debt-near-term-share",
                    } : null}
                  />
                }
                columns={bucketColumnList}
                items={buckets}
                getItemKey={bucketKey}
                renderCell={renderBucket}
                freezeFirstColumn
                resetScrollKey={symbol}
                selection={{
                  kind: "id",
                  selectedId:
                    selectedBucket ??
                    (buckets[0] ? bucketKey(buckets[0]) : null),
                  getId: bucketKey,
                  onChange: setSelectedBucket,
                }}
                onActivate={(row) => setOpenBucket(bucketKey(row))}
                detailOpen={!!openBucketRow}
                onBack={() => setOpenBucket(null)}
                detailTitle={openBucketRow?.label}
                detailContent={
                  openBucketRow ? (
                    <FactDetail
                      fact={openBucketRow.fact}
                      width={width}
                      height={bodyHeight - 2}
                    />
                  ) : null
                }
                sortColumnId={bucketSort.column}
                sortDirection={bucketSort.direction}
                onHeaderClick={(column) =>
                  setBucketSort((current) => ({
                    column: column as BucketColumnId,
                    direction:
                      current.column === column &&
                      current.direction === "desc"
                        ? "asc"
                        : "desc",
                  }))
                }
              />
            ) : (
              <DataTableStackView<DebtHistoryPoint, HistoryColumn>
                emptyStateTitle="No comparable filing history."
                focused={focused}
                rootWidth={width}
                rootHeight={bodyHeight}
                rootBefore={
                  <ChartTableHeader
                    width={width}
                    height={bodyHeight}
                    tableRows={history.length}
                    tableChromeRows={tableChrome(HISTORY_COLUMNS, width)}
                    chart={bars.length ? {
                      // A custom chart only so each filing's year sits under its own bar.
                      render: (size) => (
                        <CompositeChart
                          series={historySeries}
                          panels={PANELS}
                          width={size.width}
                          height={size.height}
                          focused={false}
                          navigable={false}
                          showLegend
                          showTimeAxis
                          xAxis={barAxis}
                          formatValue={(value) => debtAmount(value)}
                          formatAxisValue={formatCompactAxis}
                          remoteKind="debt-filing-history"
                          {...historyLink}
                        />
                      ),
                      minRows: HISTORY_CHART_MIN_ROWS,
                      strip: historyStrip,
                    } : null}
                  />
                }
                columns={HISTORY_COLUMNS}
                items={history}
                getItemKey={historyKey}
                renderCell={renderHistory}
                freezeFirstColumn
                resetScrollKey={symbol}
                selection={{
                  kind: "id",
                  selectedId: selectedHistoryId,
                  getId: historyKey,
                  onChange: setSelectedHistory,
                }}
                onActivate={(row) => setOpenHistory(historyKey(row))}
                detailOpen={!!openHistoryRow}
                onBack={() => setOpenHistory(null)}
                detailTitle={openHistoryRow?.asOf}
                detailContent={
                  openHistoryRow ? (
                    <HistoryDetail
                      point={openHistoryRow}
                      width={width}
                      height={bodyHeight - 2}
                    />
                  ) : null
                }
                sortColumnId={historySort.column}
                sortDirection={historySort.direction}
                onHeaderClick={(column) =>
                  setHistorySort((current) => ({
                    column: column as HistoryColumnId,
                    direction:
                      current.column === column &&
                      current.direction === "desc"
                        ? "asc"
                        : "desc",
                  }))
                }
              />
            )}
          </>
        ) : null}
      </PaneStatusBody>
    </Box>
  );
}
