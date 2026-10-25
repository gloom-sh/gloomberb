import { useCallback, useMemo } from "react";
import type { BreadthDay } from "../../../api-client/members";
import { ChartTableHeader, DataTableView, PaneStatusBody, QueryBar, useChartTableSelection, usePaneNoticeFooter, usePaneStatusFooter, useTableLayoutWidth, type DataTableColumn } from "../../../components";
import { staticSeries } from "../../../components/chart/static/series";
import { fitChartTableColumns } from "../../../components/chart-table/layout";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneVisible, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { cachedBreadth, loadBreadth } from "./client";
import { useLiveSessionRefresh } from "../shared/volatility/live-session";
import { decimal } from "./model";

const percent = (value: number | null) => value == null ? "--" : `${value.toFixed(1)}%`;
const CHARTS = [{ value: "adLine", label: "A/D line" }, { value: "ma200", label: "Above 200D" }, { value: "ma50", label: "Above 50D" }, { value: "ma20", label: "Above 20D" }];
type Metric = "adLine" | "ma200" | "ma50" | "ma20";
const dateOf = (row: BreadthDay) => new Date(`${row.date}T00:00:00Z`);
const keyOf = (row: BreadthDay) => row.date;
const valueOf = (row: BreadthDay, metric: Metric) => metric === "adLine" ? row.adLine : row[metric].percent;
const COLUMNS: DataTableColumn[] = [
  { id: "date", label: "Date", width: 12, align: "left" },
  ...["advances", "declines", "unchanged", "ma20", "ma50", "ma200", "newHighs", "newLows", "coverage"].map((id, index) => ({
    id, label: ["Adv", "Dec", "Unch", ">20D %", ">50D %", ">200D %", "52W high", "52W low", "A/D covered"][index]!, width: index === 8 ? 13 : 10, flexGrow: 1, align: "right" as const,
  })),
];

