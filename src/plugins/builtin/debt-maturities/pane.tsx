import { useCallback, useMemo, type ReactNode } from "react";
import { listingIdentity } from "../shared/ticker-request";
import { Box, ScrollBox, Text, useUiCapabilities } from "../../../ui";
import {
  useAsyncResource,
  useAutoRefresh,
  usePaneSettingValue,
  usePluginPaneState,
  useShortcut,
  useUpdatedAgo,
} from "../../../public/react";
import {
  chartTableChromeRows,
  ChartTableHeader,
  CompositeChart,
  DataTableStackView,
  EmptyState,
  KeyValueRow,
  PaneStatusBody,
  Tabs,
  useChartTableSelection,
  usePaneHeaderTabs,
  usePaneNoticeFooter,
  usePaneStatusLinkFooter,
  type DataTableCell,
  type StatItem,
} from "../../../components";
import { colors } from "../../../theme/colors";
import type {
  DebtFact,
  DebtHistoryPoint,
  DebtMetric,
} from "../../../api-client/debt-maturities";
import { isAccessDenied } from "../../../api-client/errors";
import { staticSeries } from "../../../components/chart/static/series";
import type { PaneProps } from "../../../types/plugin";
import { isPlainKey } from "../../../utils/keyboard";
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
  debtAxisAmount,
  debtFilingUrl,
  debtMetricCaption,
  debtMetricValue,
  debtNotices,
  debtPercent,
  historyAxis,
  historyBars,
  historyChartPoints,
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
import { WallBar, wallLabelReserve } from "./wall-bar";

const PANELS = [{ id: "main" }];
const TABS = [
  { value: "maturities", label: "Maturities" },
  { value: "history", label: "History" },
  { value: "filing", label: "Filing" },
];
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
function FilingDetail({
  latest,
  width,
  height,
}: {
  latest: DebtLatest;
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
  const session = useResearchCloudSession();
  const loader = useCallback(
    (force: boolean) => loadDebtMaturities(symbol!, force),
    [symbol, session.requestKey],
  );
  const resource = useAsyncResource(symbol ? loader : null, {
    initialData: () => (symbol ? cachedDebtMaturities(symbol) : null),
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
  const wallReserve = Math.max(
    0,
    ...buckets.map((row) =>
      bucketBar(row, wallScale)?.capped ? wallLabelReserve(debtAmount(row.value)) : 0,
    ),
  );
  const bucketColumnList = useMemo(() => bucketColumns(width), [width]);
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  // An open bucket or filing covers its tab; the tab keys wait until it closes.
  const detailOpen =
    tab === "maturities" ? !!openBucketRow : tab === "history" && !!openHistoryRow;
  const tabsFocused = focused && !detailOpen;
  const tabsInHeader = usePaneHeaderTabs(
    latest
      ? { tabs: TABS, activeValue: tab, onSelect: setTab, focused: tabsFocused }
      : null,
  );
  const tabRows = tabsInHeader ? 0 : 1;
  // `height` is the pane body: the footer is chrome outside it on both targets.
  const bodyHeight = Math.max(3, height - tabRows);
  // The as-of date is said once; a figure from another date carries its own.
  // Most important first: a short pane keeps the leading figures.
  const statItems = useMemo<StatItem[]>(() => {
    if (!latest) return [];
    const metric = (id: string, label: string, value: DebtMetric): StatItem => ({
      id, label, value: debtMetricValue(value),
      detail: `${value.percentile.value === null ? "--" : value.percentile.value.toFixed(0)} pctl 10Y${value.asOf === latest.asOf ? "" : ` · ${value.asOf}`}`,
    });
    return [
      metric("principal", "Principal total", latest.totalPrincipal),
      metric("next12", "Due next 12 months", latest.next12MonthsShare),
      metric("next3", "Due next 3 years", latest.next3YearsShare),
      { id: "as-of", label: "As of", value: latest.asOf },
    ];
  }, [latest]);
  const historyStrip = useMemo(() => {
    const values = bars.flatMap((row) => row.totalPrincipal === null ? [] : [row.totalPrincipal]);
    const last = values.at(-1);
    return last == null || values.length < 2 ? null : {
      label: "Principal total", values, value: debtAmount(last), color: colors.warning,
    };
  }, [bars]);
  const historyWindow = latest
    ? `${latest.totalPrincipal.percentile.windowStart} to ${latest.asOf}`
    : "";
  useAutoRefresh(resource.updatedAt, resource.load);
  useShortcut((event) => {
    if (focused && isPlainKey(event, "r")) {
      event.preventDefault();
      void resource.reload();
    }
  });
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
    info: data
      ? [
          ...(updatedAgo
            ? [
                {
                  id: "updated",
                  parts: [{ text: updatedAgo, tone: "muted" as const }],
                },
              ]
            : []),
          ...(resource.data?.stale
            ? [
                {
                  id: "stale",
                  parts: [{ text: "stale", tone: "warning" as const }],
                },
              ]
            : []),
        ]
      : [],
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
        label={debtAmount(row.value)}
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
  if (!data && isCloudSessionRequired(resource.error))
    return (
      <SignInWall
        action="view debt maturities"
        needsVerification={session.needsVerification}
      />
    );
  return (
    <Box width={width} height={height} flexDirection="column">
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
            {!tabsInHeader && (
              <Tabs
                tabs={TABS}
                activeValue={tab}
                onSelect={setTab}
                dense
                focused={tabsFocused}
              />
            )}
            {tab === "filing" ? (
              <FilingDetail latest={latest} width={width} height={bodyHeight} />
            ) : tab === "maturities" ? (
              <DataTableStackView<DebtBucket, BucketColumn>
                emptyStateTitle="No maturity buckets available."
                focused={focused}
                rootWidth={width}
                rootHeight={bodyHeight}
                rootBefore={
                  // The wall is drawn in the table, so the header zone is the figures.
                  <ChartTableHeader
                    width={width}
                    height={bodyHeight}
                    tableRows={buckets.length}
                    tableChromeRows={tableChrome(bucketColumnList, width)}
                    figures={statItems}
                    chart={null}
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
                          formatAxisValue={debtAxisAmount}
                          legendAccessory={<Text fg={colors.textMuted}>{historyWindow}</Text>}
                          legendAccessoryWidth={historyWindow.length}
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
