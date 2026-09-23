import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableView, EmptyState, PaneStatusBody, SelectButton, Tabs, usePaneFooter, usePaneNoticeFooter,
  usePaneTicker, type DataTableColumn, type DataTableKeyEvent } from "../../../components";
import { useTableLoadMore } from "../../../components/table-view-shared";
import { useStaticChartBitmapSize } from "../../../components/chart/composite/bitmap";
import { useAsyncResource } from "../../../react/async-resource";
import { useTickerFinancials } from "../../../market-data/hooks";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { blendHex } from "../../../theme/color-utils";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, type ScrollBoxRenderable } from "../../../ui";
import { resolveOptionsTarget } from "../../../utils/options";
import { buildOptionCalcParams, OPTIONS_CALCULATOR_TEMPLATE_ID } from "../options-calculator/model";
import { formatStrikeLabel } from "../options/table";
import { useAutoRefresh } from "../shared/auto-refresh";
import { loadVolatilitySurface } from "./client";
import { loadStoredSurface, loadSurfaceDates } from "../iv-history/client";
import { formatIvRank, useIvRank } from "../iv-history/rank";
import { storedSurfaceSnapshot, type DatedSurfaceSnapshot } from "./stored";
import { useVolSurfaceEvidence } from "./evidence";
import { buildSurfaceGrid, DEFAULT_SURFACE_SETTINGS, windowSurfaceGrid, type SurfaceExpiry, type SurfaceGridRow,
  type SurfaceSettings, type SurfaceSnapshot } from "./model";
import { DEFAULT_SURFACE_CAMERA, rotateSurfaceCamera, zoomSurfaceCamera, type SurfaceCamera } from "./raster";
import { VolatilitySurface } from "./surface";
import { expiryLabel, formatIv, formatPrice, SmileChart, TermChart } from "./charts";

const TABS = [
  { value: "surface", label: "3D surface" }, { value: "table", label: "Table" },
  { value: "smile", label: "Smile" }, { value: "term", label: "Term" },
  { value: "skew", label: "Skew" }, { value: "forwards", label: "Forwards" },
];
type Axis = "spot" | "forward" | "delta" | "strike";
const DEFAULT_EXPIRY_MIN_DAYS = 28;
/** Annualising a few days of parity carry produces meaningless yields. */
const DIVIDEND_YIELD_MIN_DAYS = 30;

