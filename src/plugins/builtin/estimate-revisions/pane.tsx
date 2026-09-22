import { useCallback, useEffect, useMemo } from "react";
import { Box, ScrollBox } from "../../../ui";
import {
  useAsyncResource,
  useAutoRefresh,
  usePaneSettingValue,
  usePluginPaneState,
  useShortcut,
} from "../../../public/react";
import {
  CompositeChart,
  DataTableStackView,
  DataTableView,
  EmptyState,
  KeyValueRow,
  PaneStatusBody,
  Prose,
  Tabs,
  usePaneNoticeFooter,
  usePaneStatusLinkFooter,
  usePaneTicker,
  type DataTableColumn,
} from "../../../components";
import { ApiRequestError } from "../../../api-client/errors";
import type {
  EstimatePeriod,
  EstimateSurprise,
} from "../../../api-client/estimate-revisions";
import { staticSeries } from "../../../components/chart/static/series";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { canonicalExchange } from "../../../utils/exchanges";
import { isPlainKey } from "../../../utils/keyboard";
import { SignInWall } from "../cloud/auth-actions";
import {
  isCloudSessionRequired,
  useResearchCloudSession,
} from "../shared/research-cloud-session";
import { cachedEstimates, loadEstimates } from "./client";
import {
  estimateCurrent,
  estimateHistory,
  estimateNumber as number,
  estimatePercent as percent,
  estimatePoints,
  PERIOD_COLUMNS,
  periodLabel,
  periodRank,
  pinnedEstimatePeriods,
  revisionNotices,
  sortPeriods,
} from "./model";

import {
  nextEstimateSort,
  sortEstimateHistory,
  sortEstimateSurprises,
  sortGuidanceSources,
  type EstimateSort,
} from "./sorting";

const clearDeniedEstimates = (error: unknown) =>
  error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);

