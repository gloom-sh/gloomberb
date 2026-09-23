import { useCallback, useMemo, useState } from "react";
import { CurveSurface, DataTableView, KeyValueRow, PaneStatusBody, Tabs, usePaneHeaderTabs, usePaneNoticeFooter, usePaneStatusFooter, type DataTableCell, type DataTableColumn } from "../../../components";
import { ApiRequestError } from "../../../api-client/errors";
import type { RateContract, RateMeeting } from "../../../api-client/rates";
import { useAsyncResource, usePluginPaneState, useShortcut } from "../../../public/react";
import { blendHex, colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { useAutoRefresh } from "../shared/auto-refresh";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { getCachedRatePath, loadRatePath } from "./client";
import { meetingProbability, percentileText, probabilityTargets, ratePathCurves, rateText } from "./model";

const TABS = [{ value: "path", label: "Path" }, { value: "probabilities", label: "Probabilities" }, { value: "contracts", label: "Contracts" }, { value: "projections", label: "Projections" }];
const clearDenied = (error: unknown) => error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);
const noop = () => {};
const MEETING_COLUMNS: DataTableColumn[] = [
  { id: "date", label: "MEETING", width: 12, align: "left" },
  { id: "rate", label: "EFFR", width: 9, align: "right" },
  { id: "change", label: "VS NOW", width: 9, align: "right" },
  { id: "percentile", label: "PCTL 1Y", width: 10, align: "right" },
  { id: "asOf", label: "AS OF UTC", width: 20, align: "left" },
];
const CONTRACT_COLUMNS: DataTableColumn[] = [
  { id: "symbol", label: "CONTRACT", width: 16, align: "left" },
  { id: "price", label: "PRICE", width: 10, align: "right" },
  { id: "rate", label: "IMPLIED", width: 10, align: "right" },
  { id: "percentile", label: "PCTL 1Y", width: 10, align: "right" },
  { id: "asOf", label: "AS OF UTC", width: 20, align: "left" },
];

function timestamp(value: string | null): string { return value?.replace("T", " ").slice(0, 16) ?? "--"; }
function percentile(value: number | null): string { return value == null ? "--" : value.toFixed(0); }
function meetingCell(row: RateMeeting, column: DataTableColumn): DataTableCell {
  if (column.id === "date") return { text: row.date };
  if (column.id === "rate") return { text: rateText(row.impliedRate) };
  if (column.id === "change") return { text: row.changeBps == null ? "--" : `${row.changeBps > 0 ? "+" : ""}${row.changeBps.toFixed(1)}bp`, color: row.changeBps == null ? colors.textDim : row.changeBps < 0 ? colors.positive : colors.negative };
  if (column.id === "percentile") return { text: percentile(row.percentile) };
  return { text: timestamp(row.asOf), color: colors.textDim };
}
function contractCell(row: RateContract, column: DataTableColumn): DataTableCell {
  if (column.id === "symbol") return { text: row.symbol };
  if (column.id === "price") return { text: row.price?.toFixed(3) ?? "--" };
  if (column.id === "rate") return { text: rateText(row.impliedRate) };
  if (column.id === "percentile") return { text: percentile(row.percentile) };
  return { text: timestamp(row.asOf), color: row.stale ? colors.warning : colors.textDim };
}