export function VolSurfacePane({ focused, width, height }: PaneProps) {
  const colors = useThemeColors();
  const tableHeight = Math.max(3, height - 4);
  const bitmapAvailable = !!useStaticChartBitmapSize(width, tableHeight);
  const { symbol, ticker, financials } = usePaneTicker();
  const { createPaneFromTemplate } = usePluginAppActions();
  const target = resolveOptionsTarget(ticker);
  const underlyingFinancials = useTickerFinancials(target?.isOptionTicker ? target.effectiveTicker : null, null);
  const [activeTab, setActiveTab] = usePluginPaneState("activeTabId", "surface");
  const [axis] = usePaneSettingValue<Axis>("axis", "spot");
  const [tenors] = usePaneSettingValue<"listed" | "fixed">("tenors", "listed");
  const [ivSource] = usePaneSettingValue<SurfaceSettings["ivSource"]>("ivSource", "recomputed");
  const [priceSide] = usePaneSettingValue<SurfaceSettings["priceSide"]>("priceSide", "mid");
  const [spread] = usePaneSettingValue("maxRelativeSpread", "0.5");
  const [age] = usePaneSettingValue("maxStaleSessions", "5");
  const [overlaySmiles] = usePaneSettingValue("overlaySmiles", false);
  const [expiration, setExpiration] = usePaneSettingValue<number | null>("expiration", null);
  const [requestedExpiration, setRequestedExpiration] = useState(expiration);
  const expirationRef = useRef(expiration);
  expirationRef.current = expiration;
  const [surfaceCoordinate, setSurfaceCoordinate] = usePluginPaneState("surfaceCoordinate", 1);
  const [coordinate, setCoordinate] = usePluginPaneState("coordinate", 1);
  const [limit, setLimit] = usePluginPaneState("expiryLimit", 18);
  const [camera, setCamera] = usePluginPaneState<SurfaceCamera>("camera", DEFAULT_SURFACE_CAMERA);
  const [fixedYears, setFixedYears] = usePluginPaneState<number | null>("fixedYears", null);
  const [historyDate, setHistoryDate] = usePluginPaneState<string | null>("historyDate", null);
  const [sort, setSort] = useState<{ id: string; direction: "asc" | "desc" }>({ id: "tenor", direction: "asc" });
  const controller = useRef<AbortController | null>(null);
  const [partial, setPartial] = useState<{ key: string; snapshot: SurfaceSnapshot } | null>(null);
  const quote = (target?.isOptionTicker ? underlyingFinancials : financials)?.quote;
  const spotAvailable = !!quote && quote.price > 0 && Number.isFinite(quote.price) && !quote.stale;
  const spotAsOfRef = useRef(quote?.lastUpdated ?? null);
  spotAsOfRef.current = quote?.lastUpdated ?? null;
  const spotRef = useRef(quote?.price ?? 0);
  spotRef.current = quote?.price ?? 0;
  const requestKey = JSON.stringify([target?.cacheKey, symbol, axis, tenors, ivSource, priceSide, spread, age, limit, spotAvailable, requestedExpiration]);
  const request = useCallback(async (force: boolean) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const instrument = target?.instrument;
    return loadVolatilitySurface({
      instrument: { symbol: target?.effectiveTicker ?? symbol!, exchange: target?.effectiveExchange ?? "",
        brokerId: instrument?.brokerId, brokerInstanceId: instrument?.brokerInstanceId, instrument },
      spot: spotRef.current, spotAsOf: spotAsOfRef.current, limit, forceRefresh: force, signal: abort.signal,
      requiredExpiries: expirationRef.current == null ? [] : [expirationRef.current],
      settings: { ...DEFAULT_SURFACE_SETTINGS, ivSource, priceSide, maxRelativeSpread: Number(spread), maxStaleSessions: Number(age) },
      onSnapshot: (snapshot) => { if (!abort.signal.aborted) setPartial({ key: requestKey, snapshot }); },
    });
  // Stable quote reference prevents every streaming tick from restarting all expiry requests.
  }, [requestKey]);
  const resource = useAsyncResource(symbol && spotAvailable && !historyDate ? request : null);
  // Stored close surfaces and IV rank come from the Cloud IV history of the underlying.
  const underlying = (target?.effectiveTicker ?? symbol ?? "").toUpperCase();
  const datesLoader = useCallback(async () => (await loadSurfaceDates(underlying)).dates, [underlying]);
  const dates = useAsyncResource(underlying ? datesLoader : null);
  const ivRank = useIvRank(underlying || null);
  useEffect(() => () => controller.current?.abort(), [request]);
  useAutoRefresh(resource.updatedAt, resource.load);
  const incremental = partial?.key === requestKey ? partial.snapshot : null;
  const liveSnapshot = incremental && (incremental.loaded > 0 || !resource.data) ? incremental : resource.data;
  // Outside regular hours the delayed chain publishes zero bids, so nothing is two-sided.
  // Judged on the last complete load, so a refresh in progress does not flip the view.
  const liveQuotes = liveQuoteCoverage(resource.data);
  const liveEmpty = liveQuotes.empty && liveQuoteCoverage(liveSnapshot).points === 0;
  // With no clean live quote, the latest stored close stands in until the chain reopens.
  const fallbackDate = !historyDate && liveEmpty ? dates.data?.[0] ?? null : null;
  const shownDate = historyDate ?? fallbackDate;
  const storedLoader = useCallback(async () => storedSurfaceSnapshot(await loadStoredSurface(underlying, shownDate!)), [underlying, shownDate]);
  const stored = useAsyncResource(underlying && shownDate ? storedLoader : null);
  const active = shownDate ? stored : resource;
  const snapshot: DatedSurfaceSnapshot | null | undefined = shownDate ? stored.data : liveSnapshot;
  useEffect(() => {
    // Existing slices only change selection. A new pin causes one load and then
    // remains in the request identity after its partial snapshots arrive.
    if (expiration == null || expiration === requestedExpiration || resource.loading || !snapshot
      || snapshot.expiries.some((entry) => entry.expiration === expiration)
      || !snapshot.catalogue.includes(expiration)) return;
    setRequestedExpiration(expiration);
  }, [expiration, requestedExpiration, resource.loading, snapshot]);
  const grid = useMemo(() => snapshot ? buildSurfaceGrid(snapshot, { axis, tenors }) : null, [axis, snapshot, tenors]);
  const denseGrid = useMemo(() => snapshot ? windowSurfaceGrid(buildSurfaceGrid(snapshot, { axis: "forward", tenors: "listed",
    coordinates: Array.from({ length: 41 }, (_, i) => 0.8 + i * 0.01) }), snapshot) : null, [snapshot]);
  // A one-day front expiry is the noisiest smile on the board; the default
  // selection is the first expiry at least four weeks out.
  const defaultExpiry = snapshot?.expiries.find((entry) => entry.years * 365 >= DEFAULT_EXPIRY_MIN_DAYS) ?? snapshot?.expiries[0];
  const selectedExpiry = snapshot?.expiries.find((entry) => entry.expiration === (expiration ?? defaultExpiry?.expiration)) ?? null;
  const openChain = useCallback(() => {
    if (!snapshot) return;
    const selected = expiration ?? selectedExpiry?.expiration;
    createPaneFromTemplate("options-pane", { symbol: symbol ?? snapshot.symbol, ticker, instrument: target?.instrument,
      ...(ticker ? { listing: { name: ticker.metadata.name, exchange: ticker.metadata.exchange,
        currency: ticker.metadata.currency, type: ticker.metadata.assetCategory ?? "STK" } } : {}),
      values: selected == null ? {} : { expiration: String(selected) },
    });
  }, [createPaneFromTemplate, expiration, selectedExpiry?.expiration, snapshot?.symbol, symbol, ticker, target?.instrument]);
  useVolSurfaceEvidence({ snapshot, view: activeTab, grid: activeTab === "surface" && bitmapAvailable ? denseGrid : grid,
    selectedExpiry, loading: active.loading, bitmapAvailable, axis: activeTab === "surface" && bitmapAvailable ? "forward" : axis,
    tenors: activeTab === "surface" && bitmapAvailable ? "listed" : tenors, overlaySmiles });
  const tableSelectedRow = grid?.rows.find((row) => tenors === "fixed"
    ? row.years === (fixedYears ?? grid.rows[0]?.years) : row.expiration === selectedExpiry?.expiration) ?? null;
  const nearestIndex = (row: SurfaceGridRow | null, value: number) => row?.cells.reduce((best, cell, index) =>
    Math.abs(cell.coordinate - value) < Math.abs(row.cells[best]!.coordinate - value) ? index : best, 0) ?? 0;
  const denseSelectedRow = denseGrid?.rows.find((row) => row.expiration === selectedExpiry?.expiration) ?? null;
  const selectedRow = activeTab === "surface" && bitmapAvailable ? denseSelectedRow : tableSelectedRow;
  const cellIndex = nearestIndex(selectedRow, activeTab === "surface" && bitmapAvailable ? surfaceCoordinate : coordinate);
  const tableCellIndex = nearestIndex(tableSelectedRow, coordinate);
  const selectedCell = selectedRow?.cells[cellIndex];
  const canLoadMore = !shownDate && !!snapshot && snapshot.requested < snapshot.catalogue.length && !resource.loading;
  const loadMore = useCallback(() => { if (canLoadMore) setLimit((current) => current + 12); }, [canLoadMore, setLimit]);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const onScroll = useTableLoadMore(scrollRef, canLoadMore, loadMore);
  const onSelectRow = (row: SurfaceGridRow) => {
    if (row.expiration != null) setExpiration(row.expiration);
    else setFixedYears(row.years);
  };
  const openPricer = () => {
    if (!snapshot || !selectedCell?.volatility || !selectedCell.strike || !selectedRow) return;
    const params = buildOptionCalcParams({ symbol: snapshot.symbol, spot: snapshot.spot,
      strike: selectedCell.strike, volatility: selectedCell.volatility, side: selectedCell.point?.side ?? "call",
      expiration: selectedRow.expiration, dividendYield: selectedRow.dividendYield,
      marketPrice: selectedCell.point?.strike === selectedCell.strike ? selectedCell.point.price : undefined });
    params.days = String(selectedRow.years * 365);
    if (selectedRow.rate != null) params.rate = String(selectedRow.rate);
    if (selectedRow.dividendYield != null) params.dividendYield = String(selectedRow.dividendYield);
    createPaneFromTemplate(OPTIONS_CALCULATOR_TEMPLATE_ID, { values: params });
  };
  const cycleTab = () => setActiveTab(TABS[(TABS.findIndex((tab) => tab.value === activeTab) + 1) % TABS.length]!.value);
  const nextExpiry = (direction: number) => {
    if (!snapshot?.expiries.length) return;
    const index = snapshot.expiries.findIndex((entry) => entry.expiration === selectedExpiry?.expiration);
    const next = snapshot.expiries[Math.max(0, Math.min(snapshot.expiries.length - 1, index + direction))];
    if (next) setExpiration(next.expiration);
  };
  const storedDates = dates.data ?? [];
  const toggleHistory = () => setHistoryDate(historyDate ? null : storedDates[0] ?? null);
  /** Dates run newest first: a positive step goes back in time; stepping past the newest returns to live. */
  const stepHistory = (step: number) => {
    const index = storedDates.indexOf(historyDate ?? "");
    const next = index + step;
    setHistoryDate(next < 0 ? null : storedDates[Math.min(storedDates.length - 1, next)] ?? historyDate);
  };
  const handleKey = (event: DataTableKeyEvent): boolean => {
    if (event.ctrl || event.meta || event.alt) return false;
    const key = event.name;
    if (key === "r") { void active.reload(); void dates.reload(); }
    else if (key === "v") cycleTab();
    else if (key === "t") toggleHistory();
    else if ((key === "," || key === ".") && historyDate) stepHistory(key === "," ? 1 : -1);
    else if (key === "p") openPricer();
    else if (key === "m" && canLoadMore) loadMore();
    else if (key === "[") nextExpiry(-1);
    else if (key === "]") nextExpiry(1);
    else if (key === "c" && snapshot) openChain();
    else if (activeTab === "surface" && bitmapAvailable && ["left", "right", "up", "down", "h", "j", "k", "l", "+", "=", "-", "0"].includes(key ?? "")) {
      setCamera((value) => key === "0" ? DEFAULT_SURFACE_CAMERA : ["+", "=", "-"].includes(key!)
        ? zoomSurfaceCamera(value, key === "-" ? 1 / 1.08 : 1.08)
        : rotateSurfaceCamera(value, ["left", "h"].includes(key!) ? -0.1 : ["right", "l"].includes(key!) ? 0.1 : 0,
          ["up", "k"].includes(key!) ? 0.07 : ["down", "j"].includes(key!) ? -0.07 : 0));
    } else if ((activeTab === "table" || activeTab === "surface" && !bitmapAvailable) && ["left", "right"].includes(key ?? "") && selectedRow) {
      const next = selectedRow.cells[Math.max(0, Math.min(selectedRow.cells.length - 1, cellIndex + (key === "right" ? 1 : -1)))];
      if (next) setCoordinate(next.coordinate);
    } else return false;
    event.preventDefault?.(); event.stopPropagation?.(); return true;
  };
  useShortcut((event) => { if (focused && !["table", "skew", "forwards"].includes(activeTab) && !(activeTab === "surface" && !bitmapAvailable)) handleKey(event); });
  const failures = snapshot?.failures.map((failure) => `${failure.expiration ? expiryLabel(failure.expiration) : "Catalogue"}: ${failure.message}`) ?? [];
  const notices = [...(snapshot?.warnings ?? []), ...failures,
    ...(snapshot?.expiries.flatMap((entry) => entry.warnings.map((warning) => `${expiryLabel(entry.expiration)}: ${warning}`)) ?? []),
    ...(!spotAvailable && symbol && !historyDate ? ["Underlying price unavailable or stale"] : []),
    ...(historyDate && !stored.loading && !stored.data && !stored.error ? [`No stored ${underlying} surface for ${historyDate}`] : []),
    ...(fallbackDate ? [`Live chain has no two-sided quotes; showing the ${fallbackDate} close`] : []),
    ...(expiration != null && snapshot && !resource.loading && !snapshot.catalogue.includes(expiration)
      ? [`${expiryLabel(expiration)}: selected expiration unavailable`] : []),
    ...(active.error ? [active.error] : [])];
  const arbitrageWarnings = snapshot?.warnings.filter((warning) => /calendar|butterfly/i.test(warning)).length ?? 0;
  usePaneNoticeFooter({ registrationId: "ovdv-notices", notices: [...new Set(notices)], focused });
  usePaneFooter("ovdv", () => ({
    info: [
      ...(arbitrageWarnings ? [{ id: "arbitrage", parts: [{ text: `${arbitrageWarnings} arbitrage warnings`, tone: "warning" as const }] }] : []),
      ...(snapshot ? [{ id: "progress", parts: [{ text: `${snapshot.loaded}/${snapshot.requested} expiries`, tone: "muted" as const }] }] : []),
      ...(active.loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(snapshot ? [{ id: "source", parts: [{ text: snapshot.stored ? `stored close ${snapshot.stored.sessionDate}`
        : snapshot.expiries.some((entry) => entry.dataSource === "live") ? "mixed / live" : "delayed", tone: "muted" as const }] }] : []),
      ...(snapshot?.expiries.some((entry) => entry.stale) ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
      ...(selectedExpiry?.fit && activeTab === "smile" ? [{ id: "fit", parts: [{ text: `${selectedExpiry.fit.method} · RMSE ${(selectedExpiry.fit.residual * 100).toFixed(3)} vol pts`, tone: "muted" as const }] }] : []),
    ],
    hints: [
      { id: "view", key: "v", label: "iew", onPress: cycleTab },
      ...(snapshot ? [{ id: "chain", key: "c", label: "hain", onPress: openChain }] : []),
      ...(selectedCell?.volatility ? [{ id: "pricer", key: "p", label: "rice", onPress: openPricer }] : []),
      ...(canLoadMore ? [{ id: "more", key: "m", label: "ore expiries", onPress: loadMore }] : []),
      ...(activeTab === "surface" && bitmapAvailable ? [{ id: "reset", key: "0", label: "reset view", onPress: () => setCamera(DEFAULT_SURFACE_CAMERA) }] : []),
      ...(storedDates.length ? [{ id: "history", key: "t", label: historyDate ? " live" : " stored dates", onPress: toggleHistory }] : []),
    ],
  }), [snapshot, active.loading, historyDate, storedDates, selectedExpiry, activeTab, selectedCell, canLoadMore, camera, bitmapAvailable, arbitrageWarnings, openChain]);
  const exportMetadata = () => [["method", ...(snapshot?.stored ? ["recomputed", "mid", `stored close ${snapshot.stored.sessionDate}`, snapshot.stored.capturedAt] : [ivSource, priceSide])], ["filters", JSON.stringify(snapshot?.settings)],
    ["underlying", snapshot?.symbol, snapshot?.spot], ["rate source", "Treasury", snapshot?.rateAsOf],
    ["warnings", ...notices], ...(snapshot?.expiries.map((expiry) => ["expiry", expiryLabel(expiry.expiration), expiry.asOf,
      expiry.fit?.method, expiry.fit?.residual, expiry.rateMethod, JSON.stringify(expiry.filterCounts)]) ?? [])];
  const columns: DataTableColumn[] = [{ id: "tenor", label: "Expiry / tenor", width: 18, align: "left" },
    ...(grid?.rows[0]?.cells.map((cell, index) => ({ id: String(index), width: 10, align: "right" as const,
      label: axis === "delta" ? ["10dP", "25dP", "ATM", "25dC", "10dC"][index] ?? String(cell.coordinate)
        : axis === "strike" ? formatStrikeLabel(cell.coordinate) : `${Math.round(cell.coordinate * 100)}%` })) ?? [])];
  const sortedRows = [...(grid?.rows ?? [])].sort((a, b) => {
    const delta = sort.id === "tenor" ? a.years - b.years : (a.cells[Number(sort.id)]?.volatility ?? -1) - (b.cells[Number(sort.id)]?.volatility ?? -1);
    return sort.direction === "asc" ? delta : -delta;
  });
  const table = <DataTableView<SurfaceGridRow> focused={focused} rootWidth={width} rootHeight={tableHeight}
    columns={columns} items={sortedRows} getItemKey={(row) => row.label} scrollRef={scrollRef} onBodyScrollActivity={onScroll}
    sortColumnId={sort.id} sortDirection={sort.direction} onHeaderClick={(id) => setSort({ id, direction: sort.id === id && sort.direction === "asc" ? "desc" : "asc" })}
    selection={{ kind: "id", selectedId: tableSelectedRow?.label ?? null, getId: (row) => row.label, onChange: (_id, row) => onSelectRow(row) }}
    onActivate={onSelectRow} onRootKeyDown={handleKey} getExportMetadata={exportMetadata} freezeFirstColumn
    renderCell={(row, column) => {
      if (column.id === "tenor") return { text: `${row.label}${row.extrapolated ? " E" : row.interpolated ? " I" : ""}`, color: colors.textDim };
      const index = Number(column.id), cell = row.cells[index]!;
      const chosen = row.label === tableSelectedRow?.label && index === tableCellIndex;
      return { text: formatIv(cell.volatility), color: chosen ? colors.selectedText : colors.textBright,
        backgroundColor: chosen ? colors.selected : cell.volatility == null ? colors.bg : blendHex(colors.bg, cell.volatility > 0.5 ? colors.warning : colors.positive, Math.min(0.48, 0.08 + cell.volatility * 0.5)),
        onMouseDown: () => { onSelectRow(row); setCoordinate(cell.coordinate); } };
    }} emptyStateTitle="No volatility observations." />;
  const content = !shownDate && liveEmpty ? <EmptyState title="No two-sided option quotes"
    message={`${liveQuotes.zeroBid === liveQuotes.contracts ? "All" : `${liveQuotes.zeroBid.toLocaleString()} of`} ${liveQuotes.contracts.toLocaleString()} contracts across ${liveQuotes.expiries} expiries have a zero bid${liveQuotes.zeroBid === liveQuotes.contracts ? "" : ", and none of the rest passes the quote filters"}. The delayed feed publishes zero bids outside regular hours (09:30 to 16:00 New York); the surface fills in when quotes return.`} />
    : activeTab === "surface" && denseGrid ? <VolatilitySurface width={width} height={tableHeight}
    grid={denseGrid} camera={camera} onCameraChange={setCamera} selected={{
      tenorIndex: denseGrid.tenors.findIndex((years) => years === selectedExpiry?.years),
      moneynessIndex: selectedCell?.strike && selectedExpiry?.forward
        ? denseGrid.moneyness.reduce((best, value, index) => Math.abs(value - selectedCell.strike! / selectedExpiry.forward!) < Math.abs(denseGrid.moneyness[best]! - selectedCell.strike! / selectedExpiry.forward!) ? index : best, 0) : 20,
    }} onSelect={(selection) => {
      const expiry = snapshot?.expiries.find((entry) => entry.years === denseGrid.tenors[selection.tenorIndex]);
      if (expiry) setExpiration(expiry.expiration);
      setSurfaceCoordinate(denseGrid.moneyness[selection.moneynessIndex] ?? 1);
    }} fallback={table} /> : activeTab === "smile" && snapshot ? <SmileChart snapshot={snapshot} expiry={selectedExpiry}
      overlay={overlaySmiles} axis={axis} width={width} height={tableHeight} />
      : activeTab === "term" && snapshot ? <TermChart snapshot={snapshot} width={width} height={tableHeight} />
      : ["skew", "forwards"].includes(activeTab) && snapshot ? <ExpiryTable snapshot={snapshot} selected={selectedExpiry}
        onSelect={(entry) => setExpiration(entry.expiration)} forwards={activeTab === "forwards"} width={width} height={tableHeight}
        focused={focused} onKey={handleKey} metadata={exportMetadata} /> : table;
  return <Box flexDirection="column" width={width} height={height} overflow="hidden">
    <Tabs tabs={TABS} activeValue={activeTab} onSelect={setActiveTab} variant="underline" dense focused={focused && activeTab !== "surface"} />
    {!symbol ? <EmptyState title="Choose an underlying ticker." /> : <PaneStatusBody loading={active.loading && !snapshot}
      error={!snapshot ? active.error : null} empty={!snapshot && !active.loading} subject="volatility surface">
      <Box height={1} flexDirection="row" paddingX={1} gap={2}>
        <SelectButton label="Expiry" value={String(expiration ?? selectedExpiry?.expiration ?? "")} options={snapshot?.catalogue.map((value) => ({ value: String(value), label: expiryLabel(value) })) ?? []}
          onChange={(value) => setExpiration(Number(value))} />
        {storedDates.length ? <SelectButton label="Date" value={shownDate ?? ""} onChange={(value) => setHistoryDate(value || null)}
          options={[{ value: "", label: "Live" }, ...storedDates.map((date) => ({ value: date, label: date }))]} /> : null}
        <Text fg={colors.textDim}>{snapshot?.stored
          ? `Stored close · spot ${formatPrice(snapshot.spot)} · captured ${formatCaptureTime(snapshot.stored.capturedAt)} New York · mid IV`
          : `Spot ${formatPrice(snapshot?.spot)} ${quote?.currency ?? ""} · ${ivSource === "provider" ? "provider IV" : `${priceSide} IV`}${selectedExpiry?.asOf ? ` · ${selectedExpiry.asOf.slice(0, 10)}` : ""}${ivRank ? ` · IV30 ${(ivRank.value * 100).toFixed(1)}% IVR ${formatIvRank(ivRank)} close` : ""}`}</Text>
      </Box>
      {content}
      <Box height={1} paddingX={1} overflow="hidden"><Text fg={colors.textDim}>{selectedCell?.point
        ? `Nearest ${selectedCell.point.contract.contractSymbol} · mid ${formatPrice(selectedCell.point.mid)} · spread ${formatPrice(selectedCell.point.spread)} · OI ${selectedCell.point.openInterest} · residual ${formatIv(selectedCell.fitResidual)}`
        : selectedCell?.volatility != null ? `${selectedRow?.label} · K ${selectedCell.strike == null ? "--" : formatStrikeLabel(selectedCell.strike)} · fitted IV ${formatIv(selectedCell.volatility)}` : "No clean quoted cell selected"}</Text></Box>
    </PaneStatusBody>}
  </Box>;
}

const CAPTURE_TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function formatCaptureTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? CAPTURE_TIME.format(time) : "--";
}
/** Whether a settled live chain produced any clean quote, with the filter counts that explain why not. */
export function liveQuoteCoverage(snapshot: SurfaceSnapshot | null | undefined) {
  const expiries = snapshot?.expiries.filter((entry) => entry.state !== "loading") ?? [];
  const points = expiries.reduce((sum, entry) => sum + entry.points.length, 0);
  const contracts = expiries.reduce((sum, entry) => sum + Object.values(entry.filterCounts).reduce((a, b) => a + b, 0) + entry.points.length, 0);
  const zeroBid = expiries.reduce((sum, entry) => sum + entry.filterCounts["zero-bid"], 0);
  const settled = !!snapshot && snapshot.loaded >= snapshot.requested;
  return { empty: settled && expiries.length > 0 && points === 0 && contracts > 0, points, expiries: expiries.length, contracts, zeroBid };
}