const TABS = [
  { value: "revisions", label: "Revisions" },
  { value: "surprises", label: "Surprises" },
  { value: "guidance", label: "Guidance" },
];
const PANELS = [{ id: "main" }];
const GUIDANCE_COLUMNS: DataTableColumn[] = [
  ...PERIOD_COLUMNS.filter((column) =>
    ["period", "currency", "eps", "percentile", "asOf"].includes(column.id),
  ),
  { id: "source", label: "SOURCE", width: 12, align: "left" },
];
const HISTORY: DataTableColumn[] = [
  { id: "date", label: "OBSERVED", width: 12, align: "left" },
  { id: "average", label: "EPS", width: 11, align: "right" },
  { id: "low", label: "LOW", width: 10, align: "right" },
  { id: "high", label: "HIGH", width: 10, align: "right" },
  { id: "analysts", label: "ANALYSTS", width: 10, align: "right" },
  { id: "source", label: "SOURCE", width: 20, align: "left", flexGrow: 1 },
];
const SURPRISE: DataTableColumn[] = [
  { id: "date", label: "DATE", width: 12, align: "left" },
  { id: "dateType", label: "DATE TYPE", width: 18, align: "left" },
  { id: "currency", label: "CCY", width: 5, align: "left" },
  { id: "estimate", label: "EST EPS", width: 10, align: "right" },
  { id: "actual", label: "ACT EPS", width: 10, align: "right" },
  { id: "percent", label: "SURPRISE %", width: 12, align: "right" },
  { id: "percentile", label: "PCTL 1Y", width: 9, align: "right" },
];
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
  const series = useMemo(
    () => [
      staticSeries(estimatePoints(period.recorded), {
        id: "recorded",
        label: "Cloud observations",
        color: colors.positive,
        calendarSpaced: true,
      }),
      staticSeries(estimatePoints(period.lookbacks), {
        id: "lookbacks",
        label: "Provider lookbacks",
        color: colors.warning,
        calendarSpaced: true,
      }),
    ],
    [period, colors],
  );
  const chartHeight = Math.max(4, Math.floor((height - 6) * 0.6));
  const breadth = period.breadth.find((row) => row.days === 30);
  return (
    <Box width={width} height={height} flexDirection="column">
      <Box paddingX={1} flexDirection="column" flexShrink={0}>
        <KeyValueRow
          labelWidth={16}
          label={`EPS ${period.currency ?? "?"}`}
          value={number(current?.average)}
          detail={`${periodRank(period)} · ${current?.date ?? "--"}`}
        />
        <KeyValueRow
          labelWidth={16}
          label="Change"
          value={percent(period.change.percent)}
          detail={`${period.change.fromDate ?? "--"} to ${period.change.toDate ?? "--"}`}
        />
        <KeyValueRow
          labelWidth={16}
          label="Analyst range"
          value={`${number(current?.low)} to ${number(current?.high)}`}
          detail={`${number(current?.analysts)} analysts · ${current?.date ?? "--"}`}
        />
        <KeyValueRow
          labelWidth={16}
          label="Up/down 30D"
          value={`${number(breadth?.up)} / ${number(breadth?.down)}`}
          detail={`${breadth?.asOf ?? "--"} · breadth ${breadth?.ratio == null ? "--" : percent(breadth.ratio * 100)}`}
        />
        {period.revenue ? (
          <KeyValueRow
            labelWidth={16}
            label={`Revenue ${period.revenue.currency ?? "?"}`}
            value={number(period.revenue.average)}
            detail={period.revenue.asOf ?? "--"}
          />
        ) : null}
      </Box>
      {rows.some((row) => row.average != null) ? (
        <CompositeChart
          series={series}
          panels={PANELS}
          width={width}
          height={chartHeight}
          showTimeAxis
          showLegend
          navigable={false}
          formatAxisValue={number}
          remoteKind="estimate-revision-history"
        />
      ) : (
        <EmptyState title="No observed revision history." />
      )}
      <DataTableView
        columns={HISTORY}
        items={rows}
        focused={focused}
        rootWidth={width}
        rootHeight={Math.max(3, height - chartHeight - 5)}
        selection={{
          kind: "id",
          selectedId: selected,
          getId: (row) => `${row.source}:${row.date}`,
          onChange: setSelected,
        }}
        getItemKey={(row) => `${row.source}:${row.date}`}
        onActivate={(row) => setSelected(`${row.source}:${row.date}`)}
        sortColumnId={historySort.column}
        sortDirection={historySort.direction}
        onHeaderClick={(column) =>
          setHistorySort((old) => nextEstimateSort(old, column))
        }
        renderCell={(row, column) => ({
          text:
            column.id === "date"
              ? row.date
              : column.id === "source"
                ? row.source === "yahoo"
                  ? "Collected"
                  : "Provider lookback"
                : number(
                    row[column.id as "average" | "low" | "high" | "analysts"],
                  ),
          color: row.source === "yahoo" ? colors.text : colors.warning,
        })}
        emptyStateTitle="No stored observations."
      />
    </Box>
  );
}
export function EstimateRevisionsPane({ width, height, focused }: PaneProps) {
  const { ticker, symbol } = usePaneTicker(),
    session = useResearchCloudSession(),
    colors = useThemeColors();
  const exchange = canonicalExchange(ticker?.metadata.exchange ?? "");
  const loader = useCallback(
    (force: boolean) => loadEstimates(symbol!, exchange, force),
    [symbol, exchange, session.requestKey],
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
  const guidanceRows = useMemo(
    () =>
      sortGuidanceSources(
        rows.filter((row) => estimateCurrent(row) !== null),
        sort,
      ),
    [rows, sort],
  );
  const selectedPeriod = rows.find((row) => row.id === open);
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
  useShortcut((event) => {
    if (focused && isPlainKey(event, "r")) {
      event.preventDefault();
      void resource.reload();
    }
  });
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
  if (!symbol) return <EmptyState title="Select a ticker." />;
  if (!data && isCloudSessionRequired(resource.error))
    return (
      <SignInWall
        action="view estimate revisions"
        needsVerification={session.needsVerification}
      />
    );
  const bodyHeight = Math.max(3, height - 1);
  const guidanceTableHeight = Math.min(
    Math.max(2, guidanceRows.length + 1),
    Math.max(2, bodyHeight - 3),
  );
  return (
    <Box width={width} height={height} flexDirection="column">
      <Tabs
        tabs={TABS}
        activeValue={tab}
        onSelect={setTab}
        focused={focused && !selectedPeriod}
        dense
      />
      <PaneStatusBody
        loading={resource.loading && !data}
        error={!data ? resource.error : null}
        subject="estimate revisions"
      >
        {data && tab === "revisions" ? (
          <DataTableStackView<EstimatePeriod>
            columns={PERIOD_COLUMNS}
            items={rows}
            focused={focused}
            rootWidth={width}
            rootHeight={bodyHeight}
            selection={{
              kind: "id",
              selectedId: selected,
              getId: (row) => row.id,
              onChange: setSelected,
            }}
            getItemKey={(row) => row.id}
            onActivate={(row) => setOpen(row.id)}
            detailOpen={!!selectedPeriod}
            onBack={() => setOpen(null)}
            detailTitle={
              selectedPeriod ? periodLabel(selectedPeriod) : undefined
            }
            detailContent={
              selectedPeriod ? (
                <EstimateDetail
                  period={selectedPeriod}
                  width={width}
                  height={Math.max(3, bodyHeight - 2)}
                  focused={focused}
                />
              ) : null
            }
            sortColumnId={sort.column}
            sortDirection={sort.direction}
            onHeaderClick={(column) =>
              setSort((old) => ({
                column,
                direction:
                  old.column === column && old.direction === "desc"
                    ? "asc"
                    : "desc",
              }))
            }
            renderCell={(row, column) => {
              const current = estimateCurrent(row),
                breadth = row.breadth.find((r) => r.days === 30);
              return {
                text:
                  column.id === "period"
                    ? periodLabel(row)
                    : column.id === "currency"
                      ? (row.currency ?? "--")
                      : column.id === "eps"
                        ? number(current?.average)
                        : column.id === "percentile"
                          ? number(row.percentile.percentile)
                          : column.id === "change"
                            ? percent(row.change.percent)
                            : column.id === "range"
                              ? number(current?.range)
                              : column.id === "breadth"
                                ? `${number(breadth?.up)}/${number(breadth?.down)}`
                                : (current?.date ?? "--"),
                color: colors.text,
              };
            }}
            emptyStateTitle="No covered estimate periods."
          />
        ) : null}
        {data && tab === "surprises" ? (
          <DataTableView<EstimateSurprise>
            columns={SURPRISE}
            items={surpriseRows}
            focused={focused}
            rootWidth={width}
            rootHeight={bodyHeight}
            selection={{
              kind: "id",
              selectedId: surprise,
              getId: (row) => `${row.date}:${row.dateType}`,
              onChange: setSurprise,
            }}
            getItemKey={(row) => `${row.date}:${row.dateType}`}
            onActivate={(row) => setSurprise(`${row.date}:${row.dateType}`)}
            sortColumnId={surpriseSort.column}
            sortDirection={surpriseSort.direction}
            onHeaderClick={(column) =>
              setSurpriseSort((old) => nextEstimateSort(old, column))
            }
            renderCell={(row, column) => ({
              text:
                column.id === "date"
                  ? row.date
                  : column.id === "dateType"
                    ? row.dateType
                    : column.id === "currency"
                      ? (row.currency ?? "--")
                      : column.id === "percent"
                        ? percent(row.percent)
                        : number(
                            row[
                              column.id as "actual" | "estimate" | "percentile"
                            ],
                          ),
            })}
            emptyStateTitle="No comparable reported earnings."
          />
        ) : null}
        {data && tab === "guidance" ? (
          <Box width={width} height={bodyHeight} flexDirection="column">
            <ScrollBox
              flexGrow={1}
              flexBasis={0}
              minHeight={3}
              width={width}
              scrollY
              focusable={false}
              paddingX={1}
            >
              {data.guidance ? (
                <>
                  <KeyValueRow
                    labelWidth={16}
                    label="Call"
                    value={data.guidance.callDate?.slice(0, 10) ?? "--"}
                    detail={`FY${data.guidance.fiscalYear} Q${data.guidance.fiscalQuarter}`}
                  />
                  <KeyValueRow
                    labelWidth={16}
                    label="Summary updated"
                    value={data.guidance.publishedAt
                      .replace("T", " ")
                      .slice(0, 16)}
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
            <Box height={guidanceTableHeight} flexShrink={0} width={width}>
              <DataTableView<EstimatePeriod>
                columns={GUIDANCE_COLUMNS}
                items={guidanceRows}
                focused={focused}
                rootWidth={width}
                rootHeight={guidanceTableHeight}
                selection={{
                  kind: "id",
                  selectedId: selected,
                  getId: (row) => row.id,
                  onChange: setSelected,
                }}
                getItemKey={(row) => row.id}
                onActivate={(row) => {
                  setOpen(row.id);
                  setTab("revisions");
                }}
                sortColumnId={sort.column}
                sortDirection={sort.direction}
                onHeaderClick={(column) =>
                  setSort((old) => ({
                    column,
                    direction:
                      old.column === column && old.direction === "desc"
                        ? "asc"
                        : "desc",
                  }))
                }
                renderCell={(row, column) => ({
                  text:
                    column.id === "period"
                      ? periodLabel(row)
                      : column.id === "currency"
                        ? (row.currency ?? "--")
                        : column.id === "eps"
                          ? number(estimateCurrent(row)?.average)
                          : column.id === "percentile"
                            ? number(row.percentile.percentile)
                            : column.id === "source"
                              ? row.current
                                ? "Current"
                                : "Collected"
                              : (estimateCurrent(row)?.date ?? "--"),
                })}
                emptyStateTitle="No observed fiscal-period consensus."
              />
            </Box>
          </Box>
        ) : null}
      </PaneStatusBody>
    </Box>
  );
}
