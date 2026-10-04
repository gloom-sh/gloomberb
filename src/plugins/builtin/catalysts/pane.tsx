import { usePaneInstance } from "../../../state/app/context";
import { useCatalystEvidence } from "./evidence";
import { useCallback, useMemo, useRef, useState } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import { CATALYST_TYPES, type CatalystDetail, type CatalystEvent, type CatalystResponse } from "../../../api-client/catalysts";
import { buildSectionedRows, DataTableView, EmptyState, EMPTY_TABLE_CELL, PageStackView, PaneStatusBody, QueryBar, renderSectionedRowHeader, usePagedRows, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, useTableLoadMore,
  type DataTableCell, type PageRequest, type PaneHint, type SectionedRow } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { Blurred, LockedOverlay, UpgradeLabel } from "../shared/locked-rows";
import { listingCell } from "../shared/research-cells";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { loadCatalystDetail, loadCatalysts, validateCatalysts } from "./client";
import { CatalystEventDetail } from "./detail";
import { catalystAgency, catalystCell, catalystColumns, catalystLabel, catalystQuery, catalystSection, catalystSymbol, catalystTab, CATALYST_TABS } from "./model";

type Row = SectionedRow<CatalystEvent> | { kind: "locked"; key: string };
const rowKey = (row: Row) => row.key;
const isEventRow = (row: Row): row is { kind: "item"; key: string; item: CatalystEvent } => row.kind === "item";
const isSelectable = (row: Row) => row.kind === "item" || row.kind === "locked";

const EMPTY_FILTERS: Record<string, unknown> = {};
const EMPTY_DETAILS: Record<string, CatalystDetail> = {};

