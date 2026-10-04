import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PowerBoard, PowerFilter, PowerHistory } from "../../../api-client/power";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import { ChartTableHeader, DataTableStackView, PaneStatusBody, QueryBar, useChartTableSelection, usePagedRows, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, useQueryBarSearch, useTableLoadMore, type DataTableCell, type PaneHint, type QueryBarFilter } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { publicTickerKey } from "../../../utils/exchanges";
import { getSharedRegistry } from "../../registry/shared";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { Blurred, LockedOverlay, UpgradeLabel } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { loadPowerBoard, loadPowerHistory, validatePowerBoard, validatePowerHistory } from "./client";
import { usePowerEvidence } from "./evidence";
import { POWER_SORT_COLUMNS, powerQuery } from "./query";
import { PowerDetailView } from "./detail";
import { blendHex } from "../../../theme/colors";
import { missingCell, PartsBar, signedColor, toneColor, withoutQuietColumns, type StateTone } from "../shared/research-cells";
import { COVERAGE_COLUMNS, EXPOSURE_COLUMNS, HISTORY_COLUMNS, GENERATION_COLUMNS, UTILITY_COLUMNS, POWER_TABS, PROJECT_COLUMNS, RATE_COLUMNS, historyDate, historyId, historySeries, otherRows, powerFigures, powerRegion, powerNumber, powerPercent, powerTab, projectRows, titleCase, type PowerRow } from "./model";

