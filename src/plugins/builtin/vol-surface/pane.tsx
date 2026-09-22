import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableView, EmptyState, PaneStatusBody, SelectButton, Tabs, usePaneFooter, usePaneNoticeFooter,
  usePaneTicker, type DataTableColumn, type DataTableKeyEvent } from "../../../components";
import { useTableLoadMore } from "../../../components/table-view-shared";
import { useStaticChartBitmapSize } from "../../../components/chart/composite/bitmap";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "gloomberb/react";
import { blendHex } from "../../../theme/color-utils";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, type ScrollBoxRenderable } from "../../../ui";
import { resolveOptionsTarget } from "../../../utils/options";
import { buildOptionCalcParams, OPTIONS_CALCULATOR_TEMPLATE_ID } from "../options-calculator/model";
import { formatStrikeLabel } from "../options/table";
import { useAutoRefresh } from "../shared/auto-refresh";
import { loadVolatilitySurface } from "./client";
import { useVolSurfaceEvidence } from "./evidence";
import { buildSurfaceGrid, DEFAULT_SURFACE_SETTINGS, type SurfaceExpiry, type SurfaceGridRow,
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

export function VolSurfacePane({ focused, width, height }: PaneProps) {
  const colors = useThemeColors();
  const tableHeight = Math.max(3, height - 4);
  const bitmapAvailable = !!useStaticChartBitmapSize(width, tableHeight);
  const { symbol, ticker, financials } = usePaneTicker();
  const { createPaneFromTemplate } = usePluginAppActions();
  const target = resolveOptionsTarget(ticker);
  const [activeTab, setActiveTab] = usePluginPaneState("activeTabId", "surface");
  const [axis] = usePaneSettingValue<Axis>("axis", "spot");
  const [tenors] = usePaneSettingValue<"listed" | "fixed">("tenors", "listed");
  const [ivSource] = usePaneSettingValue<SurfaceSettings["ivSource"]>("ivSource", "recomputed");
  const [priceSide] = usePaneSettingValue<SurfaceSettings["priceSide"]>("priceSide", "mid");
  const [spread] = usePaneSettingValue("maxRelativeSpread", "0.5");
  const [age] = usePaneSettingValue("maxStaleSessions", "5");
  const [overlaySmiles] = usePaneSettingValue("overlaySmiles", false);
  const [expiration, setExpiration] = usePaneSettingValue<number | null>("expiration", null);
  const [surfaceCoordinate, setSurfaceCoordinate] = usePluginPaneState("surfaceCoordinate", 1);
  const [coordinate, setCoordinate] = usePluginPaneState("coordinate", 1);
  const [limit, setLimit] = usePluginPaneState("expiryLimit", 18);
  const [camera, setCamera] = usePluginPaneState<SurfaceCamera>("camera", DEFAULT_SURFACE_CAMERA);
  const [fixedYears, setFixedYears] = usePluginPaneState<number | null>("fixedYears", null);
  const [sort, setSort] = useState<{ id: string; direction: "asc" | "desc" }>({ id: "tenor", direction: "asc" });
  const controller = useRef<AbortController | null>(null);
  const [partial, setPartial] = useState<{ key: string; snapshot: SurfaceSnapshot } | null>(null);
  const quote = financials?.quote;
  const spotAvailable = !!quote && quote.price > 0 && Number.isFinite(quote.price) && !quote.stale;
  const spotAsOfRef = useRef(quote?.lastUpdated ?? null);
  spotAsOfRef.current = quote?.lastUpdated ?? null;
  const spotRef = useRef(quote?.price ?? 0);
  spotRef.current = quote?.price ?? 0;
  const requestKey = JSON.stringify([target?.cacheKey, symbol, axis, tenors, ivSource, priceSide, spread, age, limit, spotAvailable]);
  const request = useCallback(async (force: boolean) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const instrument = target?.instrument;
    return loadVolatilitySurface({
      instrument: { symbol: target?.effectiveTicker ?? symbol!, exchange: target?.effectiveExchange ?? "",
        brokerId: instrument?.brokerId, brokerInstanceId: instrument?.brokerInstanceId, instrument },
      spot: spotRef.current, spotAsOf: spotAsOfRef.current, limit, forceRefresh: force, signal: abort.signal,
      settings: { ...DEFAULT_SURFACE_SETTINGS, ivSource, priceSide, maxRelativeSpread: Number(spread), maxStaleSessions: Number(age) },
      onSnapshot: (snapshot) => { if (!abort.signal.aborted) setPartial({ key: requestKey, snapshot }); },
    });
  // Stable quote reference prevents every streaming tick from restarting all expiry requests.
  }, [requestKey]);
  const resource = useAsyncResource(symbol && spotAvailable ? request : null);
  useEffect(() => () => controller.current?.abort(), [request]);
  useAutoRefresh(resource.updatedAt, resource.load);
  const incremental = partial?.key === requestKey ? partial.snapshot : null;
  const snapshot = incremental && (incremental.loaded > 0 || !resource.data) ? incremental : resource.data;
  const grid = useMemo(() => snapshot ? buildSurfaceGrid(snapshot, { axis, tenors }) : null, [axis, snapshot, tenors]);
  const denseGrid = useMemo(() => snapshot ? buildSurfaceGrid(snapshot, { axis: "forward", tenors: "listed",
    coordinates: Array.from({ length: 41 }, (_, i) => 0.8 + i * 0.01) }) : null, [snapshot]);
  const selectedExpiry = snapshot?.expiries.find((entry) => entry.expiration === (expiration ?? snapshot.expiries[0]?.expiration)) ?? null;
  useVolSurfaceEvidence({ snapshot, view: activeTab, grid: activeTab === "surface" && bitmapAvailable ? denseGrid : grid,
    selectedExpiry, loading: resource.loading, bitmapAvailable, axis: activeTab === "surface" && bitmapAvailable ? "forward" : axis,
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
  const canLoadMore = !!snapshot && snapshot.requested < snapshot.catalogue.length && !resource.loading;
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
  const handleKey = (event: DataTableKeyEvent): boolean => {
    if (event.ctrl || event.meta || event.alt) return false;
    const key = event.name;
    if (key === "r") void resource.reload();
    else if (key === "v") cycleTab();
    else if (key === "p") openPricer();
    else if (key === "m" && canLoadMore) loadMore();
    else if (key === "[") nextExpiry(-1);
    else if (key === "]") nextExpiry(1);
    else if (key === "c" && snapshot) createPaneFromTemplate("options-pane", { symbol: snapshot.symbol, values: selectedExpiry ? { expiration: String(selectedExpiry.expiration) } : {} });
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
    ...(!spotAvailable && symbol ? ["Underlying price unavailable or stale"] : []),
    ...(resource.error ? [resource.error] : [])];
  const arbitrageWarnings = snapshot?.warnings.filter((warning) => /calendar|butterfly/i.test(warning)).length ?? 0;
  usePaneNoticeFooter({ registrationId: "ovdv-notices", notices: [...new Set(notices)], focused });
  usePaneFooter("ovdv", () => ({
    info: [
      ...(arbitrageWarnings ? [{ id: "arbitrage", parts: [{ text: `${arbitrageWarnings} arbitrage warnings`, tone: "warning" as const }] }] : []),
      ...(snapshot ? [{ id: "progress", parts: [{ text: `${snapshot.loaded}/${snapshot.requested} expiries`, tone: "muted" as const }] }] : []),
      ...(resource.loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(snapshot ? [{ id: "source", parts: [{ text: snapshot.expiries.some((entry) => entry.dataSource === "live") ? "mixed / live" : "delayed", tone: "muted" as const }] }] : []),
      ...(snapshot?.expiries.some((entry) => entry.stale) ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
      ...(selectedExpiry?.fit && activeTab === "smile" ? [{ id: "fit", parts: [{ text: `${selectedExpiry.fit.method} · RMSE ${(selectedExpiry.fit.residual * 100).toFixed(3)} vol pts`, tone: "muted" as const }] }] : []),
    ],
    hints: [
      { id: "view", key: "v", label: "iew", onPress: cycleTab },
      ...(snapshot ? [{ id: "chain", key: "c", label: "hain", onPress: () => createPaneFromTemplate("options-pane", { symbol: snapshot.symbol, values: selectedExpiry ? { expiration: String(selectedExpiry.expiration) } : {} }) }] : []),
      ...(selectedCell?.volatility ? [{ id: "pricer", key: "p", label: "rice", onPress: openPricer }] : []),
      ...(canLoadMore ? [{ id: "more", key: "m", label: "ore expiries", onPress: loadMore }] : []),
      ...(activeTab === "surface" && bitmapAvailable ? [{ id: "reset", key: "0", label: "reset view", onPress: () => setCamera(DEFAULT_SURFACE_CAMERA) }] : []),
    ],
  }), [snapshot, resource.loading, selectedExpiry, activeTab, selectedCell, canLoadMore, camera, bitmapAvailable, arbitrageWarnings]);
  const exportMetadata = () => [["method", ivSource, priceSide], ["filters", JSON.stringify(snapshot?.settings)],
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
  const content = activeTab === "surface" && denseGrid ? <VolatilitySurface width={width} height={tableHeight}
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
    {!symbol ? <EmptyState title="Choose an underlying ticker." /> : <PaneStatusBody loading={resource.loading && !snapshot}
      error={!snapshot ? resource.error : null} empty={!snapshot && !resource.loading} subject="volatility surface">
      <Box height={1} flexDirection="row" paddingX={1} gap={2}>
        <SelectButton label="Expiry" value={String(selectedExpiry?.expiration ?? "")} options={snapshot?.expiries.map((entry) => ({ value: String(entry.expiration), label: expiryLabel(entry.expiration) })) ?? []}
          onChange={(value) => setExpiration(Number(value))} />
        <Text fg={colors.textDim}>{`Spot ${formatPrice(snapshot?.spot)} ${quote?.currency ?? ""} · ${ivSource === "provider" ? "provider IV" : `${priceSide} IV`}${selectedExpiry?.asOf ? ` · ${selectedExpiry.asOf.slice(0, 10)}` : ""}`}</Text>
      </Box>
      {content}
      <Box height={1} paddingX={1} overflow="hidden"><Text fg={colors.textDim}>{selectedCell?.point
        ? `Nearest ${selectedCell.point.contract.contractSymbol} · mid ${formatPrice(selectedCell.point.mid)} · spread ${formatPrice(selectedCell.point.spread)} · OI ${selectedCell.point.openInterest} · residual ${formatIv(selectedCell.fitResidual)}`
        : selectedCell?.volatility != null ? `${selectedRow?.label} · K ${selectedCell.strike == null ? "--" : formatStrikeLabel(selectedCell.strike)} · fitted IV ${formatIv(selectedCell.volatility)}` : "No clean quoted cell selected"}</Text></Box>
    </PaneStatusBody>}
  </Box>;
}

function ExpiryTable({ snapshot, selected, onSelect, forwards, width, height, focused, onKey, metadata }: {
  snapshot: SurfaceSnapshot; selected: SurfaceExpiry | null; onSelect: (expiry: SurfaceExpiry) => void;
  forwards: boolean; width: number; height: number; focused: boolean;
  onKey: (event: DataTableKeyEvent) => boolean; metadata: () => unknown[][];
}) {
  const fields = forwards ? ["Forward", "Dividend %", "Rate %", "Pairs", "As of"] : ["25d put", "25d call", "RR pts", "BF pts", "90/110 pts", "Slope/yr"];
  const [sort, setSort] = useState({ id: "expiry", direction: "asc" as "asc" | "desc" });
  const value = (entry: SurfaceExpiry, id: string): number | string | null => id === "expiry" ? entry.expiration
    : forwards ? [entry.forward, entry.dividendYield == null ? null : entry.dividendYield * 100,
      entry.rate == null ? null : entry.rate * 100, entry.parity.pairs.length, entry.asOf?.slice(0, 10) ?? null][Number(id)] ?? null
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
      : raw == null ? "--" : typeof raw === "string" ? raw : forwards ? formatPrice(raw) : `${(raw * 100).toFixed(2)}` }; }} emptyStateTitle="No expiry observations." />;
}
