import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chartTableChromeRows, ChartTableHeader, CurveSurface, curveGhostColors, DataTableView, Notice, PaneStatusBody, QueryBar, useChartTableSelection, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, type DataTableColumn, type StatItem } from "../../../components";
import { curveStrip, curveSurfaceMinRows } from "../../../components/chart/curve";
import { isAccessDenied } from "../../../api-client/errors";
import type { FuturesContract } from "../../../api-client/futures-curve";
import { useAsyncResource, usePaneSettingValue, usePluginPaneState, useShortcut } from "../../../public/react";
import { usePaneInstance, usePaneTitle } from "../../../state/app/context";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, type InputRenderable } from "../../../ui";
import { formatPercentRaw } from "../../../utils/format";
import { nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { futuresSessionRefreshInterval } from "../shared/futures-session";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { getCachedFuturesCurve, loadFuturesCurve, loadFuturesCurveAsOf } from "./client";
import { curveAsOfDate, curveAxisPrice, curveChangeText, curveContractChanges, curvePrice, curveRank, curveTimestamp, DEFAULT_CURVE_HORIZON, futuresCurveSeries, newestQuote, normalizeCurveRoot, sortCurveContracts, type CurveContractChanges } from "./model";

const TABS = [{ value: "curve", label: "Curve" }, { value: "contracts", label: "Contracts" }];
const COLUMNS: DataTableColumn[] = [
  // The longest symbol is a three-letter root with its month and venue: RTYH27.CME.
  { id: "symbol", label: "CONTRACT", width: 11, align: "left" },
  { id: "expiry", label: "EXPIRY", width: 10, align: "left" },
  { id: "price", label: "PRICE", width: 12, align: "right" },
  // A Treasury change keeps its 1/256 tick: +0.11718750.
  { id: "change", label: "CHG", width: 11, align: "right" },
  { id: "percentile", label: "PCTL", width: 5, align: "right" },
  { id: "oi", label: "OPEN INT", width: 10, align: "right" },
  { id: "volume", label: "VOLUME", width: 10, align: "right" },
  { id: "asOf", label: "AS OF UTC", width: 16, align: "left" },
];
// The curve's rows move with the look-back curves drawn above them; the
// footer carries the quote time every row would otherwise repeat. The session
// change stays on Contracts, where the full table has the width for it.
const CURVE_COLUMNS: DataTableColumn[] = [
  ...COLUMNS.slice(0, 3),
  { id: "change1w", label: "VS 1W", width: 10, align: "right" },
  { id: "change1m", label: "VS 1M", width: 10, align: "right" },
  ...COLUMNS.slice(4, -1),
];
const signedPercent = (value: number | null) => value == null ? "--" : formatPercentRaw(value);
const integer = (value: number | null) => value == null ? "--" : value.toLocaleString("en-US");
const contractKey = (row: FuturesContract) => row.symbol;
// Left and Right step along the expiries, the way the curve reads.
const contractDate = (row: FuturesContract) => new Date(row.expiration);
const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function FuturesCurvePane(props: PaneProps) {
  const pane = usePaneInstance();
  const requested = pane?.settings?.root ?? pane?.params?.root ?? "ES";
  const root = normalizeCurveRoot(requested);
  return root ? <FuturesCurveView key={root} {...props} root={root} />
    : <PaneStatusBody error={`Unsupported futures root: ${String(requested)}`} subject="futures curve" />;
}

function FuturesCurveView({ width, height, focused, root }: PaneProps & { root: string }) {
  const colors = useThemeColors();
  const session = useResearchCloudSession();
  // A past date shows the curve as the settlement archive held it that day.
  const [requestedDate, setRequestedDate] = usePaneSettingValue<string>("asOfDate", "");
  const [draftDate, setDraftDate] = useState(requestedDate);
  const [dateError, setDateError] = useState<string | null>(null);
  const [dateActive, setDateActive] = useState(false);
  const [dateFocusToken, setDateFocusToken] = useState(0);
  const dateInput = useRef<InputRenderable>(null);
  // Leaving the field without Enter puts back the date the curve shows.
  useEffect(() => { if (!dateActive) setDraftDate(requestedDate); }, [dateActive, requestedDate]);
  const loader = useCallback(async (force: boolean) => ({ date: requestedDate,
    payload: requestedDate ? await loadFuturesCurveAsOf(root, requestedDate) : await loadFuturesCurve(root, force) }),
  [root, requestedDate, session.requestKey]);
  const resource = useAsyncResource(loader, { initialData: () => {
    const cached = requestedDate ? null : getCachedFuturesCurve(root);
    return cached ? { date: "", payload: cached } : null;
  }, clearOnError: isAccessDenied });
  const [tab, setTab] = usePluginPaneState("tab", "curve");
  const [selected, setSelected] = usePluginPaneState<string | null>("contract", null);
  const [sort, setSort] = useState<{ columnId: string; direction: SortDirection }>({ columnId: "expiry", direction: "asc" });
  const [horizon] = usePaneSettingValue("horizon", DEFAULT_CURVE_HORIZON);
  // A pending date change must never relabel the previous curve as the new one.
  const data = resource.data?.date === requestedDate ? resource.data.payload : null;
  usePaneTitle(`CTM ${root}`);
  const staleCount = data?.contracts.filter((row) => row.stale).length ?? 0;
  const newest = data ? newestQuote(data.contracts) : null;
  // A past curve is named by the session it holds: a weekend or holiday date shows the session before it.
  const curves = useMemo(() => data ? futuresCurveSeries(data, { current: colors.positive, ghosts: curveGhostColors(colors) }, horizon,
    requestedDate ? Date.parse(`${requestedDate}T00:00:00Z`) : Date.now(), requestedDate ? data.asOf ?? requestedDate : undefined) : [],
  [data, colors, horizon, requestedDate]);
  const changes = useMemo<CurveContractChanges>(() => data ? curveContractChanges(data) : new Map(), [data]);
  const rows = useMemo(() => sortCurveContracts(data?.contracts ?? [], sort.columnId, sort.direction, changes), [data, sort, changes]);
  const curveTab = tab === "curve";
  // The curve tab lists the contracts the chart plots; Contracts keeps every one.
  const curveRows = useMemo(() => {
    const charted = new Set(curves[0]?.points.map((point) => point.id));
    return rows.filter((row) => charted.has(row.symbol));
  }, [curves, rows]);
  const tableRows = curveTab ? curveRows : rows;
  const selectedId = tableRows.some((row) => row.symbol === selected) ? selected! : tableRows[0]?.symbol ?? null;
  useChartTableSelection({ rows: curveRows, getId: contractKey, getDate: contractDate, selectedId, onSelect: setSelected,
    focused, enabled: curveTab });
  // The highlighted row carries the selected contract's price and rank.
  const slopeDate = data?.slope.asOf && curveTimestamp(data.slope.asOf) !== curveTimestamp(newest) ? curveTimestamp(data.slope.asOf) : null;
  const statItems: StatItem[] = data ? [
    { id: "roll", label: "Ann. roll yield", value: signedPercent(data.slope.annualizedRollYield),
      detail: curveRank(data.slope.rollPercentile, data.slope.samples) },
    { id: "spread", label: "M2-M1", value: data.slope.value == null ? "--" : curvePrice(data.slope.value, root),
      detail: [data.slope.state, curveRank(data.slope.percentile, data.slope.samples), slopeDate].filter(Boolean).join(" · ") },
  ] : [];
  const { strip: tabStrip, rows: tabRows } = usePaneTabs({ tabs: TABS, activeValue: tab, onSelect: setTab, focused, dense: true });
  // The query bar takes one row below the tabs, and a refused date one more.
  const bodyHeight = Math.max(1, height - tabRows - 1 - (dateError ? 1 : 0));
  const columns = curveTab ? CURVE_COLUMNS : COLUMNS;
  const formatValue = useCallback((value: number) => curvePrice(value, root), [root]);
  const formatChange = useCallback((value: number) => curveChangeText(value, root), [root]);
  const caption = `${sentenceCase(data?.quoteUnit ?? data?.currency ?? "price")} by contract month`;
  // The strip keeps the curve's shape and the selected contract in one row.
  const strip = curveTab ? curveStrip(curves, formatValue, { caption: "Price", selectedPointId: selectedId }) : null;
  // Delayed contract quotes move all session; the curve follows them once a
  // minute while Globex trades and on the research cadence otherwise. A
  // settlement curve changes once a day.
  useAutoRefresh(resource.updatedAt, resource.load, {
    intervalMs: requestedDate || data?.source === "cboe" ? null : futuresSessionRefreshInterval(),
  });
  useShortcut((event) => {
    if (focused && !dateActive && !event.targetEditable && !event.ctrl && !event.meta && event.name === "r") {
      event.preventDefault(); void resource.reload();
    }
  });
  const selectDate = (value: string) => {
    try {
      const nextDate = curveAsOfDate(value);
      setRequestedDate(nextDate);
      setDraftDate(nextDate);
      setDateError(null);
      setDateActive(false);
      if (dateInput.current?.setCursorOffset) dateInput.current.setCursorOffset(0);
      else if (dateInput.current) dateInput.current.cursorOffset = 0;
      dateInput.current?.blur?.();
      if (nextDate === requestedDate) void resource.reload();
    } catch (error) {
      setDateError(error instanceof Error ? error.message : String(error));
    }
  };
  // A past date with no archived curve says why in the body, not behind the warning.
  const emptyPast = !!requestedDate && !!data && !data.contracts.length;
  usePaneNoticeFooter({ registrationId: "futures-curve:notices", focused, notices: emptyPast ? [] : data?.gaps ?? [] });
  const delay = Math.max(0, ...(data?.contracts.map((row) => row.delayMinutes ?? 0) ?? []));
  usePaneStatusFooter({ registrationId: "futures-curve", loading: resource.loading, error: resource.error,
    hints: [
      { id: "date", key: "d", label: "ate", onPress: () => { setDateActive(true); setDateFocusToken((token) => token + 1); } },
      ...requestedDate ? [{ id: "latest", key: "c", label: "urrent", title: "Current Curve", onPress: () => selectDate("") }] : [],
    ],
    info: data ? [
      { id: "source", parts: [{ text: `${requestedDate ? "daily archive" : data.source === "cboe" ? "settlement" : delay > 0 ? `${delay}m delayed` : "dated quotes"} · ${data.quoteUnit ?? data.currency ?? "units unavailable"} · ${curveTimestamp(newest)}${newest?.includes("T") ? " UTC" : ""}`, tone: "muted" }] },
      ...(staleCount ? [{ id: "stale", parts: [{ text: `${staleCount} of ${data.contracts.length} stale`, tone: "warning" as const }] }] : []),
    ] : [],
  });
  const tableChromeRows = chartTableChromeRows(columns, width);
  const chart = strip ? {
    render: (size: { width: number; height: number }) => <CurveSurface series={curves} width={size.width} height={size.height} display="chart"
      caption={caption} xScale="linear" formatValue={formatValue} formatChange={formatChange}
      formatAxisValue={(value, domain) => curveAxisPrice(value, domain, root)}
      selectedPointId={selectedId} onSelectedPointChange={setSelected} />,
    minRows: curveSurfaceMinRows({ series: curves, width, caption }),
    strip,
  } : null;
  const renderCell = useCallback((row: FuturesContract, column: DataTableColumn) => {
    if (column.id === "symbol") return { text: row.symbol };
    if (column.id === "expiry") return { text: row.expiration, color: colors.textMuted };
    // Without the AS OF column, a stale quote shows on its price.
    if (column.id === "price") return { text: curvePrice(row.price, root), color: curveTab && row.stale ? colors.warning : undefined };
    if (column.id === "change") {
      const text = curveChangeText(row.change ?? null, root);
      return { text, color: text.startsWith("+") ? colors.positive : text.startsWith("-") && /[1-9]/.test(text) ? colors.negative : colors.textMuted };
    }
    if (column.id === "change1w" || column.id === "change1m") {
      const change = changes.get(row.symbol)?.[column.id === "change1w" ? "1W" : "1M"] ?? null;
      return { text: curveChangeText(change, root), color: colors.textMuted };
    }
    if (column.id === "percentile") return { text: row.samples < 2 || row.percentile == null ? "--" : row.percentile.toFixed(0) };
    if (column.id === "oi") return { text: integer(row.openInterest) };
    if (column.id === "volume") return { text: integer(row.volume) };
    return { text: curveTimestamp(row.asOf), color: row.stale ? colors.warning : colors.textMuted };
  }, [changes, colors, curveTab, root]);
  return <Box width={width} height={height} flexDirection="column">
    {tabStrip}
    <QueryBar width={width} filters={[{
      id: "date", kind: "text", label: "Date", value: draftDate, placeholder: "latest", width: 10, debounceMs: 0,
      focused, active: dateActive, onActiveChange: setDateActive, focusToken: dateFocusToken, inputRef: dateInput,
      // Typing edits the draft; Enter applies it. Clearing the chip goes back to the live curve.
      onChange: (value: string) => {
        setDraftDate(value);
        if (!dateActive && !value.trim() && requestedDate) selectDate("");
      },
      onSubmit: selectDate,
    }]} meta={requestedDate && data?.asOf && data.asOf !== requestedDate ? `as of ${data.asOf}` : undefined} />
    {dateError ? <Notice tone="negative">{dateError}</Notice> : null}
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null}
      empty={!!data && !data.contracts.length} subject="futures curve"
      emptyTitle={emptyPast ? "No archived curve on this date." : undefined} emptyMessage={emptyPast ? data!.gaps.join(" ") || undefined : undefined}>
      {data ? <DataTableView columns={columns} items={tableRows} focused={focused}
        rootWidth={width} rootHeight={bodyHeight}
        selection={{ kind: "id", selectedId, getId: contractKey, onChange: setSelected }}
        onActivate={(row) => setSelected(row.symbol)} getItemKey={contractKey} renderCell={renderCell}
        sortColumnId={sort.columnId} sortDirection={sort.direction}
        onHeaderClick={(id) => setSort((current) => nextHeaderSort(current, id))}
        emptyStateTitle="No listed contracts available."
        // The Curve tab leaves the quote time to the footer; the export keeps it.
        getExportMetadata={() => curveTab && newest ? [[`as of${newest.includes("T") ? " UTC" : ""}`, curveTimestamp(newest)]] : []}
        rootBefore={<ChartTableHeader width={width} height={bodyHeight} figures={statItems} tableChromeRows={tableChromeRows}
          tableRows={tableRows.length}
          chart={chart} />} /> : null}
    </PaneStatusBody>
  </Box>;
}