export function Breadth({ fund, width, height, focused, active }: Pick<PaneProps, "width" | "height" | "focused"> & { fund: string; active: boolean }) {
  const colors = useThemeColors();
  const visible = usePaneVisible();
  const resource = useAsyncResource(useCallback((force: boolean) => loadBreadth(fund, force), [fund]), { initialData: useCallback(() => cachedBreadth(fund), [fund]) });
  const data = resource.data?.payload;
  const latest = data?.latest;
  const [metric, setMetric] = usePluginPaneState<Metric>("breadth:metric", "adLine");
  const [selected, setSelected] = usePluginPaneState<string | null>(`breadth:selected:${fund}`, null);
  const history = useMemo(() => data ? [...data.history, ...(data.basis === "intraday" && data.latest ? [data.latest] : [])] : [], [data]);
  const rows = useMemo(() => [...history].reverse(), [history]);
  const layoutWidth = useTableLayoutWidth(width);
  const columns = useMemo(() => fitChartTableColumns(COLUMNS, layoutWidth, ["unchanged", "ma20", "ma50", "coverage"]), [layoutWidth]);
  const series = useMemo(() => [staticSeries(history.map(row => ({ date: dateOf(row), observedAt: new Date(row.asOf), value: valueOf(row, metric) })), {
    id: `breadth-${metric}`, label: metric === "adLine" ? "Cumulative advances − declines" : `% above ${metric.slice(2)}-day average`,
    color: colors.warning, calendarSpaced: true,
  })], [history, metric, colors.warning]);
  const link = useChartTableSelection({ rows, getId: keyOf, getDate: dateOf, selectedId: selected ?? latest?.date ?? null, onSelect: setSelected, focused });
  const sessionOpen = useLiveSessionRefresh(() => resource.load(true), data?.access === "realtime" ? 15_000 : 60_000, active && visible, resource.updatedAt);
  useAutoRefresh(resource.updatedAt, () => { if (active && visible && !sessionOpen) void resource.load(data?.basis === "intraday"); });
  usePaneRefreshKey(() => void resource.reload(), { focused, enabled: active });
  usePaneStatusFooter({ registrationId: "members:breadth", loading: !!data && resource.loading,
    stale: !!data && (data.stale || resource.data!.stale || !!resource.error), info: latest ? [
      { id: "as-of", asOf: true, parts: [{ text: `${data?.basis === "intraday" ? data.access === "realtime" ? "live" : "15m delayed" : "close"} ${latest.date}`, tone: "muted" }] },
      { id: "coverage", parts: [{ text: `A/D ${latest.advanceDeclineEligible}/${latest.memberCount}`, tone: latest.advanceDeclineEligible < latest.memberCount * 0.8 ? "warning" : "muted" }] },
    ] : [] });
  usePaneNoticeFooter({ registrationId: "members:breadth-notices", focused, notices: [
    ...(resource.error || resource.data?.refreshError ? [resource.error ?? resource.data!.refreshError!] : []),
    ...(latest && [latest.advanceDeclineEligible, latest.ma20.eligible, latest.ma50.eligible, latest.ma200.eligible, latest.highLowEligible].some(n => n < latest.memberCount * 0.8)
      ? [`Partial coverage: A/D ${latest.advanceDeclineEligible}, 20D ${latest.ma20.eligible}, 50D ${latest.ma50.eligible}, 200D ${latest.ma200.eligible}, 52W ${latest.highLowEligible} of ${latest.memberCount} members. Missing windows are excluded.`] : []),
  ] });
  return <PaneStatusBody subject="fund breadth" loading={!data && resource.loading} error={!data ? resource.error : null}
    empty={!!data && !latest} emptyTitle="Breadth is awaiting daily price history.">
    {data && latest && <DataTableView<BreadthDay> items={rows} columns={columns} rootWidth={width} rootHeight={height} focused={focused}
      getItemKey={keyOf} selection={{ kind: "id", selectedId: selected ?? latest.date, getId: keyOf, onChange: id => setSelected(String(id)) }}
      sortColumnId="date" sortDirection="desc" freezeFirstColumn emptyStateTitle="No daily breadth history."
      renderCell={(row, column) => {
        if (column.id === "date") return { text: row.date };
        if (column.id === "coverage") return { text: `${row.advanceDeclineEligible}/${row.memberCount}` };
        if (column.id === "ma20" || column.id === "ma50" || column.id === "ma200") return { text: percent(row[column.id].percent), value: row[column.id].percent };
        const value = row[column.id as "advances"];
        const eligible = column.id === "newHighs" || column.id === "newLows" ? row.highLowEligible : row.advanceDeclineEligible;
        return { text: eligible ? decimal(value, 0) : "--", value: eligible ? value : null,
          color: column.id === "advances" || column.id === "newHighs" ? colors.positive : column.id === "declines" || column.id === "newLows" ? colors.negative : colors.text };
      }}
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={columns}
        query={<QueryBar width={width} meta="History uses current members (survivorship bias)." filters={[{ kind: "select", id: "chart", label: "History", value: metric, options: CHARTS, onChange: value => setMetric(value as Metric) }]} />}
        figures={[
          { label: "Adv / Dec", value: latest.advanceDeclineEligible ? `${latest.advances} / ${latest.declines}` : "--", detail: `${latest.unchanged} unchanged` },
          ...([20, 50, 200] as const).map(window => ({ label: `Above ${window}D`, value: percent(latest[`ma${window}`].percent), detail: `${latest[`ma${window}`].eligible}/${latest.memberCount} covered` })),
          { label: "52W high / low", value: latest.highLowEligible ? `${latest.newHighs} / ${latest.newLows}` : "--", detail: `${latest.highLowEligible}/${latest.memberCount} covered` },
        ]}
        chart={{ series, ...link, formatValue: metric === "adLine" ? value => decimal(value, 0) : percent,
          formatAxisValue: metric === "adLine" ? value => decimal(value, 0) : percent, remoteKind: "member-breadth", empty: "History is awaiting sufficient daily bars." }} />}
    />}
  </PaneStatusBody>;
}
