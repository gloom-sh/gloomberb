import { useCallback, useMemo, useRef } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { AppAttentionFilter, AppAttentionPayload, AppChart } from "../../../api-client/app-attention";
import type { HiringBoard, HiringPayload } from "../../../api-client/hiring";
import { ChartTableHeader, DataTableView, EmptyState, KeyValueRow, PageStackView, PaneFooterScope, PaneStatusBody, QueryBar, useChartTableSelection, usePagedRows, useTableLoadMore, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, type PaneHint } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { Blurred, LockedOverlay, UpgradeLabel } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { humanLabel, listingCell, missingCell, shareCell, signedColor, toneColor, withoutQuietColumns, type StateTone } from "../shared/research-cells";
import { AppRankView } from "./app-rank";
import { useAttentionEvidence } from "./evidence";
import { cachedAttention, fetchAttention, loadAttention, validateAttention, type AttentionPayload } from "./client";
import { appsModel, attentionSeries, count, hiringModel, sortAttentionRows, type AttentionKind, type AttentionRow, type AttentionTab } from "./model";

type Size = Pick<PaneProps, "width" | "height" | "focused">;
const rowId = (row: AttentionRow) => row.id;
const rowDate = (row: AttentionRow) => row.date ? new Date(row.date) : null;
/** Decimals per column: percentages and scores to one place, ratings and z-scores to two, counts whole. */
const DECIMALS: Record<string, number> = { score: 1, remote: 1, share: 1, confidence: 0, velocity: 2, rating: 2, drift: 2, z: 2, change: 1 };
const SIGNED_COLUMNS = new Set(["net", "change", "velocity", "drift", "growth"]);
const SIGNAL_TONES: Record<string, StateTone> = { Surge: "positive", Freeze: "negative", Stale: "warning", Collecting: "muted", Uncovered: "muted", Ok: "text" };
/** Columns left out while every row reads the same default: a first capture has no weekly change yet. */
const QUIET_COLUMNS: Record<string, readonly string[]> = { net: [""], z: [""], change: [""], velocity: [""], drift: [""], growth: [""], added: [""], removed: [""], coverage: ["complete"], spread: [""] };
const LABEL_COLUMNS = new Set(["chart"]);
function Evidence({ row, width, height }: Size & { row: AttentionRow }) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  return <ScrollBox scrollY width={width} height={desktop ? undefined : height} flexGrow={1} flexBasis={0} contentOptions={{ paddingX: 1 }}>
    {(row.details ?? Object.entries(row.values).map(([label, value]) => ({ label, value: String(value ?? "--") }))).map((entry) => <KeyValueRow key={entry.label} label={entry.label} value={entry.value} labelWidth={22} />)}
    {row.url ? <Box paddingY={1}><Text fg={colors.textMuted}>{row.url}</Text></Box> : null}
  </ScrollBox>;
}

export function HiringPane(props: Size) {
  const { symbol } = usePaneTickerIdentity();
  return <AttentionView key={symbol ?? "board"} {...props} kind="hiring" symbol={symbol ?? undefined} />;
}
export function AppsPane(props: Size) {
  const { symbol } = usePaneTickerIdentity();
  const [appId] = usePaneSettingValue<string>("appId", "");
  const [store] = usePaneSettingValue<string>("store", "app-store");
  const [country] = usePaneSettingValue<string>("country", "");
  const [chart] = usePaneSettingValue<string>("chart", "");
  const [name] = usePaneSettingValue<string>("appRankName", appId);
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const focus = useMemo(() => ({ appId, name, country: (country || (store === "google-play" ? "GLOBAL" : "US")).toUpperCase(), chart: (chart || (store === "google-play" ? "unranked" : "free")) as AppChart, store: store === "google-play" ? "google-play" as const : "app-store" as const }), [appId, name, country, chart, store]);
  if (appId) return <AppRankView {...props} focus={focus} accessKey={`${session.requestKey}:${access.hasProAccess ? "full" : "preview"}`} />;
  return <AttentionView key={symbol ?? "board"} {...props} kind="apps" symbol={symbol ?? undefined} />;
}