export function CatalystsPane(props: PaneProps) {
  const [scope] = usePaneSettingValue<string>("symbol", "");
  return <CatalystView key={scope || "market"} {...props} symbol={scope || null} />;
}
export function LitigationPane(props: PaneProps) {
  const { symbol } = usePaneTickerIdentity();
  return symbol ? <CatalystView key={symbol} {...props} symbol={symbol} litigation /> : <EmptyState title="Select a ticker." />;
}
export function CatalystView({ width, height, focused, symbol, litigation = false }: Pick<PaneProps, "width" | "height" | "focused"> & { symbol: string | null; litigation?: boolean }) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const instance = usePaneInstance();
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "full" : "preview"}`;
  const { createPaneFromTemplate, openPluginCommandWorkflow } = usePluginAppActions();
  const openUpgrade = useCloudUpgradeAction("catl");
  const [initialTab] = usePaneSettingValue("tab", "calendar");
  const [savedTab, setTab] = usePluginPaneState("catalyst:tab", initialTab);
  const tab = catalystTab(savedTab);
  const [initialFilters] = usePaneSettingValue<Record<string, unknown>>("filters", EMPTY_FILTERS);
  const defaultFilters = useMemo(() => ({ ...catalystQuery(instance?.settings ?? {}), ...initialFilters }), [instance?.settings, initialFilters]);
  const [filters, setFilters] = usePluginPaneState<Record<string, unknown>>("catalyst:filters", defaultFilters);
  const [snapshotSetting] = usePaneSettingValue<CatalystResponse | null>("catalystSnapshot", null);
  const [detailSnapshots] = usePaneSettingValue<Record<string, CatalystDetail>>("catalystDetails", EMPTY_DETAILS);
  const [initialOpen] = usePaneSettingValue("open", "");
  const [detailTab] = usePaneSettingValue("detailTab", "evidence");
  const [openId, setOpenId] = usePluginPaneState<string>("catalyst:open", initialOpen);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("catalyst:selected", null);
  const [searchActive, setSearchActive] = useState(false);
  const [dateFieldActive, setDateFieldActive] = useState<string | null>(null);
  const snapshot = useMemo(() => { try { return snapshotSetting ? validateCatalysts(snapshotSetting) : null; } catch { return null; } }, [snapshotSetting]);
  const query = useMemo(() => catalystQuery({ ...filters, tab }, symbol ?? undefined, litigation), [filters, tab, symbol, litigation]);
  const loader = useCallback(async ({ offset, signal, force }: PageRequest) => {
    const result = snapshot ? { payload: snapshot, stale: false, refreshError: null } : await loadCatalysts({ ...query, limit: 100, offset }, accessKey, force, signal);
    const data = result.payload;
    return { ...result, rows: data.events, nextOffset: data.offset + data.events.length, hasMore: !snapshot && data.access?.pro !== false && data.events.length > 0 && data.offset + data.events.length < data.total };
  }, [snapshot, query, accessKey]);
  const resource = usePagedRows(loader, { getId: (event) => event.id });
  const page = resource.pages[0];
  const data = page?.payload;
  const error = resource.error ?? resource.moreError;
  const denied = isAccessDenied(error);
  const rows = denied ? [] : resource.rows;
  const selected = rows.find((event) => event.id === selectedId) ?? rows[0] ?? null;
  const lockedRows = Math.min(3, data?.access?.lockedRows ?? 0);
  // Grouped by month on the calendar and by day in the change feed, in the order the server sends them.
  const items = useMemo<Row[]>(() => {
    const groups = new Map<string, CatalystEvent[]>();
    for (const event of rows) {
      const label = catalystSection(event, query.dateField, tab === "changes");
      groups.set(label, [...(groups.get(label) ?? []), event]);
    }
    return [...buildSectionedRows([...groups].map(([label, events]) => ({ label, items: events })), (event) => event.id),
      ...Array.from({ length: lockedRows }, (_, index): Row => ({ kind: "locked", key: `locked:${index}` }))];
  }, [rows, query.dateField, tab, lockedRows]);
  const listedOpen = rows.find((event) => event.id === openId) ?? null;
  const openLoader = useCallback((force: boolean) => loadCatalystDetail(openId!, accessKey, force), [openId, accessKey]);
  const externalOpen = useAsyncResource(openId && !listedOpen && !detailSnapshots[openId] ? openLoader : null, { clearOnError: isAccessDenied });
  const open = listedOpen ?? (openId ? detailSnapshots[openId]?.event : null) ?? externalOpen.data?.payload.event ?? null;
  useCatalystEvidence(data ?? null, tab, open?.id ?? null, rows.map((event) => event.id));
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadMore = useTableLoadMore(scrollRef, resource.hasMore, resource.loadMore);
  const asOf = data?.asOf ? Date.parse(data.asOf) : null;
  useAutoRefresh(asOf && Number.isFinite(asOf) ? asOf : null, resource.reload);
  usePaneRefreshKey(resource.reload, { focused: focused && !openId });
  const { strip, rows: tabRows } = usePaneTabs(!openId ? { tabs: [...CATALYST_TABS].map((item) => litigation && item.value === "calendar" ? { ...item, label: "Dockets" } : item), activeValue: tab, onSelect: (value) => { setTab(value); setSelectedId(null); }, focused, dense: true } : null);
  const selectedSymbol = selected ? catalystSymbol(selected) : symbol;
  const hints: PaneHint[] = [
    ...(!openId && selectedSymbol ? [{ id: "description", key: "d", label: "es", onPress: () => createPaneFromTemplate("new-ticker-detail-pane", { symbol: selectedSymbol }) },
      { id: "financials", key: "f", label: "a", onPress: () => createPaneFromTemplate("financial-analysis-pane", { symbol: selectedSymbol }) },
      { id: "chart", key: "g", label: "raph", onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: selectedSymbol }) },
      { id: "related", key: "t", label: litigation ? "o calendar" : "o litigation", onPress: () => createPaneFromTemplate(litigation ? "catalysts-pane" : "litigation-pane", { symbol: selectedSymbol }) }] : []),
    ...(!openId ? [{ id: "alert", key: "a", label: "lert", onPress: () => openPluginCommandWorkflow("set-event-alert") }] : []),
    ...(data?.access && data.access.lockedRows > 0 ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: openUpgrade }] : []),
  ];
  usePaneStatusFooter({ registrationId: "catalysts", enabled: !openId, loading: resource.loading || resource.loadingMore, error: data ? error?.message ?? page?.refreshError : null, stale: page?.stale,
    info: data?.asOf ? [{ id: "as-of", parts: [{ text: `as of ${data.asOf.slice(0, 16).replace("T", " ")} UTC`, tone: "muted" }] }] : [], hints });
  usePaneNoticeFooter({ registrationId: "catalysts:notice", focused, notices: [
    ...(page?.refreshError ? [page.refreshError] : []),
    ...(data?.coverage.sources.filter((source) => source.enabled && source.state?.lastError).map((source) => `${source.agency} records are delayed. Last successful collection: ${source.state?.lastOkAt?.slice(0, 16).replace("T", " ") ?? "not yet available"}.`) ?? []),
  ] });
  const changeFilter = (key: string, value: unknown) => { setFilters((old) => ({ ...old, [key]: value })); setSelectedId(null); };
  const options = (values: readonly string[]) => [{ value: "", label: "All" }, ...values.map((value) => ({ value, label: catalystLabel(catalystAgency(value)) }))];
  const queryBar = <QueryBar width={width} search={{ value: String(filters.search ?? ""), onChange: (value) => changeFilter("search", value), placeholder: "Search events or parties", focused, active: searchActive, onActiveChange: setSearchActive, debounceMs: 300 }} filters={[
    ...(["from", "to"] as const).map((key) => ({ id: key, kind: "text" as const, label: catalystLabel(key), value: String(filters[key] ?? ""), placeholder: "YYYY-MM-DD", focused, active: dateFieldActive === key, onActiveChange: (value: boolean) => setDateFieldActive(value ? key : null), onChange: (value: string) => changeFilter(key, value), width: 10, debounceMs: 400 })),
    ...(!litigation ? [{ id: "type", label: "Type", value: String(filters.type ?? ""), defaultValue: "", options: options(CATALYST_TYPES), onChange: (value: string) => changeFilter("type", value) }] : []),
    ...(["agency", "country", "sector", "status"] as const).map((key) => ({ id: key, label: catalystLabel(key), value: String(filters[key] ?? ""), defaultValue: "", options: options(data?.facets[({ agency: "agencies", country: "countries", sector: "sectors", status: "statuses" } as const)[key]] ?? []), onChange: (value: string) => changeFilter(key, value) })),
    ...(tab === "calendar" ? [{ id: "upcoming", kind: "toggle" as const, label: "Upcoming", value: filters.upcoming === true, onChange: (value: boolean) => changeFilter("upcoming", value) },
      { id: "date", label: "Date", value: String(filters.dateField ?? "any"), options: [{ value: "any", label: "Any date" }, { value: "announced", label: "Announced" }, { value: "effective", label: "Effective" }, { value: "deadline", label: "Deadlines" }], onChange: (value: string) => changeFilter("dateField", value) }] : []),
  ]} />;
  const columns = catalystColumns(width, tab === "changes", litigation);
  const renderCell = (row: Row, column: (typeof columns)[number], _index: number, state: { selected: boolean }): DataTableCell => {
    if (row.kind === "locked") {
      if (!desktop && column.id === "title" && row.key === "locked:0") return { text: "Upgrade for every catalyst and its history", content: <UpgradeLabel text="Upgrade for every catalyst and its history" onPress={openUpgrade} role="catalysts-upgrade" />, onMouseDown: openUpgrade };
      return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>{column.id === "title" ? "Additional catalyst" : "Hidden"}</Text></Blurred> } : { text: "░░░░", color: colors.textDim };
    }
    if (!isEventRow(row)) return EMPTY_TABLE_CELL;
    const event = row.item;
    const text = catalystCell(event, column.id, query.dateField, tab === "changes");
    if (column.id === "ticker") {
      const symbol = catalystSymbol(event);
      if (!symbol) return { text, color: colors.textMuted };
      const more = event.parties.filter((party) => party.ticker).length - 1;
      return more > 0 ? { text, color: colors.textBright } : listingCell(symbol, colors, state.selected);
    }
    return { text, color: column.id === "title" ? colors.textBright : column.id === "date" ? colors.text
      : column.id === "status" && tab === "changes" ? colors.text : colors.textDim };
  };
  if (isCloudSessionRequired(error?.message)) return <SignInWall action="view catalysts" needsVerification={session.needsVerification} />;
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PaneStatusBody loading={!openId && !data && resource.loading} error={!openId && (!data || denied) ? error?.message : null} subject={litigation ? "company litigation" : "catalysts"}>
      <PageStackView focused={focused} detailOpen={!!openId} onBack={() => setOpenId("")} detailTitle={open?.title ?? "Catalyst"}
        detailContent={open ? <CatalystEventDetail key={open.id} event={open} accessKey={accessKey} snapshot={detailSnapshots[open.id]} width={width} height={Math.max(3, height - 1)} focused={focused} initialTab={detailTab} openUpgrade={openUpgrade} /> : <PaneStatusBody loading={externalOpen.loading} error={externalOpen.error} subject="catalyst event"><EmptyState title="Event unavailable." /></PaneStatusBody>}
        rootContent={<DataTableView<Row> rootWidth={width} rootHeight={Math.max(3, height - tabRows)} rootBefore={queryBar} focused={focused && !openId && !searchActive && !dateFieldActive}
          items={items} sortColumnId={null} sortDirection="asc" columns={columns} getItemKey={rowKey}
          isNavigable={isSelectable} renderSectionHeader={(row) => row.kind === "locked" ? null : renderSectionedRowHeader(row)}
          selection={{ kind: "id", selectedId: selected?.id ?? null, getId: rowKey, onChange: (id) => { if (!id.startsWith("locked:")) setSelectedId(id); } }}
          onActivate={(row) => row.kind === "locked" ? openUpgrade() : isEventRow(row) ? setOpenId(row.item.id) : undefined}
          renderCell={renderCell}
          scrollRef={scrollRef} onBodyScrollActivity={loadMore} resetScrollKey={JSON.stringify(query)} showHorizontalScrollbar selectedTextOverridesCellColor
          emptyStateTitle={data?.coverage.totalEvents === 0 ? "Catalyst history is collecting." : tab === "changes" ? "No observed status or date changes match." : "No events match these filters."}
          bodyAfter={lockedRows && desktop ? <LockedOverlay rows={lockedRows} text="Upgrade for every catalyst and its history" onPress={openUpgrade} role="catalysts-upgrade" /> : undefined} />}
      />
    </PaneStatusBody>
  </Box>;
}
