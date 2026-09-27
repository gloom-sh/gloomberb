import { useCallback, useMemo, useState } from "react";
import { chartTableChromeRows, ChartTableHeader, CurveSurface, curveGhostColors, DataTableView, formatPercentAxis, PaneStatusBody, useChartTableSelection, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, type DataTableCell, type DataTableColumn, type StatItem } from "../../../components";
import { curveStrip, curveSurfaceMinRows } from "../../../components/chart/curve";
import { isAccessDenied } from "../../../api-client/errors";
import type { RateContract, RateMeeting } from "../../../api-client/rates";
import { useAsyncResource, usePluginPaneState } from "../../../public/react";
import { blendHex, colors, priceColor } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { futuresSessionRefreshInterval } from "../shared/futures-session";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { getCachedRatePath, loadRatePath } from "./client";
import { meetingLabel, meetingMoves, meetingProbability, moveOddsText, movesPriced, movesText, percentileText, probabilityTargets, rateChangeText, ratePathCurves, rateText } from "./model";

const TABS = [{ value: "path", label: "Path" }, { value: "probabilities", label: "Probabilities" }, { value: "contracts", label: "Contracts" }, { value: "projections", label: "Projections" }];
// What is priced by and at each meeting leads, as on a rate probability monitor; the implied level follows.
const MEETING_COLUMNS: DataTableColumn[] = [
  { id: "date", label: "MEETING", width: 12, align: "left" },
  { id: "moves", label: "MOVES", width: 7, align: "right" },
  { id: "odds", label: "P(MOVE)", width: 10, align: "right" },
  { id: "change", label: "VS NOW", width: 9, align: "right" },
  { id: "rate", label: "EFFR", width: 9, align: "right" },
  { id: "percentile", label: "PCTL 1Y", width: 10, align: "right" },
  { id: "asOf", label: "AS OF UTC", width: 20, align: "left" },
];
const PROJECTION_COLUMNS: DataTableColumn[] = [
  { id: "year", label: "YEAR END", width: 14, align: "left" },
  { id: "rate", label: "SEP MEDIAN", width: 14, align: "right" },
  { id: "asOf", label: "AS OF", width: 12, align: "left" },
];
const CONTRACT_COLUMNS: DataTableColumn[] = [
  { id: "symbol", label: "CONTRACT", width: 16, align: "left" },
  { id: "price", label: "PRICE", width: 10, align: "right" },
  { id: "rate", label: "IMPLIED", width: 10, align: "right" },
  { id: "percentile", label: "PCTL 1Y", width: 10, align: "right" },
  { id: "asOf", label: "AS OF UTC", width: 20, align: "left" },
];

const CAPTION = "Implied EFFR % by FOMC meeting";
/** "Oct 28", the meeting's day without its year. */
function formatMeetingDay(date: string): string {
  return `${meetingLabel(date).slice(0, 3)} ${Number(date.slice(8, 10))}`;
}
const meetingKey = (row: RateMeeting) => row.date;
// Left and Right step along the meetings, the way the path reads.
const meetingDate = (row: RateMeeting) => new Date(row.date);

const DAY_MS = 86_400_000;

function timestamp(value: string | null): string { return value?.replace("T", " ").slice(0, 16) ?? "--"; }
function percentile(value: number | null): string { return value == null ? "--" : value.toFixed(0); }
/** Hikes up, cuts down, by the sign the text shows, so a move that rounds to zero stays neutral. */
function signColor(value: number | null, digits: number): string {
  return value == null || !Number.isFinite(value) ? colors.textDim : priceColor(Number(value.toFixed(digits)));
}
function bpText(value: number | null): string { return value == null ? "--" : rateChangeText(value / 100); }
/** Days to a meeting, counted in UTC dates like the schedule. */
function daysUntil(date: string, today = new Date().toISOString().slice(0, 10)): string {
  const days = Math.round((Date.parse(date) - Date.parse(today)) / DAY_MS);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}
