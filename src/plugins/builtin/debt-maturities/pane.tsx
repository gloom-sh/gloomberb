import { useCallback, useMemo } from "react";
import { listingIdentity } from "../shared/ticker-request";
import { Box, ScrollBox } from "../../../ui";
import {
  useAsyncResource,
  useAutoRefresh,
  usePaneSettingValue,
  usePluginPaneState,
  useShortcut,
  useUpdatedAgo,
} from "../../../public/react";
import {
  CompositeChart,
  DataTableView,
  EmptyState,
  KeyValueRow,
  PageStackView,
  PaneStatusBody,
  Tabs,
  usePaneHeaderTabs,
  usePaneNoticeFooter,
  usePaneStatusLinkFooter,
  usePaneTicker,
  type DataTableCell,
} from "../../../components";
import { colors } from "../../../theme/colors";
import type {
  DebtFact,
  DebtHistoryPoint,
  DebtMetric,
} from "../../../api-client/debt-maturities";
import { ApiRequestError } from "../../../api-client/errors";
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
  BUCKET_AXIS_TICKS,
  BUCKET_COLUMNS,
  HISTORY_COLUMNS,
  bucketCursor,
  bucketPoints,
  bucketShare,
  debtAmount,
  debtFilingUrl,
  debtMetricCaption,
  debtMetricValue,
  debtNotices,
  debtPercent,
  recentDebtHistory,
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

const PANELS = [{ id: "main" }];
const TABS = [
  { value: "maturities", label: "Maturities" },
  { value: "history", label: "History" },
  { value: "filing", label: "Filing" },
];
const BUCKET_AXIS = { ticks: BUCKET_AXIS_TICKS, formatCursor: bucketCursor };
const clearDenied = (error: unknown) =>
  error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);
const amountAxis = (value: number) => debtAmount(value);

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
    <ScrollBox
      width={width}
      height={height}
      scrollY
      contentOptions={{ paddingX: 1 }}
    >
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
    </ScrollBox>
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
    <ScrollBox
      width={width}
      height={height}
      scrollY
      contentOptions={{ paddingX: 1 }}
    >
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
    </ScrollBox>
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
    <ScrollBox
      width={width}
      height={height}
      scrollY
      contentOptions={{ paddingX: 1 }}
    >
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
        detail={point.asOf}
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
    </ScrollBox>
  );
}