function AttentionView({ kind, symbol, width, height, focused }: Size & { kind: AttentionKind; symbol?: string }) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const host = useRendererHost();
  const { createPaneFromTemplate } = usePluginAppActions();
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "full" : "preview"}`;
  const upgrade = useCloudUpgradeAction(kind === "hiring" ? "hire" : "apps");
  const [openingTab] = usePaneSettingValue<string>("tab", "table");
  const [savedTab, setTab] = usePluginPaneState<string>(`${kind}:${symbol ?? "board"}:tab`, openingTab);
  const tab: AttentionTab = ["chart", "mix", "peers", "evidence"].includes(savedTab) && (kind === "apps" || symbol) ? savedTab as AttentionTab : "table";
  const [openingCountry] = usePaneSettingValue<string>("country", "");
  const [country, setCountry] = usePluginPaneState<string>(`${kind}:country`, openingCountry);
  const [openingChart] = usePaneSettingValue<string>("chart", "");
  const [chart, setChart] = usePluginPaneState<string>(`${kind}:chart`, openingChart);
  const [openingDays] = usePaneSettingValue<string>("days", "90");
  const [days, setDays] = usePluginPaneState<string>(`${kind}:days`, String(openingDays));
  const [mix, setMix] = usePluginPaneState<string>(`${kind}:mix`, kind === "hiring" ? "functions" : "countries");
  const filters = useMemo<AppAttentionFilter>(() => kind === "apps" ? { ...(country ? { country } : {}), ...(chart ? { chart: chart as AppChart } : {}), days: Number(days) || 90 } : {}, [kind, country, chart, days]);
  const [snapshotSetting] = usePaneSettingValue<AttentionPayload | null>("attentionSnapshot", null);
  const snapshot = useMemo(() => { try { return snapshotSetting ? validateAttention(kind, snapshotSetting) : null; } catch { return null; } }, [kind, snapshotSetting]);
  const loader = useCallback((force: boolean) => snapshot ? Promise.resolve({ payload: snapshot, stale: false, refreshError: null }) : loadAttention(kind, symbol, accessKey, filters, force), [kind, symbol, accessKey, filters, snapshot]);
  const resource = useAsyncResource(loader, { initialData: () => cachedAttention(kind, symbol, accessKey, filters), clearOnError: isAccessDenied });
  const data = resource.data?.payload;
  const model = useMemo(() => data ? kind === "hiring" ? hiringModel(data as HiringPayload | HiringBoard, mix) : appsModel(data as AppAttentionPayload, mix) : null, [data, kind, mix]);
  const [selectedId, setSelected] = usePluginPaneState<string | null>(`${kind}:${symbol ?? "board"}:${tab}:selected`, null);
  const [openCompany, setOpenCompany] = usePluginPaneState<string | null>(`${kind}:${symbol ?? "board"}:company`, null);
  const [openAppId, setOpenApp] = usePluginPaneState<string | null>(`${kind}:${symbol ?? "board"}:app`, null);
  const [openEvidence, setOpenEvidence] = usePluginPaneState<string | null>(`${kind}:${symbol ?? "board"}:evidence`, null);
  const [sort, setSort] = usePluginPaneState<{ column: string; direction: "asc" | "desc" }>(`${kind}:${symbol ?? "board"}:${tab}:sort`, { column: tab === "chart" ? "date" : tab === "mix" ? "count" : kind === "hiring" ? symbol ? "title" : "open" : "rank", direction: tab === "chart" || tab === "mix" || (kind === "hiring" && !symbol) ? "desc" : "asc" });
  const section = model?.sections[tab];
  const paginated = kind === "apps" && ["table", "evidence", "peers"].includes(tab) || kind === "hiring" && !symbol;
  const pageLoader = useCallback(async ({ offset, signal }: { offset: number; signal: AbortSignal; force: boolean }) => {
    const payload = offset === 0 && data ? data : await fetchAttention(kind, symbol, { ...filters, offset, limit: 100 }, undefined, signal);
    const projected = kind === "hiring" ? hiringModel(payload as HiringPayload | HiringBoard, mix) : appsModel(payload as AppAttentionPayload, mix);
    const nextOffset = "companies" in payload && kind === "hiring" && "total" in payload
      ? !payload.preview && offset + payload.companies.length < payload.total ? offset + payload.companies.length : null
      : (payload as AppAttentionPayload).page?.nextOffset ?? null;
    return { rows: projected.sections[tab].rows, hasMore: !snapshot && nextOffset !== null, nextOffset };
  }, [data, kind, symbol, filters, mix, tab, snapshot]);
  const paged = usePagedRows(data && paginated ? pageLoader : null, { getId: rowId });
  const sectionRows = paginated && paged.status !== "idle" ? paged.rows : section?.rows ?? [];
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const scrollMore = useTableLoadMore(scrollRef, paged.hasMore && !openCompany && !openEvidence, paged.loadMore);
  const lockedCount = !data || !model?.preview ? 0 : typeof data.locked === "number" ? data.locked
    : kind === "hiring" ? (data as HiringPayload).locked[tab === "table" || tab === "evidence" ? "evidence" : tab === "chart" ? "history" : tab === "peers" ? "peers" : mix === "signals" ? "signals" : "mix"]
      : (data as AppAttentionPayload).locked[tab === "table" ? "apps" : tab === "chart" ? "history" : tab === "mix" ? mix === "spreads" ? "spreads" : "countries" : tab === "peers" ? symbol ? "peers" : "companies" : "evidence"];
  const lockedRows = Math.min(3, lockedCount);
  const rows = useMemo(() => [...sortAttentionRows(sectionRows, sort.column, sort.direction), ...Array.from({ length: lockedRows }, (_, index): AttentionRow => ({ id: `locked:${index}`, values: {} }))], [sectionRows, sort, lockedRows]);
  useAttentionEvidence(kind, data ?? null, tab, rows.filter((row) => !row.id.startsWith("locked:")).map(rowId));
  const dataRows = useMemo(() => rows.filter((row) => !row.id.startsWith("locked:")), [rows]);
  // A company's own apps all carry its ticker; the column only earns its room on the board.
  const columns = useMemo(() => !section ? [] : withoutQuietColumns(section.columns.filter((column) => !(column.id === "symbol" && kind === "apps" && symbol && tab !== "peers")),
    dataRows, (row, id) => row.values[id] ?? "", QUIET_COLUMNS), [section, dataRows, kind, symbol, tab]);
  const maxShare = Math.max(0, ...dataRows.map((row) => typeof row.values.share === "number" ? row.values.share : 0));
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const evidence = rows.find((row) => row.id === openEvidence) ?? null;
  const app = rows.find((row) => row.id === openAppId)?.app ?? null;
  const detailOpen = !!openCompany || !!evidence || !!app;
  const tabs = [{ value: "table", label: "Table" }, ...(kind === "apps" || symbol ? [{ value: "chart", label: "Chart" }, { value: "mix", label: kind === "hiring" ? "Mix" : "Markets" }, { value: "peers", label: kind === "apps" && !symbol ? "Companies" : "Peers" }, { value: "evidence", label: "Evidence" }] : [])];
  const { strip, rows: tabRows } = usePaneTabs(model && !openCompany && !app ? { tabs, activeValue: tab, onSelect: (value) => { setTab(value); setOpenEvidence(null); }, focused, dense: true } : null);
  const bodyHeight = Math.max(3, height - tabRows);
  const series = useMemo(() => model ? attentionSeries(model, colors.textBright) : [], [model, colors.textBright]);
  const chartSelection = useChartTableSelection({ rows, getId: rowId, getDate: rowDate, selectedId: selected?.id ?? null, onSelect: setSelected, focused: focused && !detailOpen, enabled: tab === "chart" });
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => { void resource.reload(); paged.reload(); }, { focused: focused && !detailOpen });
  const selectedSymbol = selected?.symbol ?? symbol;
  const source = evidence?.url ?? selected?.url;
  const hints: PaneHint[] = [
    ...(source ? [{ id: "source", key: "o", label: "pen source", onPress: () => void host.openExternal(source) }] : []),
    ...(selected && !evidence && selected.details ? [{ id: "evidence", key: "e", label: "vidence", onPress: () => setOpenEvidence(selected.id) }] : []),
    ...(selected?.app && selectedSymbol && !symbol ? [{ id: "company", key: "c", label: "ompany", onPress: () => setOpenCompany(selectedSymbol) }] : []),
    ...(selectedSymbol ? [
      { id: "description", key: "d", label: "es", onPress: () => createPaneFromTemplate("new-ticker-detail-pane", { symbol: selectedSymbol }) },
      { id: "financials", key: "f", label: "a", onPress: () => createPaneFromTemplate("financial-analysis-pane", { symbol: selectedSymbol }) },
      { id: "chart", key: "g", label: "raph", onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: selectedSymbol }) },
      { id: "related", key: "a", label: kind === "hiring" ? "pps" : " hiring", title: kind === "hiring" ? "App attention" : "Hiring momentum", onPress: () => createPaneFromTemplate(kind === "hiring" ? "apps-pane" : "hiring-pane", { symbol: selectedSymbol }) },
    ] : []),
    ...(model?.preview ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: upgrade }] : []),
  ];
  usePaneStatusFooter({ registrationId: `${kind}:status`, enabled: !openCompany && !app, loading: resource.loading || paged.loadingMore, error: data ? resource.error ?? paged.moreError?.message ?? paged.error?.message : null, stale: resource.data?.stale,
    info: [...(model?.asOf ? [{ id: "observed", parts: [{ text: `as of ${model.asOf.slice(0, 10)}`, tone: "muted" as const }] }] : []), ...(model?.preview ? [{ id: "preview", parts: [{ text: "Pro preview", tone: "warning" as const }] }] : [])], hints });
  usePaneNoticeFooter({ registrationId: `${kind}:notices`, enabled: !openCompany && !app, focused, notices: [...(model?.notices ?? []), ...(resource.data?.refreshError ? [resource.data.refreshError] : [])] });
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall placement={kind === "hiring" ? "hiring-momentum-signin" : "app-attention-signin"} action={kind === "hiring" ? "view hiring momentum" : "view app attention"} needsVerification={session.needsVerification} />;
  const countryOptions = data && kind === "apps" ? (data as AppAttentionPayload).coverage.configuredCountries : [];
  const query = kind === "hiring" && tab !== "mix" ? undefined : <QueryBar width={width} filters={kind === "apps" ? [
    { id: "country", label: "Country", value: country, defaultValue: "", options: [{ value: "", label: "All countries" }, ...countryOptions.map((value) => ({ value, label: value }))], onChange: setCountry },
    { id: "chart", label: "Chart", value: chart, defaultValue: "", options: [{ value: "", label: "All charts" }, { value: "free", label: "Free" }, { value: "paid", label: "Paid" }, { value: "unranked", label: "Unranked" }], onChange: setChart },
    ...(tab === "chart" ? [{ id: "days", label: "Window", value: days, options: ["30", "90", "365", "730"].map((value) => ({ value, label: `${value}D` })), onChange: setDays }] : []),
    ...(tab === "mix" ? [{ id: "mix", label: "View", value: mix, options: [{ value: "countries", label: "Countries" }, { value: "spreads", label: "Rank spreads" }], onChange: setMix }] : []),
  ] : tab === "mix" ? [{ id: "mix", label: "Group", value: mix, options: [{ value: "functions", label: "Role family" }, { value: "seniority", label: "Seniority" }, { value: "countries", label: "Countries" }, { value: "locations", label: "Locations" }, { value: "signals", label: "Signals" }], onChange: setMix }] : []} />;
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} subject={kind === "hiring" ? "hiring momentum" : "app attention"}>
      {model && section ? <PageStackView focused={focused} detailOpen={detailOpen} onBack={() => { setOpenCompany(null); setOpenEvidence(null); setOpenApp(null); }} detailTitle={openCompany ?? app?.name ?? (evidence ? String(evidence.values.title ?? evidence.values.name ?? evidence.id) : undefined)}
        detailContent={openCompany ? <PaneFooterScope active><AttentionView key={openCompany} kind={kind} symbol={openCompany} width={width} height={bodyHeight - 1} focused={focused} /></PaneFooterScope> : app ? <AppRankView focus={app} accessKey={accessKey} width={width} height={bodyHeight - 1} focused={focused} /> : evidence ? <Evidence row={evidence} width={width} height={bodyHeight - 1} focused={focused} /> : null}
        rootContent={<DataTableView columns={columns} items={rows} rootWidth={width} rootHeight={bodyHeight} focused={focused && !detailOpen} scrollRef={scrollRef} onBodyScrollActivity={scrollMore}
          rootBefore={<ChartTableHeader width={width} height={bodyHeight} tableRows={rows.length} tableColumns={columns} query={query} figures={model.figures}
            chart={tab === "chart" ? { series, ...chartSelection, formatValue: (value) => kind === "hiring" ? count(value) : value.toFixed(1), empty: series.length ? undefined : model.preview ? "Full history requires Pro." : "Collecting history", remoteKind: `${kind}-history` } : null} />}
          selection={{ kind: "id", selectedId: selected?.id ?? null, getId: rowId, onChange: setSelected }} getItemKey={rowId}
          sortColumnId={sort.column} sortDirection={sort.direction} onHeaderClick={(column) => setSort((old) => ({ column, direction: old.column === column && old.direction === "desc" ? "asc" : "desc" }))}
          onActivate={(row) => row.id.startsWith("locked:") ? void upgrade() : row.app ? setOpenApp(row.id) : row.symbol && row.symbol !== symbol && (tab === "peers" || !symbol) ? setOpenCompany(row.symbol) : row.details ? setOpenEvidence(row.id) : row.url ? void host.openExternal(row.url) : undefined}
          renderCell={(row, column, _index, state) => {
            if (row.id.startsWith("locked:")) {
              if (!desktop && column.id === columns[0]?.id && row.id === "locked:0") return { text: "Upgrade for all observations", content: <UpgradeLabel text="Upgrade for all observations" onPress={upgrade} role="attention-upgrade" /> };
              return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>Hidden</Text></Blurred> } : { text: "░░░░", color: colors.textDim };
            }
            const value = row.values[column.id];
            if (value == null || value === "") return missingCell(colors);
            if (column.id === "symbol" && typeof value === "string") return listingCell(value, colors, state.selected);
            if (column.id === "signal" && typeof value === "string") return { text: value, color: toneColor(SIGNAL_TONES[value] ?? "text", colors), keepColorWhenSelected: value === "Surge" || value === "Freeze" };
            const numeric = typeof value === "number";
            const decimals = DECIMALS[column.id] ?? 0;
            const text = numeric ? `${SIGNED_COLUMNS.has(column.id) && value > 0 ? "+" : ""}${value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}` : LABEL_COLUMNS.has(column.id) ? humanLabel(value) : column.id === "title" ? value.trim() : value;
            if (column.id === "share" && numeric && tab === "mix") return { ...shareCell(text, maxShare ? value / maxShare : null, column.width, colors, state.selected), value };
            return { text, value, color: numeric && SIGNED_COLUMNS.has(column.id) ? signedColor(value, colors)
              : column.id === "name" || column.id === "title" ? colors.textBright : column.id === "date" || column.id === "observed" || column.id === "confidence" ? colors.textDim : colors.text };
          }} selectedTextOverridesCellColor showHorizontalScrollbar resetScrollKey={`${kind}:${symbol}:${tab}:${mix}:${country}:${chart}`}
          emptyStateTitle={section.empty} bodyAfter={lockedRows && desktop ? <LockedOverlay rows={lockedRows} text="Upgrade for all observations" onPress={upgrade} role="attention-upgrade" /> : undefined} />}
      /> : <EmptyState title="Observations are not available yet." />}
    </PaneStatusBody>
  </Box>;
}