export function RatePathPane({ width, height, focused }: PaneProps) {
  const session = useResearchCloudSession();
  const loader = useCallback((force: boolean) => loadRatePath(force), [session.requestKey]);
  const resource = useAsyncResource(loader, { initialData: getCachedRatePath, clearOnError: clearDenied });
  const [tab, setTab] = usePluginPaneState("tab", "path");
  const [selected, setSelected] = usePluginPaneState<string | null>("meeting", null);
  const [sort, setSort] = useState({ id: "date", direction: "asc" as "asc" | "desc" });
  const tabsInHeader = usePaneHeaderTabs({ tabs: TABS, activeValue: tab, onSelect: setTab, focused });
  const tabRows = tabsInHeader ? 0 : 1;
  const data = resource.data;
  const curves = useMemo(() => data ? ratePathCurves(data, {
    path: colors.positive, ghosts: [colors.textMuted, colors.textDim], band: colors.warning, projection: colors.negative,
  }) : [], [data]);
  const meetings = useMemo(() => [...(data?.meetings ?? [])].sort((a, b) => {
    const key = { date: "date", rate: "impliedRate", change: "changeBps", percentile: "percentile", asOf: "asOf" }[sort.id] as keyof RateMeeting | undefined;
    const left = key ? a[key] : null, right = key ? b[key] : null;
    if (left == null) return right == null ? 0 : 1;
    if (right == null) return -1;
    const result = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    return sort.direction === "asc" ? result : -result;
  }), [data, sort]);
  const targets = useMemo(() => probabilityTargets(data?.meetings ?? []), [data]);
  const selectedMeeting = data?.meetings.find((meeting) => meeting.date === selected);
  // The meeting table only needs its rows; the chart takes whatever is left.
  const bodyHeight = Math.max(9, height - 3 - tabRows);
  const meetingTableHeight = Math.max(3, Math.min((data?.meetings.length ?? 0) + 2, Math.floor(bodyHeight * 0.5)));
  const pathHeight = Math.max(6, bodyHeight - meetingTableHeight);
  useAutoRefresh(resource.updatedAt, resource.load);
  useShortcut((event) => {
    if (focused && event.name === "r") { event.preventDefault(); void resource.reload(); }
  });
  usePaneNoticeFooter({ registrationId: "rate-path:notices", focused, notices: [
    ...(data?.gaps ?? []), ...(selectedMeeting?.reason ? [selectedMeeting.reason] : []),
  ] });
  usePaneStatusFooter({ registrationId: "rate-path", loading: resource.loading, error: resource.error,
    info: data ? [
      { id: "as-of", parts: [{ text: `as of ${timestamp(data.asOf)} UTC`, tone: "muted" }] },
      ...(data.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
      ...(data.status !== "available" ? [{ id: "partial", parts: [{ text: data.status, tone: "warning" as const }] }] : []),
    ] : [],
  });
  const selection = { kind: "id" as const, selectedId: selected, getId: (row: RateMeeting) => row.date, onChange: setSelected };
  const onHeaderClick = (id: string) => setSort((current) => ({ id, direction: current.id === id && current.direction === "asc" ? "desc" : "asc" }));
  return <Box width={width} height={height} flexDirection="column">
    {!tabsInHeader && <Tabs tabs={TABS} activeValue={tab} onSelect={setTab} focused={focused} dense />}
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null} empty={!resource.loading && !resource.error && !data} subject="rate path">
      {data ? <>
        <Box paddingX={1} flexShrink={0} flexDirection="column">
          <KeyValueRow label="EFFR" value={rateText(data.current.effr.value)} detail={`${percentileText(data.current.effr.percentile, data.current.effr.samples)} · ${data.current.effr.asOf ?? "--"}`} />
          <KeyValueRow label="Target range" value={`${rateText(data.current.targetLower.value)} to ${rateText(data.current.targetUpper.value)}`} detail={`${percentileText(data.current.targetUpper.percentile, data.current.targetUpper.samples)} · ${data.current.targetUpper.asOf ?? "--"}`} />
        </Box>
        {tab === "path" ? <>
          <CurveSurface series={curves} width={width} height={pathHeight} display="chart" valueLabel="Rate (%)" formatValue={rateText} formatX={(value) => new Date(value).toISOString().slice(0, 10)} selectedPointId={selected} onSelectedPointChange={setSelected}
            slope={data.slope ? { label: "Last-first", value: data.slope.valueBps, percentile: data.slope.percentile, window: "1Y", asOf: data.slope.asOf, formatValue: (value) => `${value > 0 ? "+" : ""}${value.toFixed(1)}bp` } : undefined} />
          <DataTableView columns={MEETING_COLUMNS} items={meetings} selection={selection} focused={focused} sortColumnId={sort.id} sortDirection={sort.direction} onHeaderClick={onHeaderClick} getItemKey={(row) => row.date} renderCell={meetingCell} rootHeight={meetingTableHeight} emptyStateTitle="No scheduled FOMC meetings" />
        </> : tab === "probabilities" ? <DataTableView
          columns={[MEETING_COLUMNS[0]!, ...targets.map((target) => {
            const halfWidth = data.current.targetLower.value != null && data.current.targetUpper.value != null
              ? (data.current.targetUpper.value - data.current.targetLower.value) / 2 : null;
            return { id: String(target), label: halfWidth == null ? `${target.toFixed(3)}%`
              : `${(target - halfWidth).toFixed(2)}-${(target + halfWidth).toFixed(2)}%`, width: 13, align: "right" as const };
          })]}
          items={data.meetings} selection={selection} focused={focused} sortColumnId={null} sortDirection="asc" onHeaderClick={noop}
          getItemKey={(row) => row.date} rootHeight={Math.max(3, height - 3 - tabRows)} emptyStateTitle="Meeting probabilities unavailable"
          renderCell={(row, column) => {
            if (column.id === "date") return { text: row.date };
            const probability = meetingProbability(row, Number(column.id));
            return { text: probability == null ? "--" : `${(probability * 100).toFixed(1)}%`,
              backgroundColor: probability == null ? undefined : blendHex(colors.bg, colors.positive, probability * 0.7),
              color: probability != null && probability > 0.65 ? colors.bg : colors.text };
          }} /> : tab === "contracts" ? <DataTableView columns={CONTRACT_COLUMNS} items={[...data.fedFunds, ...data.sofr]} selection={{ kind: "none" }} focused={focused} sortColumnId={null} sortDirection="asc" onHeaderClick={noop} getItemKey={(row) => row.symbol} renderCell={contractCell} rootHeight={Math.max(3, height - 3 - tabRows)} emptyStateTitle="Futures strip unavailable" />
          : <DataTableView columns={[
            { id: "year", label: "YEAR END", width: 14, align: "left" },
            { id: "rate", label: "SEP MEDIAN", width: 14, align: "right" },
            { id: "asOf", label: "AS OF", width: 12, align: "left" },
          ]} items={data.dotPlot.points} selection={{ kind: "none" }} focused={focused} sortColumnId={null} sortDirection="asc" onHeaderClick={noop} getItemKey={(row) => String(row.year)} rootHeight={Math.max(3, height - 3 - tabRows)} emptyStateTitle="Fed projections unavailable" renderCell={(row, column) => ({ text: column.id === "year" ? String(row.year) : column.id === "rate" ? rateText(row.rate) : data.dotPlot.asOf })} />}
      </> : null}
    </PaneStatusBody>
  </Box>;
}