const rowId = (r: PowerRow) => r.id;
const isRecord = (r: PowerRow) => !r.section;
/** One tone per state across queue, outcomes and coverage: done is green, gone is quiet, late is amber. */
const STATUS_TONES: Record<string, StateTone> = { Active: "text", Completed: "positive", Operating: "positive", Withdrawn: "muted", Suspended: "warning", Current: "positive", Stale: "warning", Disabled: "muted", Failed: "negative" };
/** Columns that only repeat a default on every row. */
const QUIET_COLUMNS: Record<string, readonly string[]> = { scope: ["Project"], unknownCapacity: ["0"], unknown: ["0"], fuel: ["Load"], role: ["Direct"], kind: ["Queue"] };
const rowDate = (r: PowerRow) => r.history ? historyDate(r.history) : null;
const EMPTY_HISTORY: PowerHistory["points"] = [];
const DEFAULT_SORT: { column: PowerFilter["sort"]; direction: "asc" | "desc" } = { column: "capacityMw", direction: "desc" };
const GENERATION_SORT: typeof DEFAULT_SORT = { column: "generationMwh", direction: "desc" };
const UTILITY_SORT: typeof DEFAULT_SORT = { column: "salesMwh", direction: "desc" };
export function PowerPane(props: PaneProps) {
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const scope = `${session.requestKey}:${access.hasProAccess ? "full" : "preview"}`;
  return <PowerView key={scope} {...props} scope={scope} needsVerification={session.needsVerification} />;
}
function PowerView({ width, height, focused, scope, needsVerification }: PaneProps & { scope: string; needsVerification: boolean }) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const { createPaneFromTemplate } = usePluginAppActions();
  const upgrade = useCloudUpgradeAction("power");
  const [openingTab] = usePaneSettingValue("tab", "queue");
  const [savedTab, setTab] = usePluginPaneState("power:tab", openingTab);
  const tab = powerTab(savedTab);
  const [initialSearch] = usePaneSettingValue("search", "");
  const [search, setSearch] = usePluginPaneState("power:search", initialSearch);
  const [initialCountry] = usePaneSettingValue("country", "");
  const [country, setCountry] = usePluginPaneState("power:country", initialCountry);
  const [initialRegion] = usePaneSettingValue("region", "");
  const [region, setRegion] = usePluginPaneState("power:region", initialRegion);
  const [initialFuel] = usePaneSettingValue("fuel", "");
  const [fuel, setFuel] = usePluginPaneState("power:fuel", initialFuel);
  const [initialStatus] = usePaneSettingValue("status", "");
  const [status, setStatus] = usePluginPaneState("power:status", initialStatus);
  const [symbol] = usePaneSettingValue("symbol", "");
  const [initialHistorical] = usePaneSettingValue("historical", false);
  const [historical, setHistorical] = usePluginPaneState("power:historical", initialHistorical);
  const [initialContext] = usePaneSettingValue("context", "capacity");
  const [context, setContext] = usePluginPaneState("power:context", initialContext);
  const [initialLoadClass] = usePaneSettingValue("loadClass", "");
  const [loadClass, setLoadClass] = usePluginPaneState("power:loadClass", initialLoadClass);
  const [initialSource] = usePaneSettingValue("sourceId", "");
  const [sourceId, setSourceId] = usePluginPaneState("power:source", initialSource);
  const [from] = usePaneSettingValue("from", "");
  const [to] = usePaneSettingValue("to", "");
  const [sort, setSort] = usePluginPaneState<{ column: PowerFilter["sort"]; direction: "asc" | "desc" }>(`power:sort:${tab}:${context}`, tab === "capacity" && context === "generation" ? GENERATION_SORT : tab === "capacity" && context === "utility" ? UTILITY_SORT : DEFAULT_SORT);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>(`power:selected:${tab}`, null);
  const [openId, setOpenId] = usePluginPaneState<string | null>(`power:open:${tab}`, null);
  const searchFocus = useQueryBarSearch();
  const [snapshotSetting] = usePaneSettingValue<{ board: PowerBoard; history?: PowerHistory } | null>("powerSnapshot", null);
  const snapshot = useMemo(() => { try { return snapshotSetting ? { board: validatePowerBoard(snapshotSetting.board), history: snapshotSetting.history ? validatePowerHistory(snapshotSetting.history) : undefined } : null; } catch { return null; } }, [snapshotSetting]);
  const projectTab = ["queue", "loads", "capacity"].includes(tab);
  const filter = useMemo(() => powerQuery({ tab, country, region, fuel, status, search, historical, context, loadClass, sourceId, from, to,
    sort: sort.column, direction: sort.direction }, symbol), [tab, country, region, fuel, status, search, historical, context, loadClass, sourceId, from, to, sort.column, sort.direction, symbol]);
  const queryKey = JSON.stringify(filter);
  const loader = useCallback(async ({ offset, signal, force }: { offset: number; signal: AbortSignal; force: boolean }) => {
    const result = snapshot ? { payload: snapshot.board, stale: false, refreshError: null } : await loadPowerBoard({ ...filter, offset, limit: 100 }, scope, force, signal);
    return { ...result, rows: result.payload.projects, hasMore: projectTab && result.payload.hasMore && !snapshot, nextOffset: result.payload.nextOffset };
  }, [filter, scope, projectTab, snapshot]);
  const pages = usePagedRows(loader, { getId: (row) => row.id });
  const board = isAccessDenied(pages.error) || isAccessDenied(pages.moreError) ? undefined : pages.pages[0]?.payload;
  const historyLoader = useCallback(async ({ offset, force }: { offset: number; force: boolean }) => {
    const result = snapshot?.history ? { payload: snapshot.history, stale: false, refreshError: null }
      : await loadPowerHistory({ ...filter, offset, limit: 500 }, scope, force);
    return { ...result, rows: result.payload.points, hasMore: result.payload.hasMore && !snapshot, nextOffset: result.payload.nextOffset };
  }, [filter, scope, snapshot]);
  const historyPages = usePagedRows(tab === "history" ? historyLoader : null, { getId: historyId });
  useEffect(() => {
    if (historyPages.hasMore && !historyPages.loading && !historyPages.loadingMore && !historyPages.moreError) historyPages.loadMore();
  }, [historyPages.hasMore, historyPages.loading, historyPages.loadingMore, historyPages.moreError, historyPages.loadMore]);
  const historyData = useMemo(() => isAccessDenied(historyPages.error) || isAccessDenied(historyPages.moreError) || !historyPages.pages[0] ? undefined : {
    payload: { ...historyPages.pages[0].payload, points: historyPages.rows },
    stale: historyPages.pages.some((page) => page.stale), refreshError: historyPages.pages.find((page) => page.refreshError)?.refreshError,
  }, [historyPages.error, historyPages.moreError, historyPages.pages, historyPages.rows]);
  useAutoRefresh(historyData ? Date.parse(historyData.payload.generatedAt) : null, historyPages.reload);
  const refresh = useCallback(() => { pages.reload(); if (tab === "history") historyPages.reload(); }, [pages.reload, historyPages.reload, tab]);
  usePaneRefreshKey(refresh, { focused });
  useAutoRefresh(board ? Date.parse(board.generatedAt) : null, pages.reload);
  const rows = useMemo(() => projectTab ? projectRows(pages.rows) : board ? otherRows(tab, board, historyData?.payload.points ?? EMPTY_HISTORY) : [], [projectTab, pages.rows, board, tab, historyData]);
  usePowerEvidence(board, historyData?.payload, tab, rows.map((row) => row.id), pages.loading || historyPages.loading || historyPages.hasMore);
  const locked = board ? tab === "history" ? historyData?.payload.locked ?? 0 : tab === "outcomes" ? board.locked.rates : tab === "utilities" ? board.locked.exposure : projectTab ? board.locked.projects : 0 : 0;
  const items = useMemo(() => [...rows, ...Array.from({ length: Math.min(3, locked) }, (_, i): PowerRow => ({ id: `locked:${i}`, label: "Pro", cells: {}, locked: true }))], [rows, locked]);
  const selected = rows.find((r) => r.id === selectedId && isRecord(r)) ?? rows.find(isRecord);
  const openRow = rows.find((r) => r.id === openId);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const loadMore = useTableLoadMore(scrollRef, !openRow && (tab === "history" ? historyPages.hasMore : pages.hasMore), tab === "history" ? historyPages.loadMore : pages.loadMore);
  useEffect(() => { if (openId && !openRow && pages.hasMore && !pages.loading && !pages.loadingMore) pages.loadMore(); }, [openId, openRow, pages.hasMore, pages.loading, pages.loadingMore, pages.loadMore]);
  const active = openRow ?? selected;
  const ticker = (active?.project?.entities ?? active?.exposure?.entities)?.flatMap((e) => e.tickers)[0];
  const tickerKey = ticker ? publicTickerKey(ticker.ticker, ticker.exchange) : null;
  const sourceUrl = active?.project?.sourceUrl ?? active?.exposure?.sourceUrls[0] ?? active?.history?.sourceUrls[0] ?? active?.coverage?.sourceUrl;
  const navigate = (template: string) => createPaneFromTemplate(template, tickerKey ? { symbol: tickerKey } : undefined);
  const hints: PaneHint[] = [
    ...(sourceUrl ? [{ id: "source", key: "o", label: "pen source", onPress: () => void host.openExternal(sourceUrl) }] : []),
    ...(tickerKey ? [
      { id: "description", key: "d", label: "es", onPress: () => navigate("new-ticker-detail-pane") },
      { id: "financials", key: "f", label: "a", onPress: () => navigate("financial-analysis-pane") },
      { id: "chart", key: "g", label: "raph", onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: tickerKey }) },
      { id: "supply", key: "s", label: "plc", onPress: () => navigate("supply-chain-pane") },
    ] : []),
    { id: "gpu", key: "c", label: "ompute", title: "GPU Rental Prices", onPress: () => navigate("gpu-pane") },
    ...(getSharedRegistry()?.paneTemplates.has("buildout-pane") ? [{ id: "buildout", key: "t", label: "bo", onPress: () => navigate("buildout-pane") }] : []),
    ...(locked ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: upgrade }] : []),
  ];
  const error = pages.error?.message ?? (tab === "history" ? historyPages.error?.message : null);
  usePaneStatusFooter({ registrationId: "power", loading: pages.loading || historyPages.loading,
    error: board ? error : null, stale: pages.pages.some((p) => p.stale) || historyData?.stale,
    info: [...(pages.loadingMore || historyPages.loadingMore ? [{ id: "more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
      ...(active?.project ? [{ id: "as-of", parts: [{ text: active.project.asOf ? `as of ${active.project.asOf}` : `observed ${active.project.observedAt.slice(0, 10)}`, tone: "muted" as const }] }] : [])], hints });
  const notices = [pages.moreError?.message, historyPages.moreError?.message, ...pages.pages.map((p) => p.refreshError), historyData?.refreshError,
    ...(board?.coverage.filter((c) => c.status !== "current").map((c) => `${powerRegion(c.region)} ${titleCase(c.kind)}: ${c.status}${c.reason ? ` · ${c.reason}` : ""}`) ?? [])].filter((v): v is string => !!v);
  usePaneNoticeFooter({ registrationId: "power:notices", focused, notices: [...new Set(notices)], enabled: !openRow });
  const { strip, rows: tabRows } = usePaneTabs(board ? { tabs: [...POWER_TABS], activeValue: tab, onSelect: setTab, focused, dense: true } : null);
  const baseColumns = tab === "capacity" && context === "generation" ? GENERATION_COLUMNS : tab === "capacity" && context === "utility" ? UTILITY_COLUMNS : projectTab ? PROJECT_COLUMNS : tab === "history" ? HISTORY_COLUMNS : tab === "outcomes" ? RATE_COLUMNS : tab === "utilities" ? EXPOSURE_COLUMNS : COVERAGE_COLUMNS;
  const records = useMemo(() => rows.filter(isRecord), [rows]);
  const columns = useMemo(() => withoutQuietColumns(baseColumns, records, (r, id) => r.cells[id] ?? "", QUIET_COLUMNS), [baseColumns, records]);
  const chartLink = useChartTableSelection({ rows, getId: rowId, getDate: rowDate, selectedId: selected?.id ?? null, onSelect: setSelectedId, focused: focused && !openRow });
  const series = useMemo(() => historySeries(historyPages.hasMore ? EMPTY_HISTORY : historyData?.payload.points ?? EMPTY_HISTORY, selected?.history, colors.warning), [historyPages.hasMore, historyData, selected?.history, colors.warning]);
  const choices = (values: string[] | undefined) => [{ value: "", label: "All" }, ...[...new Set(values ?? [])].map((value) => ({ value, label: titleCase(value) }))];
  const filters: QueryBarFilter[] = [
    ...(historical && ["queue", "history", "outcomes"].includes(tab) ? [{ id: "source", label: "History", value: sourceId, defaultValue: "", options: [{ value: "", label: "All benchmarks" }, { value: "us-lbnl-annual", label: "Annual benchmark" }, { value: "us-lbnl", label: "Project benchmark" }], onChange: setSourceId }] : []),
    ...(["loads", "utilities"].includes(tab) ? [{ id: "loadClass", label: "Loads", value: loadClass, defaultValue: "", options: [{ value: "", label: "All loads" }, { value: "datacenter", label: "Datacenters" }], onChange: setLoadClass }] : []),
    { id: "country", label: "Country", value: country, defaultValue: "", options: choices(board?.filters.countries), onChange: setCountry },
    { id: "region", label: "Region", value: region, defaultValue: "", options: choices(board?.filters.regions), onChange: setRegion },
    ...(!["loads", "utilities", "coverage"].includes(tab) ? [{ id: "fuel", label: "Fuel", value: fuel, defaultValue: "", options: choices(board?.filters.fuels), onChange: setFuel }] : []),
    ...(tab !== "coverage" ? [{ id: "status", label: "Status", value: status, defaultValue: "", options: choices(board?.filters.statuses), onChange: setStatus }] : []),
    ...(["queue", "history", "outcomes"].includes(tab) ? [{ id: "historical", label: "Benchmark", kind: "toggle" as const, value: historical, defaultValue: false, onChange: setHistorical }] : []),
    ...(tab === "capacity" ? [{ id: "context", label: "Context", value: context, options: [{ value: "capacity", label: "Capacity" }, { value: "generation", label: "Generation" }, { value: "utility", label: "Utilities" }], onChange: setContext }] : []),
  ];
  // The selected project's region in figures, its whole queue as one bar: active, completed, withdrawn.
  const regionAggregates = board?.aggregates.filter((a) => a.sourceId === selected?.project?.sourceId && a.region === selected?.project?.region) ?? [];
  const mwBy = (status: string) => regionAggregates.filter((a) => a.status === status).reduce((n, a) => n + a.capacityMw, 0);
  const queueFigures = powerFigures(regionAggregates).map((figure, i) => i === 0 ? { ...figure, label: `${selected?.project ? powerRegion(selected.project.region, selected.project.sourceId) : "Reported"} MW`,
    split: [{ id: "active", value: mwBy("active"), color: blendHex(colors.bg, colors.borderFocused, 0.55) }, { id: "completed", value: mwBy("completed"), color: colors.positive },
      { id: "withdrawn", value: mwBy("withdrawn"), color: blendHex(colors.bg, colors.textDim, 0.45) }] } : figure);
  const query = <QueryBar width={width} search={{ value: search, onChange: setSearch, placeholder: "Project, developer, utility", focused: focused && !openRow, ...searchFocus.searchProps }} filters={filters} />;
  const bodyHeight = Math.max(3, height - tabRows);
  const cell = (row: PowerRow, column: typeof columns[number], _index: number, state: { selected: boolean }): DataTableCell => {
    if (row.section) return { text: "" };
    if (row.locked) return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>{column.id === columns[0]!.id ? "Additional records" : "Hidden"}</Text></Blurred> }
      : column.id === columns[0]!.id && row.id === "locked:0" ? { text: "Unlock with Pro", content: <UpgradeLabel text="Unlock with Pro" onPress={upgrade} role="power-upgrade" />, onMouseDown: upgrade } : { text: "░░░░", color: colors.textDim };
    // How a cohort ended and how far a utility's large loads got, as parts of one bar.
    if (column.id === "outcome" && row.rate) return { text: "", content: <PartsBar width={column.width} desktop={desktop} parts={[
      { id: "completed", value: row.rate.completed, color: colors.positive }, { id: "active", value: row.rate.active, color: blendHex(colors.bg, colors.borderFocused, 0.55) },
      { id: "withdrawn", value: row.rate.withdrawn, color: blendHex(colors.bg, colors.textDim, 0.45) }, { id: "other", value: row.rate.unknown, color: blendHex(colors.bg, colors.textDim, 0.25) }]} /> };
    if (column.id === "pipeline" && row.exposure) { const e = row.exposure; return { text: "", content: <PartsBar width={column.width} desktop={desktop} parts={[
      { id: "operating", value: e.operatingMw, color: colors.positive }, { id: "approved", value: Math.max(0, e.approvedMw - e.operatingMw), color: blendHex(colors.bg, colors.borderFocused, 0.55) },
      { id: "requested", value: Math.max(0, e.requestedMw - Math.max(e.approvedMw, e.operatingMw)), color: blendHex(colors.bg, colors.textDim, 0.4) }]} /> }; }
    const value = row.cells[column.id];
    if (value == null || value === "") return missingCell(colors);
    const text = typeof value === "number" ? /Rate$/.test(column.id) ? powerPercent(value) : powerNumber(value) : String(value);
    const numeric = typeof value === "number" && /Rate$/.test(column.id) ? value * 100 : value;
    if (column.id === "status") return { text, color: toneColor(STATUS_TONES[text] ?? "text", colors) };
    if (column.id === "changeMw" && typeof value === "number") return { text: `${value > 0 ? "+" : ""}${text}`, value, color: signedColor(value, colors) };
    if (column.id === "ticker") return { text, color: colors.textBright, attributes: state.selected ? 0 : TextAttributes.BOLD };
    return { text, value: numeric,
      color: column.id === "name" || column.id === "utility" || column.id === "capacityMw" || column.id === "requestedMw" ? colors.textBright
        : ["location", "asOf", "observedAt", "scope", "proposedDate", "region", "country", "kind", "role", "period"].includes(column.id) ? colors.textDim : colors.text };
  };
  if (!board && isCloudSessionRequired(error)) return <SignInWall action="view power and interconnection data" needsVerification={needsVerification} />;
  return <Box width={width} height={height} flexDirection="column">{strip}
    <PaneStatusBody loading={!board && pages.loading} error={!board ? error : null} subject="power and interconnection data">
      {board ? <DataTableStackView<PowerRow> columns={columns} items={items} getItemKey={rowId} focused={focused && !searchFocus.active}
        rootWidth={width} rootHeight={bodyHeight} scrollRef={scrollRef} onBodyScrollActivity={loadMore} resetScrollKey={`${tab}:${queryKey}`}
        selection={{ kind: "id", selectedId: selected?.id ?? null, getId: rowId, onChange: setSelectedId }}
        onActivate={(row) => row.locked ? upgrade() : setOpenId(row.id)} detailOpen={!!openRow} onBack={() => setOpenId(null)} detailTitle={openRow?.label}
        detailScrollRef={detailScrollRef} detailContent={openRow ? <PowerDetailView row={openRow} scope={scope} scrollRef={detailScrollRef} snapshot={!!snapshot} focused={focused} width={width} height={bodyHeight - 1} /> : null}
        renderCell={cell} freezeFirstColumn showHorizontalScrollbar selectedTextOverridesCellColor
        isNavigable={isRecord} renderSectionHeader={(row) => row.section ? { text: `${row.label} (${row.section.count})` } : null}
        sortColumnId={projectTab ? sort.column ?? null : null} sortDirection={sort.direction}
        isColumnSortable={(column) => projectTab && POWER_SORT_COLUMNS.includes(column.id)}
        onHeaderClick={projectTab ? (column) => { if (POWER_SORT_COLUMNS.includes(column)) setSort((old) => ({ column: column as PowerFilter["sort"], direction: old.column === column && old.direction === "desc" ? "asc" : "desc" })); } : undefined}
        rootBefore={<ChartTableHeader width={width} height={bodyHeight} tableRows={items.length} tableColumns={columns} query={query}
          figures={projectTab && tab === "queue" && board.access === "full" ? queueFigures : undefined}
          chart={tab === "history" ? { series, ...chartLink, formatValue: (n) => `${powerNumber(n)} MW`, loading: historyPages.loading || historyPages.hasMore && !historyPages.moreError,
            empty: series.length ? undefined : historyPages.moreError ? "Full history could not load. Refresh to retry." : historyData?.payload.access === "preview" ? "Full history is available with Pro." : "History is accumulating from recorded snapshots.", remoteKind: "power-history" } : null} />}
        emptyStateTitle={tab === "history" ? historyPages.error?.message ?? "No recorded history for these filters." : "No reported records match these filters."}
        bodyAfter={locked && desktop ? <LockedOverlay rows={Math.min(3, locked)} text="Unlock full power data with Pro" onPress={upgrade} role="power-upgrade" /> : undefined}
      /> : null}
    </PaneStatusBody>
  </Box>;
}