export function DebtMaturitiesPane({ width, height, focused }: PaneProps) {
  const { ticker } = usePaneTicker();
  const symbol = listingIdentity(ticker?.metadata.ticker)?.symbol ?? null;
  const session = useResearchCloudSession();
  const loader = useCallback(
    (force: boolean) => loadDebtMaturities(symbol!, force),
    [symbol, session.requestKey],
  );
  const resource = useAsyncResource(symbol ? loader : null, {
    initialData: () => (symbol ? cachedDebtMaturities(symbol) : null),
    clearOnError: clearDenied,
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
  const historyKey = (point: DebtHistoryPoint) =>
    `${symbol}:${point.accession}:${point.asOf}`;
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
  const selectedHistoryRow =
    openHistoryRow ??
    history.find((row) => historyKey(row) === selectedHistory) ??
    history[0];
  const series = useMemo(
    () => [
      staticSeries(latest ? bucketPoints(latest) : [], {
        id: "debt-principal",
        label: `Principal (${latest?.currency ?? ""})`,
        color: colors.warning,
        style: "columns",
      }),
    ],
    [latest],
  );
  const historySeries = useMemo(
    () => [
      staticSeries(
        data
          ? recentDebtHistory(data).map((row) => ({
              date: new Date(row.asOf),
              observedAt: new Date(row.asOf),
              value: row.totalPrincipal,
            }))
          : [],
        {
          id: "debt-history",
          label: `Principal (${latest?.currency ?? ""})`,
          color: colors.warning,
          style: "columns",
          calendarSpaced: true,
        },
      ),
    ],
    [data, latest],
  );
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  const tabsInHeader = usePaneHeaderTabs(
    latest ? { tabs: TABS, activeValue: tab, onSelect: setTab, focused } : null,
  );
  const tabRows = tabsInHeader ? 0 : 1;
  const bodyHeight = Math.max(3, height - tabRows - 1);
  const tableHeight = Math.min(9, Math.max(4, bodyHeight - 3));
  const chartHeight = Math.max(0, bodyHeight - tableHeight - 4);
  const historyTableHeight = Math.min(
    history.length + 3,
    Math.max(4, Math.floor(bodyHeight * 0.6)),
  );
  const historyChartHeight = Math.max(0, bodyHeight - historyTableHeight - 1);
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
          ...(data.status !== "available"
            ? [
                {
                  id: "partial",
                  parts: [{ text: data.status, tone: "warning" as const }],
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
  ): DataTableCell => ({
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
                focused={focused}
              />
            )}
            {tab === "filing" ? (
              <FilingDetail latest={latest} width={width} height={bodyHeight} />
            ) : tab === "maturities" ? (
              <PageStackView
                focused={focused}
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
                rootContent={
                  <Box width={width} height={bodyHeight} flexDirection="column">
                    <Box
                      paddingX={1}
                      height={4}
                      flexShrink={0}
                      flexDirection="column"
                    >
                      <MetricRow
                        label="Principal total"
                        metric={latest.totalPrincipal}
                      />
                      <MetricRow
                        label="Due next 12 months"
                        metric={latest.next12MonthsShare}
                      />
                      <MetricRow
                        label="Due next 3 years"
                        metric={latest.next3YearsShare}
                      />
                      <KeyValueRow
                        labelWidth={20}
                        label="Filed"
                        value={latest.filed}
                        detail={latest.form}
                      />
                    </Box>
                    {chartHeight >= 4 ? (
                      <CompositeChart
                        series={series}
                        panels={PANELS}
                        width={width}
                        height={chartHeight}
                        showLegend={false}
                        navigable={false}
                        showTimeAxis
                        xAxis={BUCKET_AXIS}
                        formatAxisValue={amountAxis}
                        remoteKind="debt-maturity-wall"
                      />
                    ) : null}
                    <Box height={tableHeight} flexShrink={0}>
                      <DataTableView<DebtBucket, BucketColumn>
                        emptyStateTitle="No maturity buckets available."
                        focused={focused && !openBucketRow}
                        rootWidth={width}
                        rootHeight={tableHeight}
                        columns={BUCKET_COLUMNS}
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
                    </Box>
                  </Box>
                }
              />
            ) : (
              <PageStackView
                focused={focused}
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
                rootContent={
                  <Box width={width} height={bodyHeight} flexDirection="column">
                    <Box paddingX={1} height={1} flexShrink={0}>
                      <KeyValueRow
                        labelWidth={20}
                        label="Principal total"
                        value={latest.currency}
                        detail={`${latest.totalPrincipal.percentile.windowStart} to ${latest.asOf}`}
                      />
                    </Box>
                    {historyChartHeight >= 4 ? (
                      <CompositeChart
                        series={historySeries}
                        panels={PANELS}
                        width={width}
                        height={historyChartHeight}
                        showLegend={false}
                        navigable={false}
                        showTimeAxis
                        formatAxisValue={amountAxis}
                        remoteKind="debt-filing-history"
                      />
                    ) : null}
                    <Box height={historyTableHeight} flexShrink={0}>
                      <DataTableView<DebtHistoryPoint, HistoryColumn>
                        emptyStateTitle="No comparable filing history."
                        focused={focused && !openHistoryRow}
                        rootWidth={width}
                        rootHeight={historyTableHeight}
                        columns={HISTORY_COLUMNS}
                        items={history}
                        getItemKey={historyKey}
                        renderCell={renderHistory}
                        freezeFirstColumn
                        resetScrollKey={symbol}
                        selection={{
                          kind: "id",
                          selectedId:
                            selectedHistory ??
                            (history[0] ? historyKey(history[0]) : null),
                          getId: historyKey,
                          onChange: setSelectedHistory,
                        }}
                        onActivate={(row) => setOpenHistory(historyKey(row))}
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
                    </Box>
                  </Box>
                }
              />
            )}
          </>
        ) : null}
      </PaneStatusBody>
    </Box>
  );
}