function meetingCell(row: RateMeeting, column: DataTableColumn, moves: ReadonlyMap<string, number | null>): DataTableCell {
  if (column.id === "date") return { text: row.date };
  if (column.id === "moves") { const priced = movesPriced(row); return { text: movesText(priced), color: signColor(priced, 2) }; }
  if (column.id === "odds") return { text: moveOddsText(moves.get(row.date) ?? null) };
  if (column.id === "rate") return { text: rateText(row.impliedRate) };
  if (column.id === "change") return { text: bpText(row.changeBps), color: signColor(row.changeBps, 1) };
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
  const resource = useAsyncResource(loader, { initialData: getCachedRatePath, clearOnError: isAccessDenied });
  const [tab, setTab] = usePluginPaneState("tab", "path");
  const [selected, setSelected] = usePluginPaneState<string | null>("meeting", null);
  const [sort, setSort] = useState<{ columnId: string; direction: SortDirection }>({ columnId: "date", direction: "asc" });
  const [contract, setContract] = useState<string | null>(null);
  const { strip: tabStrip, rows: tabRows } = usePaneTabs({ tabs: TABS, activeValue: tab, onSelect: setTab, focused, dense: true });
  const data = resource.data;
  const curves = useMemo(() => data ? ratePathCurves(data, {
    // Ghosts match CTM's look-back colours, so the policy band takes the accent instead of yellow.
    path: colors.positive, ghosts: curveGhostColors(colors), band: colors.borderFocused, projection: colors.negative,
  }) : [], [data]);
  const moves = useMemo(() => meetingMoves(data?.meetings ?? []), [data]);
  const meetings = useMemo(() => [...(data?.meetings ?? [])].sort((a, b) => {
    const value = (row: RateMeeting): string | number | null => {
      switch (sort.columnId) {
        case "date": return row.date;
        case "moves": case "change": return row.changeBps;
        case "odds": return moves.get(row.date) ?? null;
        case "rate": return row.impliedRate;
        case "percentile": return row.percentile;
        case "asOf": return row.asOf;
        default: return null;
      }
    };
    const left = value(a), right = value(b);
    if (left == null) return right == null ? 0 : 1;
    if (right == null) return -1;
    const result = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    return sort.direction === "asc" ? result : -result;
  }), [data, moves, sort]);
  const targets = useMemo(() => probabilityTargets(data?.meetings ?? []), [data]);
  const contracts = useMemo(() => data ? [...data.fedFunds, ...data.sofr] : [], [data]);
  const selectedId = meetings.some((meeting) => meeting.date === selected) ? selected! : meetings[0]?.date ?? null;
  const selectedMeeting = data?.meetings.find((meeting) => meeting.date === selectedId);
  useChartTableSelection({ rows: meetings, getId: meetingKey, getDate: meetingDate, selectedId, onSelect: setSelected,
    focused, enabled: tab === "path" });
  // The footer carries the snapshot time, so a figure from the same day does
  // not repeat it; older dates (EFFR's lag, the slope's quote) stay.
  const footerDay = data?.asOf?.slice(0, 10) ?? null;
  const ownDate = (value: string | null | undefined) => value && value.slice(0, 10) !== footerDay ? value : null;
  // The next meeting's odds lead: what the market prices first.
  const byDate = data?.meetings.toSorted((a, b) => a.date.localeCompare(b.date)) ?? [];
  const next = byDate[0], last = byDate.at(-1);
  const nextMove = next ? moves.get(next.date) ?? null : null;
  const statItems: StatItem[] = data ? [
    ...(next ? [{ id: "next", label: "Next FOMC", value: moveOddsText(nextMove), color: nextMove == null ? undefined : signColor(nextMove, 2),
      detail: `${formatMeetingDay(next.date)} · ${daysUntil(next.date)}` }] : []),
    { id: "effr", label: "EFFR", value: rateText(data.current.effr.value),
      detail: [percentileText(data.current.effr.percentile), ownDate(data.current.effr.asOf)].filter(Boolean).join(" · ") },
    { id: "target", label: "Target range", value: `${rateText(data.current.targetLower.value)} to ${rateText(data.current.targetUpper.value)}`,
      detail: [percentileText(data.current.targetUpper.percentile), ownDate(data.current.targetUpper.asOf)].filter(Boolean).join(" · ") },
    // How far the path climbs or falls from the next meeting to the last one shown.
    ...(tab === "path" && data.slope && next && last && next !== last ? [{ id: "slope", label: `${meetingLabel(next.date)} to ${meetingLabel(last.date)}`,
      value: bpText(data.slope.valueBps),
      detail: [percentileText(data.slope.percentile), ownDate(data.slope.asOf) && timestamp(data.slope.asOf)].filter(Boolean).join(" · ") }] : []),
  ] : [];
  const bodyHeight = Math.max(1, height - tabRows);
  // A rank or quote time every meeting shares says nothing per row; the
  // columns stay only while the meetings differ.
  const varies = (text: (row: RateMeeting) => string) => new Set(meetings.map(text)).size > 1;
  const meetingColumns = MEETING_COLUMNS.filter((column) => column.id === "percentile" ? varies((row) => percentile(row.percentile))
    : column.id === "asOf" ? varies((row) => timestamp(row.asOf)) : true);
  const strip = tab === "path" ? curveStrip(curves, rateText, { caption: "Implied EFFR", selectedPointId: selectedId }) : null;
  const pathChart = strip ? {
    render: (size: { width: number; height: number }) => <CurveSurface series={curves} width={size.width} height={size.height} display="chart"
      caption={CAPTION} xScale="linear" formatValue={rateText} formatChange={rateChangeText}
      formatAxisValue={formatPercentAxis} selectedPointId={selectedId} onSelectedPointChange={setSelected} />,
    minRows: curveSurfaceMinRows({ series: curves, width, caption: CAPTION }),
    strip,
  } : null;
  // Every tab keeps the figures in the table's header zone; only Path draws the chart.
  const header = (columns: DataTableColumn[], rows: number, chart: typeof pathChart = null) => {
    const tableChromeRows = chartTableChromeRows(columns, width);
    return <ChartTableHeader width={width} height={bodyHeight} figures={statItems} tableChromeRows={tableChromeRows}
      tableRows={rows}
      chart={chart} />;
  };
  // Delayed contract quotes move all session; the curve follows them once a
  // minute while Globex trades and on the research cadence otherwise.
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: futuresSessionRefreshInterval() });
  usePaneRefreshKey(() => void resource.reload(), { focused });
  usePaneNoticeFooter({ registrationId: "rate-path:notices", focused, notices: [
    ...(data?.gaps ?? []), ...(selectedMeeting?.reason ? [selectedMeeting.reason] : []),
  ] });
  usePaneStatusFooter({ registrationId: "rate-path", loading: resource.loading, error: resource.error,
    info: data ? [{ id: "as-of", parts: [{ text: `as of ${timestamp(data.asOf)} UTC`, tone: "muted" }] }] : [],
    stale: data?.stale,
  });
  const selection = { kind: "id" as const, selectedId, getId: meetingKey, onChange: setSelected };
  const onHeaderClick = (id: string) => setSort((current) => nextHeaderSort(current, id));
  const halfWidth = data?.current.targetLower.value != null && data.current.targetUpper.value != null
    ? (data.current.targetUpper.value - data.current.targetLower.value) / 2 : null;
  const probabilityColumns: DataTableColumn[] = [MEETING_COLUMNS[0]!, ...targets.map((target) => ({ id: String(target),
    label: halfWidth == null ? `${target.toFixed(3)}%` : `${(target - halfWidth).toFixed(2)}-${(target + halfWidth).toFixed(2)}%`,
    width: 13, align: "right" as const }))];
  return <Box width={width} height={height} flexDirection="column">
    {tabStrip}
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null} empty={!resource.loading && !resource.error && !data} subject="rate path">
      {data ? tab === "path" ? <DataTableView columns={meetingColumns} items={meetings} selection={selection} focused={focused}
          sortColumnId={sort.columnId} sortDirection={sort.direction} onHeaderClick={onHeaderClick} getItemKey={meetingKey}
          renderCell={(row, column) => meetingCell(row, column, moves)}
          rootWidth={width} rootHeight={bodyHeight} emptyStateTitle="No scheduled FOMC meetings"
          // A column left out because every meeting shares it still belongs in the export.
          getExportMetadata={() => meetings[0] ? [
            ...(meetingColumns.some((column) => column.id === "percentile") ? [] : [["percentile 1Y", percentile(meetings[0].percentile)]]),
            ...(meetingColumns.some((column) => column.id === "asOf") ? [] : [["as of UTC", timestamp(meetings[0].asOf)]]),
          ] : []}
          rootBefore={header(meetingColumns, meetings.length, pathChart)} />
        : tab === "probabilities" ? <DataTableView
          columns={probabilityColumns}
          items={data.meetings} selection={selection} focused={focused} sortColumnId={null} sortDirection="asc"
          getItemKey={meetingKey} rootWidth={width} rootHeight={bodyHeight} emptyStateTitle="Meeting probabilities unavailable"
          rootBefore={header(probabilityColumns, data.meetings.length)}
          renderCell={(row, column) => {
            if (column.id === "date") return { text: row.date };
            const probability = meetingProbability(row, Number(column.id));
            return { text: probability == null ? "--" : `${(probability * 100).toFixed(1)}%`,
              backgroundColor: probability == null ? undefined : blendHex(colors.bg, colors.positive, probability * 0.7),
              color: probability != null && probability > 0.65 ? colors.bg : colors.text };
          }} /> : tab === "contracts" ? <DataTableView columns={CONTRACT_COLUMNS} items={contracts}
            // A read-only cursor, so j/k and the page keys reach every contract.
            selection={{ kind: "id", selectedId: contract, getId: (row) => row.symbol, onChange: setContract }} focused={focused} sortColumnId={null} sortDirection="asc" getItemKey={(row) => row.symbol} renderCell={contractCell}
            rootWidth={width} rootHeight={bodyHeight} emptyStateTitle="Futures strip unavailable" rootBefore={header(CONTRACT_COLUMNS, contracts.length)} />
          : <DataTableView columns={PROJECTION_COLUMNS} items={data.dotPlot.points} selection={{ kind: "none" }} focused={focused} sortColumnId={null} sortDirection="asc" getItemKey={(row) => String(row.year)}
            rootWidth={width} rootHeight={bodyHeight} emptyStateTitle="Fed projections unavailable" rootBefore={header(PROJECTION_COLUMNS, data.dotPlot.points.length)}
            renderCell={(row, column) => ({ text: column.id === "year" ? String(row.year) : column.id === "rate" ? rateText(row.rate) : data.dotPlot.asOf })} /> : null}
    </PaneStatusBody>
  </Box>;
}