function ExpiryTable({ snapshot, selected, onSelect, forwards, width, height, focused, onKey, metadata }: {
  snapshot: DatedSurfaceSnapshot; selected: SurfaceExpiry | null; onSelect: (expiry: SurfaceExpiry) => void;
  forwards: boolean; width: number; height: number; focused: boolean;
  onKey: (event: DataTableKeyEvent) => boolean; metadata: () => unknown[][];
}) {
  const fields = forwards ? ["Forward", "Basis", "Div %", "Rate %", "Pairs", "As of"] : ["25d put", "25d call", "RR pts", "BF pts", "90/110 pts", "Slope/yr"];
  const integerColumn = forwards ? "4" : null;
  const [sort, setSort] = useState({ id: "expiry", direction: "asc" as "asc" | "desc" });
  const value = (entry: SurfaceExpiry, id: string): number | string | null => id === "expiry" ? entry.expiration
    : forwards ? [entry.forward, entry.forward == null ? null : entry.forward - snapshot.spot,
      entry.dividendYield == null || entry.years * 365 < DIVIDEND_YIELD_MIN_DAYS ? null : entry.dividendYield * 100,
      entry.rate == null ? null : entry.rate * 100, snapshot.stored ? null : entry.parity.pairs.length, entry.asOf?.slice(0, 10) ?? null][Number(id)] ?? null
      : [entry.skew.put25, entry.skew.call25, entry.skew.riskReversal, entry.skew.butterfly, entry.skew.moneynessSkew, entry.termSlope][Number(id)] ?? null;
  const rows = [...snapshot.expiries].sort((a, b) => {
    const x = value(a, sort.id), y = value(b, sort.id);
    const difference = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
    return sort.direction === "asc" ? difference : -difference;
  });
  return <DataTableView<SurfaceExpiry> focused={focused} rootWidth={width} rootHeight={height} items={rows}
    columns={[{ id: "expiry", label: "Expiry", width: 13, align: "left" }, ...fields.map((label, i) => ({ id: String(i), label, width: 13, align: "right" as const }))]}
    getItemKey={(entry) => String(entry.expiration)} selection={{ kind: "id", selectedId: String(selected?.expiration), getId: (entry) => String(entry.expiration), onChange: (_id, entry) => onSelect(entry) }}
    onActivate={onSelect} onRootKeyDown={onKey} getExportMetadata={metadata} freezeFirstColumn
    sortColumnId={sort.id} sortDirection={sort.direction} onHeaderClick={(id) => setSort({ id, direction: sort.id === id && sort.direction === "asc" ? "desc" : "asc" })}
    renderCell={(entry, column) => { const raw = value(entry, column.id); return { text: column.id === "expiry" ? expiryLabel(entry.expiration)
      : raw == null ? "--" : typeof raw === "string" ? raw : column.id === integerColumn ? String(raw)
        : forwards ? (column.id === "1" && raw > 0 ? `+${formatPrice(raw)}` : formatPrice(raw)) : `${(raw * 100).toFixed(2)}` }; }} emptyStateTitle="No expiry observations." />;
}
