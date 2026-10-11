import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chartTableChromeRows, ChartTableHeader, CurveSurface, curveGhostColors, DataTableView, Notice, PaneStatusBody, QueryBar, useChartTableSelection, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, type DataTableColumn, type StatItem } from "../../../components";
import { fitChartTableColumns } from "../../../components/chart-table";
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
import { useQuoteBoard } from "../shared/use-quote-board";
import { getCachedFuturesCurve, loadFuturesCurve, loadFuturesCurveAsOf } from "./client";
import { basisSpotSymbol, curveAsOfDate, curveAxisPrice, curveBasisPercent, curveBasisRows, curveChangeText, curveContractChanges, curveContractCode, curvePrice, curveRank, curveSpot, curveSpotLabel, curveSpreadLabel, curveTickText, curveTimestamp, curveUnitLabel, DEFAULT_CURVE_HORIZON, futuresCurveSeries, newestQuote, normalizeCurveRoot, sortCurveContracts, thinContractCount, thinContractsNotice, unsupportedCurveRootMessage, type CurveContractChanges } from "./model";

const TABS = [{ value: "curve", label: "Curve" }, { value: "contracts", label: "Contracts" }];
// One column order for every root. SETTLE is the exchange settlement for the
// curve's settlement session, LAST the latest trade; the header dates SETTLE.
const COLUMNS: DataTableColumn[] = [
  // The longest symbol is a three-letter root with its month and venue: RTYH27.CME.
  { id: "symbol", label: "CONTRACT", width: 11, align: "left" },
  { id: "expiry", label: "EXPIRY", width: 10, align: "left" },
  { id: "notice", label: "1ST NOTICE", width: 10, align: "left" },
  // A Treasury price keeps its 1/256 tick: 103.50000000.
  { id: "settle", label: "SETTLE", width: 12, align: "right" },
  { id: "price", label: "LAST", width: 12, align: "right" },
  // A Treasury change keeps its 1/256 tick: +0.11718750.
  { id: "change", label: "CHG", width: 11, align: "right" },
  { id: "percentile", label: "PCTL", width: 5, align: "right" },
  { id: "oi", label: "OPEN INT", width: 10, align: "right" },
  { id: "volume", label: "VOLUME", width: 10, align: "right" },
  { id: "asOf", label: "AS OF UTC", width: 16, align: "left" },
];
const CONTRACTS_DROP_ORDER = ["percentile", "volume", "oi", "notice"];
const column = (id: string) => COLUMNS.find((entry) => entry.id === id)!;
// The curve's rows move with the look-back curves drawn above them; the
// footer carries the quote time every row would otherwise repeat. The session
// change stays on Contracts, where the full table has the width for it.
const CURVE_COLUMNS: DataTableColumn[] = [
  column("symbol"), column("expiry"), column("settle"), column("price"),
  { id: "change1w", label: "VS 1W", width: 10, align: "right" },
  { id: "change1m", label: "VS 1M", width: 10, align: "right" },
  column("percentile"), column("oi"), column("volume"),
];
const CURVE_DROP_ORDER = ["percentile", "volume", "change1m", "oi"];
// A crypto curve also reads against spot. Its widths are the tightest each column
// holds (BTCV26.CME, 128000.00), so the two new columns fit beside the rest, and
// a narrow pane drops the least useful ones before a number would be clipped.
const BASIS_CURVE_COLUMNS: DataTableColumn[] = [
  { ...column("symbol"), width: 10 }, column("expiry"), { ...column("settle"), width: 10 }, { ...column("price"), width: 10 },
  { id: "vsSpot", label: "VS SPOT", width: 9, align: "right" },
  { id: "annBasis", label: "ANN BASIS", width: 11, align: "right" },
  ...CURVE_COLUMNS.slice(4),
];
const BASIS_DROP_ORDER = ["percentile", "volume", "change1m", "oi", "settle"];
const NO_SYMBOLS: string[] = [];
/** The spot's age is judged against the clock, so a quote that stops moving still goes stale on screen. */
const SPOT_CLOCK_MS = 30_000;
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
    : <PaneStatusBody error={unsupportedCurveRootMessage(requested)} subject="futures curve" />;
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
  const curveTab = tab === "curve";
  // The Curve tab of a crypto root reads against spot; a past date has no spot history.
  const spotSymbol = basisSpotSymbol(root);
  const basisActive = curveTab && !requestedDate && spotSymbol != null;
  const spotSymbols = useMemo(() => basisActive ? [spotSymbol] : NO_SYMBOLS, [basisActive, spotSymbol]);
  const { quotes: spotQuotes } = useQuoteBoard(spotSymbols);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!basisActive) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), SPOT_CLOCK_MS);
    return () => clearInterval(timer);
  }, [basisActive]);
  const spotState = spotSymbol ? spotQuotes.get(spotSymbol) : undefined;
  // Until the first answer there is nothing to say: no reason, only blank cells.
  const spot = useMemo(() => !basisActive || !spotSymbol || !spotState || spotState.loading && !spotState.quote ? null
    : curveSpot(spotSymbol, spotState.quote, clock), [basisActive, clock, spotState, spotSymbol]);
  const staleCount = data?.contracts.filter((row) => row.stale).length ?? 0;
  const newest = data ? newestQuote(data.contracts) : null;
  // A past curve is named by the session it holds: a weekend or holiday date shows the session before it.
  const curves = useMemo(() => data ? futuresCurveSeries(data, { current: colors.positive, ghosts: curveGhostColors(colors) }, horizon,
    requestedDate ? Date.parse(`${requestedDate}T00:00:00Z`) : Date.now(), requestedDate ? data.asOf ?? requestedDate : undefined) : [],
  [data, colors, horizon, requestedDate]);
  const changes = useMemo<CurveContractChanges>(() => data ? curveContractChanges(data) : new Map(), [data]);
  const basis = useMemo(() => curveBasisRows(basisActive ? data?.contracts ?? [] : [], spot), [basisActive, data, spot]);
  const thinCount = useMemo(() => thinContractCount(basis.values()), [basis]);
  const rows = useMemo(() => sortCurveContracts(data?.contracts ?? [], sort.columnId, sort.direction, changes, basis), [data, sort, changes, basis]);
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
    // Named by the contracts it subtracts: the front is the first month the market trades, not always the first row.
    { id: "spread", label: curveSpreadLabel(data.slope), value: data.slope.value == null ? "--" : curvePrice(data.slope.value, root),
      detail: [data.slope.state, curveRank(data.slope.percentile, data.slope.samples), slopeDate].filter(Boolean).join(" · ") },
    ...data.spec ? [{ id: "contract", label: "Contract", value: data.spec.size, detail: `tick ${curveTickText(data.spec)}` }] : [],
  ] : [];
  const { strip: tabStrip, rows: tabRows } = usePaneTabs({ tabs: TABS, activeValue: tab, onSelect: setTab, focused, dense: true });
  // The query bar takes one row below the tabs, and a refused date one more.
  const bodyHeight = Math.max(1, height - tabRows - 1 - (dateError ? 1 : 0));
  // A Cboe price is the settlement itself, so its curve has no separate last trade.
  const settlesOnly = data?.source === "cboe";
  const settleLabel = data?.settlementDate ? `SETTLE ${data.settlementDate.slice(5)}` : "SETTLE";
  // Cash-settled roots (ES, CL's Brent, VX) have no first notice day to show.
  const noNotice = !data?.contracts.some((row) => row.firstNotice);
  const columns = useMemo(() => {
    // Labelled before fitting: a dated header is wider than the column's numbers.
    const shown = (list: DataTableColumn[]) => list.filter((entry) => !(settlesOnly && entry.id === "price") && !(noNotice && entry.id === "notice"))
      .map((entry) => entry.id === "settle" ? { ...entry, label: settleLabel } : entry);
    return !curveTab ? fitChartTableColumns(shown(COLUMNS), width, CONTRACTS_DROP_ORDER)
      : basisActive ? fitChartTableColumns(shown(BASIS_CURVE_COLUMNS), width, BASIS_DROP_ORDER)
        : fitChartTableColumns(shown(CURVE_COLUMNS), width, CURVE_DROP_ORDER);
  }, [basisActive, curveTab, noNotice, settleLabel, settlesOnly, width]);
  const formatValue = useCallback((value: number) => curvePrice(value, root), [root]);
  const formatChange = useCallback((value: number) => curveChangeText(value, root), [root]);
  const unit = data ? curveUnitLabel(data) : null;
  const caption = `${sentenceCase(unit ?? "price")} by contract month`;
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
  // Thin contracts join the data warnings: the info row has no room for them beside the quote times.
  // A long in these can be assigned delivery: the hedge a trader rolls before first notice.
  const delivering = data?.contracts.filter((row) => row.inDelivery).map((row) => curveContractCode(row.symbol)) ?? [];
  usePaneNoticeFooter({ registrationId: "futures-curve:notices", focused,
    notices: emptyPast ? [] : [...data?.gaps ?? [], ...thinCount ? [thinContractsNotice(thinCount)] : [],
      ...delivering.length ? [`${delivering.join(", ")} ${delivering.length === 1 ? "is" : "are"} past first notice.`] : []] });
  const delay = Math.max(0, ...(data?.contracts.map((row) => row.delayMinutes ?? 0) ?? []));
  usePaneStatusFooter({ registrationId: "futures-curve", loading: resource.loading, error: resource.error,
    hints: [
      { id: "date", key: "d", label: "ate", onPress: () => { setDateActive(true); setDateFocusToken((token) => token + 1); } },
      ...requestedDate ? [{ id: "latest", key: "c", label: "urrent", title: "Current Curve", onPress: () => selectDate("") }] : [],
    ],
    info: data ? [
      { id: "source", parts: [{ text: `${requestedDate ? "daily archive" : data.source === "cboe" ? "settlement" : delay > 0 ? `${delay}m delayed` : "dated quotes"} · ${unit ?? "units unavailable"} · ${curveTimestamp(newest)}${newest?.includes("T") ? " UTC" : ""}`, tone: "muted" }] },
      ...(staleCount ? [{ id: "stale", parts: [{ text: `${staleCount} of ${data.contracts.length} stale`, tone: "warning" as const }] }] : []),
      ...(spot ? [{ id: "spot", parts: [spot.status === "ok" ? { text: curveSpotLabel(spot, root, clock), tone: "muted" as const }
        : { text: `Basis blank: ${spot.reason}`, tone: "warning" as const }] }] : []),
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
    // A contract past first notice can be assigned delivery.
    if (column.id === "symbol") return { text: row.symbol, color: row.inDelivery ? colors.warning : undefined };
    if (column.id === "expiry") return { text: row.lastTrade ?? row.expiration, color: colors.textMuted };
    if (column.id === "notice") return { text: row.firstNotice ?? "--", color: row.inDelivery ? colors.warning : colors.textMuted };
    if (column.id === "settle") return { text: curvePrice(row.settlement ?? null, root) };
    // A past curve's settled row has no separate last trade: its price is the settlement.
    if (column.id === "price") {
      const lastTrade = requestedDate && row.settlement != null ? null : row.price;
      // Beside its settlement the last trade is the secondary price; without one it is the row's price.
      return { text: curvePrice(lastTrade, root), color: curveTab && (row.stale || basis.get(row.symbol)?.thin) ? colors.warning
        : row.settlement != null ? colors.textMuted : undefined };
    }
    if (column.id === "change") {
      const text = curveChangeText(row.change ?? null, root);
      return { text, color: text.startsWith("+") ? colors.positive : text.startsWith("-") && /[1-9]/.test(text) ? colors.negative : colors.textMuted };
    }
    if (column.id === "change1w" || column.id === "change1m") {
      const change = changes.get(row.symbol)?.[column.id === "change1w" ? "1W" : "1M"] ?? null;
      return { text: curveChangeText(change, root), color: colors.textMuted };
    }
    if (column.id === "vsSpot" || column.id === "annBasis") {
      const cell = basis.get(row.symbol);
      return { text: column.id === "vsSpot" ? curveBasisPercent(cell?.vsSpotPct ?? null, 2) : curveBasisPercent(cell?.annualisedBasisPct ?? null, 1), color: colors.textMuted };
    }
    if (column.id === "percentile") return { text: row.samples < 2 || row.percentile == null ? "--" : row.percentile.toFixed(0) };
    if (column.id === "oi") return { text: integer(row.openInterest) };
    if (column.id === "volume") return { text: integer(row.volume) };
    return { text: curveTimestamp(row.asOf), color: row.stale ? colors.warning : colors.textMuted };
  }, [basis, changes, colors, curveTab, requestedDate, root]);
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
