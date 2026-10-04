import { useCallback, useMemo } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { AttentionGroup, AttentionPayload, AttentionPoint, AttentionRow } from "../../../api-client/attention";
import { ActionRow, ChartTableHeader, DataTableView, EmptyState, KeyValueRow, PaneStatusBody, QueryBar, SectionHeading,
  useChartTableSelection, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, useQueryBarSearch, type DataTableCell, type DataTableColumn, type PaneHint, type StatItem } from "../../../components";
import { staticSeries } from "../../../components/chart/static/series";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, TextAttributes, useRendererHost, useUiCapabilities } from "../../../ui";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { Blurred, LockedOverlay } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { useAttentionEvidence } from "./evidence";
import { cachedAttention, loadAttention } from "./client";
import { listingCell, missingCell, shareCell, signedColor } from "../shared/research-cells";
import { ATTENTION_TABS, attentionRows, attentionTab, attentionWindow, COLUMNS, date, emptyAttention, GROUP_COLUMNS, HISTORY_COLUMNS, historyPoints, hour, number, rowCell, signed, WINDOWS } from "./model";

type DetailRow = Omit<AttentionRow, "researchUnits" | "rank" | "sharePct" | "baselinePeriods"> & {
  researchUnits: number | null; rank: number | null; sharePct: number | null; baselinePeriods: number | null;
};
type Locked = { locked: true; id: string };
const isLocked = (row: unknown): row is Locked => !!row && typeof row === "object" && "locked" in row;
function History({ row, width, height, focused, preview }: { row: DetailRow; width: number; height: number; focused: boolean; preview: boolean }) {
  const colors = useThemeColors();
  const [selected, setSelected] = usePluginPaneState<string | null>("attention:hour", null);
  const points = useMemo(() => [...row.history].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)).map((point, index, all) => ({ ...point,
    change: index && Date.parse(point.bucketStart) - Date.parse(all[index - 1]!.bucketStart) === 3_600_000 ? point.researchUnits - all[index - 1]!.researchUnits : null,
  })).reverse(), [row.history]);
  const selectedHour = points.some((point) => point.bucketStart === selected) ? selected : points[0]?.bucketStart ?? null;
  const series = useMemo(() => [staticSeries(historyPoints(row.history), {
    id: "research-hours", label: `${row.symbol} research hours`, color: colors.warning, calendarSpaced: true,
  })], [row, colors.warning]);
  const link = useChartTableSelection({ rows: points, getId: (point: AttentionPoint) => point.bucketStart, getDate: (point: AttentionPoint) => new Date(point.bucketStart),
    selectedId: selectedHour, onSelect: setSelected, focused });
  return <DataTableView columns={HISTORY_COLUMNS} items={points} sortColumnId="bucketStart" sortDirection="desc" rootWidth={width} rootHeight={height} focused={focused}
    selection={{ kind: "id", selectedId: selectedHour, getId: (point) => point.bucketStart, onChange: setSelected }}
    getItemKey={(point) => point.bucketStart} onActivate={(point) => setSelected(point.bucketStart)} selectedTextOverridesCellColor
    rootBefore={<ChartTableHeader width={width} height={height} tableRows={points.length} tableColumns={HISTORY_COLUMNS}
      figures={[{ id: "research", label: "Research hours", value: number(row.researchUnits) },
        { id: "z", label: "Latest-hour Z", value: signed(row.zScore), ...(row.zScore != null && row.zScore >= 2 ? { tone: "warning" as const } : {}) },
        ...(row.priceChangePct != null ? [{ id: "price", label: "Price move", value: signed(row.priceChangePct, "%"), color: signedColor(row.priceChangePct, colors), detail: row.marketAsOf ? `${row.marketAsOf.slice(11, 16)} UTC` : undefined }] : [])]}
      chart={{ series: points.length >= 3 ? series : [], viewport: points.length >= 3 ? { start: new Date(points.at(-1)!.bucketStart), end: new Date(Date.parse(points[0]!.bucketStart) + 3_600_000) } : undefined, formatValue: (value) => number(value), remoteKind: "attention-history", ...link,
        empty: preview ? "Pro unlocks published history." : "Collecting privacy-qualified hourly history." }} />}
    renderCell={(point, column) => column.id === "bucketStart" ? { text: hour(point.bucketStart), value: point.bucketStart }
      : column.id === "researchUnits" ? { text: number(point.researchUnits), value: point.researchUnits, color: colors.textBright }
      : point.change == null ? { text: "", value: null } : { text: point.change ? `${point.change > 0 ? "+" : ""}${number(point.change)}` : "0", value: point.change, color: signedColor(point.change, colors) }}
    emptyStateTitle="No published hours for this ticker." />;
}
function Evidence({ row, data, width, height }: { row: DetailRow; data: AttentionPayload; width: number; height: number }) {
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const host = useRendererHost();
  const [selectedHour] = usePluginPaneState<string | null>("attention:hour", null);
  const point = row.history.find((entry) => entry.bucketStart === selectedHour) ?? row.history.at(-1);
  const sameDay = row.evidence.periodStart.slice(0, 10) === row.evidence.periodEnd.slice(0, 10);
  const period = sameDay ? `${hour(row.evidence.periodStart)} to ${row.evidence.periodEnd.slice(11, 16)} UTC` : `${hour(row.evidence.periodStart)} to ${date(row.evidence.periodEnd)}`;
  const latest = point?.bucketStart === row.history.at(-1)?.bucketStart;
  return <ScrollBox width={width} height={desktop ? undefined : height} flexGrow={1} flexBasis={0} contentOptions={{ paddingX: 1 }}>
    <KeyValueRow label="Listing" value={row.symbol} detail={row.name ?? undefined} labelWidth={20} />
    <SectionHeading title="Publication" />
    <KeyValueRow label="Research hours" value={number(row.researchUnits)} detail={`rounded to ${data.privacy.rounding}`} labelWidth={20} />
    <KeyValueRow label="Hour" value={period} labelWidth={20} />
    <KeyValueRow label="Published" value={date(row.evidence.asOf)} detail={`after ${data.privacy.lagHours}h minimum`} labelWidth={20} />
    <KeyValueRow label="Privacy threshold" value={`${data.privacy.minimumContributors} contributors per hour`} detail={`passed · methodology ${row.evidence.methodologyVersion}`} labelWidth={20} />
    <KeyValueRow label="Baseline" value={row.baselinePeriods === null ? "--" : `${row.baselinePeriods} qualified periods`} detail={row.zScore === null ? "Z-score unavailable" : `Z ${signed(row.zScore)}`} labelWidth={20} />
    {row.marketAsOf || row.relativeVolumeAsOf ? <>
      <SectionHeading title="Market Context" />
      {row.marketAsOf ? <KeyValueRow label="Price move" value={signed(row.priceChangePct, "%")} detail={date(row.marketAsOf)} labelWidth={20} /> : null}
      {row.relativeVolumeAsOf ? <KeyValueRow label="Relative volume" value={row.relativeVolume === null ? "--" : `${number(row.relativeVolume, 2)}x`} detail={date(row.relativeVolumeAsOf)} labelWidth={20} /> : null}
    </> : null}
    {point?.publishedAt && !latest ? <>
      <SectionHeading title="Selected Hour" />
      <KeyValueRow label="Hour" value={date(point.bucketStart)} labelWidth={20} />
      <KeyValueRow label="Research hours" value={number(point.researchUnits)} detail={`rounded to ${point.rounding ?? "--"}`} labelWidth={20} />
      <KeyValueRow label="Published" value={date(point.publishedAt)} detail={`${point.minimumContributors ?? "--"} contributors · ${point.lagHours ?? "--"}h lag · version ${point.methodologyVersion ?? "--"}`} labelWidth={20} />
    </> : null}
    <SectionHeading title="Related News" />
    {row.news.length ? row.news.map((article) => <ActionRow key={article.url} label={`${hour(article.publishedAt)}  ${article.title}`} onPress={() => void host.openExternal(article.url)} />)
      : <EmptyState title="No related headlines in this publication." />}
  </ScrollBox>;
}
export function AttentionPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const host = useRendererHost();
  const { createPaneFromTemplate } = usePluginAppActions();
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "pro" : "preview"}`;
  const openUpgrade = useCloudUpgradeAction("attention");
  const [initialWindow] = usePaneSettingValue("window", "now");
  const [savedWindow, setWindow] = usePluginPaneState("attention:window", initialWindow);
  const window = attentionWindow(savedWindow);
  const [initialSymbol] = usePaneSettingValue("symbol", "");
  const [initialTab] = usePaneSettingValue("tab", initialSymbol ? "history" : "ranking");
  const [savedTab, setTab] = usePluginPaneState("attention:tab", initialTab);
  const tab = attentionTab(savedTab);
  const [groupFilter, setGroupFilter] = usePluginPaneState<{ field: "sector" | "country"; value: string } | null>("attention:group-filter", null);
  const [query, setQuery] = usePluginPaneState("attention:query", "");
  const search = useQueryBarSearch();
  const [selectedId, setSelected] = usePluginPaneState<string | null>("attention:selected", initialSymbol || null);
  const [groupSelectedId, setGroupSelected] = usePluginPaneState<string | null>("attention:group", null);
  const [sort, setSort] = usePluginPaneState<{ column: string; direction: "asc" | "desc" }>("attention:sort", { column: "rank", direction: "asc" });
  const loader = useCallback((force: boolean) => loadAttention(window, accessKey, undefined, force), [window, accessKey]);
  const resource = useAsyncResource(loader, { initialData: () => cachedAttention(window, accessKey), clearOnError: isAccessDenied });
  const data = resource.data?.payload;
  const rows = useMemo(() => attentionRows((data?.rows ?? []).filter((row) => !groupFilter || (row[groupFilter.field] ?? "Unknown") === groupFilter.value), tab, query, tab === "abnormal" ? "zScore" : sort.column, tab === "abnormal" ? "desc" : sort.direction), [data, tab, query, sort, groupFilter]);
  const selectedSymbol = data?.rows.find((row) => row.symbol === selectedId || row.ticker === selectedId)?.symbol ?? selectedId ?? rows[0]?.symbol ?? "";
  const detailMode = tab === "history" || tab === "evidence";
  const groupMode = tab === "sectors" || tab === "countries";
  const detailLoader = useCallback((force: boolean) => loadAttention(window, accessKey, selectedSymbol, force), [window, accessKey, selectedSymbol]);
  const detail = useAsyncResource(detailMode && selectedSymbol ? detailLoader : null, { clearOnError: isAccessDenied });
  const detailData = detail.data?.payload;
  const selected: DetailRow | undefined = (detailMode ? detailData?.rows : rows)?.find((row) => row.symbol === selectedSymbol || row.ticker === selectedSymbol) ?? (detailMode && detailData?.rows.length === 1 ? detailData.rows[0] : !detailMode ? rows[0] : undefined)
    ?? (detailMode && detailData?.selectedListing && detailData.historyEvidence && detailData.history?.length ? {
      ...detailData.selectedListing, history: detailData.history, evidence: detailData.historyEvidence,
      rank: null, researchUnits: null, sharePct: null, zScore: null, baselinePeriods: null,
      priceChangePct: null, relativeVolume: null, marketAsOf: null, relativeVolumeAsOf: null, news: [],
    } : undefined);
  useAttentionEvidence((detailMode ? detailData : data) ?? null, tab, selectedSymbol, tab === "history" ? selected?.history.length ?? 0 : rows.length);
  const { strip, rows: tabRows } = usePaneTabs((data || detailData) && (data?.rows.length || data?.status === "ready" || !!initialSymbol || detailMode && !!selectedSymbol) ? { tabs: [...ATTENTION_TABS], activeValue: tab, onSelect: setTab, focused, dense: true } : null);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => { void resource.reload(); if (detailMode) void detail.reload(); }, { focused });
  const hints: PaneHint[] = [
    ...(selected && !groupMode ? [
      { id: "description", key: "d", label: "es", onPress: () => createPaneFromTemplate("new-ticker-detail-pane", { symbol: selected.symbol }) },
      { id: "financials", key: "f", label: "a", onPress: () => createPaneFromTemplate("financial-analysis-pane", { symbol: selected.symbol }) },
      { id: "chart", key: "g", label: "raph", onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: selected.symbol }) },
      { id: "news", key: "n", label: "ews", onPress: () => createPaneFromTemplate("ticker-news-pane", { symbol: selected.symbol }) },
      { id: "evidence", key: "e", label: "vidence", onPress: () => setTab("evidence") },
    ] : []),
    ...(tab === "evidence" && data ? [{ id: "methodology", key: "o", label: "pen methodology", onPress: () => void host.openExternal(data.methodologyUrl) }] : []),
    ...(data?.entitlement === "preview" ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: openUpgrade }] : []),
  ];
  usePaneStatusFooter({ registrationId: "attention", loading: resource.loading || detailMode && detail.loading, error: data ? resource.error ?? (detailMode ? detail.error : null) : null,
    stale: data?.stale || resource.data?.stale, info: data?.asOf ? [{ id: "asof", parts: [{ text: `published ${date(data.asOf)}`, tone: "muted" }] }] : [], hints });
  usePaneNoticeFooter({ registrationId: "attention:notices", focused, notices: [resource.data?.refreshError, detailMode ? detail.data?.refreshError : null,
    data?.status === "ready" && selected?.zScore === null ? "The selected ticker has insufficient qualified history for an abnormal-attention score." : null,
  ].filter((value): value is string => !!value) });
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall action="view research attention" needsVerification={session.needsVerification} />;
  const bodyHeight = Math.max(3, height - tabRows);
  const queryBar = <QueryBar width={width} filters={[{ id: "window", label: "Period", inline: true, value: window, options: WINDOWS,
    onChange: (value: string) => setWindow(value) }, ...(detailMode && data?.rows.length ? [{ id: "ticker", label: "Ticker", value: selectedSymbol,
      options: data.rows.map((row) => ({ value: row.symbol, label: row.symbol })), onChange: (value: string) => setSelected(value) }] : []),
      ...(!detailMode && !groupMode && groupFilter ? [{ id: "group", label: groupFilter.field === "country" ? "Country" : "Sector", value: groupFilter.value, defaultValue: "all",
        options: [{ value: "all", label: "All" }, ...(data?.[groupFilter.field === "country" ? "countries" : "sectors"] ?? []).map((group) => ({ value: group.name, label: group.name }))],
        onChange: (value: string) => { setGroupFilter(value === "all" ? null : { ...groupFilter, value }); setSelected(null); } }] : [])]}
    search={!detailMode ? { focused, value: query, onChange: (value: string) => { setQuery(value); setSelected(null); }, placeholder: groupMode ? "Find group" : "Find ticker, sector or country", ...search.searchProps } : undefined} />;
  const groups = groupMode ? (data?.[tab] ?? []).filter((group) => group.name.toLowerCase().includes(query.toLowerCase())) : [];
  const visibleRows: Array<AttentionRow | AttentionGroup | Locked> = groupMode ? groups : rows;
  const hidden = data ? Math.max(0, data.counts[groupMode ? tab : "rows"] - (groupMode ? data[tab].length : data.rows.length)) : 0;
  const items = [...visibleRows, ...Array.from({ length: Math.min(3, hidden) }, (_, i): Locked => ({ locked: true, id: `locked:${i}` }))];
  const columns = groupMode ? GROUP_COLUMNS : COLUMNS;
  const rowId = (row: AttentionRow | AttentionGroup | Locked) => isLocked(row) ? row.id : "symbol" in row ? row.symbol : row.name;
  const maxShare = Math.max(0, ...visibleRows.map((row) => isLocked(row) ? 0 : row.sharePct ?? 0));
  const cell = (row: AttentionRow | AttentionGroup | Locked, column: DataTableColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    if (isLocked(row)) return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>{column.id === "name" ? "Additional research" : "Hidden"}</Text></Blurred> }
      : { text: column.id === columns[0]!.id && row.id === "locked:0" ? "Pro" : "░░░", color: colors.textDim };
    if (column.id === "sharePct") return { ...shareCell(number(row.sharePct, 1), maxShare ? row.sharePct / maxShare : null, column.width, colors, state.selected), value: row.sharePct };
    if ("symbol" in row) {
      const numeric = typeof row[column.id as keyof AttentionRow] === "number" ? row[column.id as keyof AttentionRow] as number : undefined;
      switch (column.id) {
        case "symbol": return listingCell(row.symbol, colors, state.selected);
        case "rank": return { text: rowCell(row, column.id), value: numeric, color: colors.textDim };
        case "researchUnits": return { text: rowCell(row, column.id), value: numeric, color: colors.textBright };
        case "zScore": return row.zScore == null ? missingCell(colors) : { text: rowCell(row, column.id), value: row.zScore,
          color: row.zScore >= 2 ? colors.warning : row.zScore < 0 ? colors.textDim : colors.text, attributes: row.zScore >= 2 ? TextAttributes.BOLD : 0, keepColorWhenSelected: row.zScore >= 2 };
        case "priceChangePct": return row.priceChangePct == null ? missingCell(colors) : { text: rowCell(row, column.id), value: row.priceChangePct, color: signedColor(row.priceChangePct, colors) };
        case "relativeVolume": return row.relativeVolume == null ? missingCell(colors) : { text: rowCell(row, column.id), value: row.relativeVolume, color: row.relativeVolume >= 2 ? colors.textBright : colors.text };
        case "sector": case "country": return { text: rowCell(row, column.id), color: colors.textDim };
        default: return { text: rowCell(row, column.id), value: numeric, color: colors.text };
      }
    }
    const value = row[column.id as keyof AttentionGroup];
    return { text: typeof value === "number" ? number(value) : value, value: typeof value === "number" ? value : undefined,
      color: column.id === "name" ? colors.textBright : column.id === "tickers" ? colors.textDim : colors.text };
  };
  // The whole board in four figures; a preview would only summarise its own three rows.
  const top = (groups: readonly AttentionGroup[]) => groups[0] ? { value: groups[0].name, detail: `${number(groups[0].sharePct, 1)}%` } : null;
  const topSector = data ? top(data.sectors) : null, topCountry = data ? top(data.countries) : null;
  const abnormal = data?.rows.filter((row) => row.zScore != null && row.zScore >= 2).length ?? 0;
  const figures: StatItem[] = data && !groupMode && !detailMode && data.entitlement !== "preview" && data.rows.length ? [
    { id: "hours", label: "Research hours", value: number(data.rows.reduce((sum, row) => sum + row.researchUnits, 0)), detail: WINDOWS.find((entry) => entry.value === window)?.label.toLowerCase() },
    { id: "abnormal", label: "Abnormal", value: String(abnormal), detail: "Z ≥ 2", ...(abnormal ? { tone: "warning" as const } : {}) },
    ...(topSector ? [{ id: "sector", label: "Top sector", ...topSector }] : []),
    ...(topCountry ? [{ id: "country", label: "Top country", ...topCountry }] : []),
  ] : [];
  return <Box width={width} height={height} flexDirection="column">{strip}
    <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} empty={!detailMode && !!data && data.status !== "ready" && !data.rows.length}
      emptyTitle={emptyAttention(data)} subject="research attention">
      {data ? detailMode ? <Box flexGrow={1} flexBasis={0} flexDirection="column">{queryBar}
        <PaneStatusBody loading={!detailData && detail.loading} error={!detailData ? detail.error : null} empty={!!detailData && !selected}
          emptyTitle={data.entitlement === "preview" ? "This ticker is outside the current preview." : "No privacy-qualified hours for this ticker."} subject="ticker attention">
          {selected ? tab === "history" ? <History row={selected} width={width} height={bodyHeight - 1} focused={focused} preview={data.entitlement === "preview"} />
            : <Evidence row={selected} data={detailData ?? data} width={width} height={bodyHeight - 1} /> : null}
        </PaneStatusBody>
      </Box> : <DataTableView columns={columns} items={items} rootWidth={width} rootHeight={bodyHeight} focused={focused && !search.active}
        rootBefore={figures.length ? <ChartTableHeader width={width} height={bodyHeight} tableRows={items.length} tableColumns={columns} query={queryBar} figures={figures} /> : queryBar}
        getItemKey={rowId} selection={{ kind: "id", selectedId: groupMode ? groupSelectedId : selected?.symbol ?? null, getId: rowId, onChange: (id) => { if (groupMode) setGroupSelected(id); else if (!id.startsWith("locked:")) setSelected(id); } }}
        onActivate={(row) => { if (isLocked(row)) openUpgrade(); else if ("symbol" in row) { setSelected(row.symbol); setTab("history"); } else { setGroupFilter({ field: tab === "countries" ? "country" : "sector", value: row.name }); setQuery(""); setSelected(null); setTab("ranking"); } }}
        renderCell={cell} selectedTextOverridesCellColor showHorizontalScrollbar
        sortColumnId={!groupMode ? tab === "abnormal" ? "zScore" : sort.column : null} sortDirection={tab === "abnormal" ? "desc" : sort.direction}
        onHeaderClick={!groupMode && tab !== "abnormal" ? (column) => setSort((current) => ({ column, direction: current.column === column && current.direction === "desc" ? "asc" : "desc" })) : undefined}
        emptyStateTitle={tab === "abnormal" ? "Collecting enough qualified history for abnormal attention." : "No published research matches."}
        bodyAfter={hidden && desktop ? <LockedOverlay rows={Math.min(3, hidden)} text="Pro unlocks the full attention graph" onPress={openUpgrade} /> : undefined} /> : null}
    </PaneStatusBody>
  </Box>;
}
