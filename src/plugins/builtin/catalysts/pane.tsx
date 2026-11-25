import { MISSING_VALUE } from "../../../utils/format";
import { daysInTextCell } from "../../../components/ui/day-cell";
import { usePaneInstance } from "../../../state/app/context";
import { useCatalystEvidence } from "./evidence";
import { useCallback, useMemo, useRef, useState } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import { CATALYST_TYPES, type CatalystDetail, type CatalystEvent, type CatalystResponse } from "../../../api-client/catalysts";
import { buildSectionedRows, DataTableView, EmptyState, EMPTY_TABLE_CELL, PageStackView, PaneStatusBody, QueryBar, renderSectionedRowHeader, usePagedRows, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, useTableLoadMore,
  type DataTableCell, type PageLoader, type PageRequest, type PaneHint, type SectionedRow } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { withCountryFlag } from "../../../components/ui/country-flag";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { useOpenDescription } from "../shared/open-description";
import { Blurred, LockedOverlay, UpgradeLabel } from "../shared/locked-rows";
import { listingCell, toneColor } from "../shared/research-cells";
import { logFailure } from "../../../utils/log-failure";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { loadCatalystDetail, loadCatalysts, validateCatalysts } from "./client";
import { CatalystEventDetail } from "./detail";
import { catalystAgency, catalystBasisWidth, catalystCell, catalystColumns, catalystDateWithheld, catalystEmptyTitle, catalystLabel, catalystLockedText, catalystQuery, catalystSections, catalystShownStatus, catalystStatusTone, catalystSymbol, catalystTab, catalystTypeTone, CATALYST_TABS } from "./model";
import { CATALYST_KINDS, catalystKindCell, catalystKindColumns, catalystKindFold, catalystKindNoun, catalystKindOf, catalystKindTypes, catalystKindWidths, catalystOpeningKind, catalystSelf, catalystStreamLimit, catalystWith, createCatalystKindLoader, isCatalystKind, type CatalystKind, type CatalystKindPage } from "./kinds";

type Row = SectionedRow<CatalystEvent> | { kind: "locked"; key: string };
const rowKey = (row: Row) => row.key;
const isEventRow = (row: Row): row is { kind: "item"; key: string; item: CatalystEvent } => row.kind === "item";
const isSelectable = (row: Row) => row.kind === "item" || row.kind === "locked";

const EMPTY_FILTERS: Record<string, unknown> = {};
const EMPTY_DETAILS: Record<string, CatalystDetail> = {};

/** Litigation columns a docket list can share on every case. */
const LITIGATION_SHARED = new Set(["basis", "type", "agency", "country"]);

export function CatalystsPane(props: PaneProps) {
  const { symbol: bound } = usePaneTickerIdentity();
  const [scope] = usePaneSettingValue<string>("symbol", "");
  const symbol = bound || scope.trim() || null;
  return <CatalystView key={symbol || "market"} {...props} symbol={symbol} />;
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
  const openDescription = useOpenDescription();
  const openUpgrade = useCloudUpgradeAction("catl");
  const [initialTab] = usePaneSettingValue("tab", "calendar");
  const [savedTab, setTab] = usePluginPaneState("catalyst:tab", initialTab);
  const tab = catalystTab(savedTab);
  // The calendar is one kind of event at a time; litigation is its own list.
  const kinds = !litigation;
  const [initialKind] = usePaneSettingValue<string>("kind", "");
  const [chosenKind, setKind] = usePluginPaneState<string>("catalyst:kind", initialKind);
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
  const snapshot = useMemo(() => { try { return snapshotSetting ? validateCatalysts(snapshotSetting) : null; } catch (error) { return logFailure("catalysts.pane", "Validate catalysts snapshot failed", null)(error); } }, [snapshotSetting]);
  const query = useMemo(() => catalystQuery({ ...filters, tab }, symbol ?? undefined, litigation), [filters, tab, symbol, litigation]);
  // With no kind chosen, the calendar opens on the first kind with something
  // coming up, read from its unfiltered first page, and keeps it while open.
  const probed = useRef<CatalystKind | null>(null);
  const chosen = isCatalystKind(chosenKind) ? chosenKind : probed.current;
  const probeQuery = kinds && tab === "calendar" && !snapshot && !query.type && !chosen ? query : null;
  const probeLoader = useMemo(() => probeQuery ? (force: boolean) => loadCatalysts({ ...probeQuery, limit: 100, offset: 0 }, accessKey, force) : null, [probeQuery, accessKey]);
  const probe = useAsyncResource(probeLoader);
  const kind = kinds ? catalystOpeningKind(query.type, chosen, snapshot?.events ?? (probe.error ? [] : probe.data?.payload.events ?? null)) : null;
  if (kind && !query.type && !chosen) probed.current = kind;
  const kindView = tab === "calendar" && kind ? kind : null;
  const loader = useMemo((): PageLoader<CatalystKindPage> | null => {
    if (snapshot) return async () => ({ payload: snapshot, stale: false, refreshError: null, rows: snapshot.events, nextOffset: snapshot.events.length, hasMore: false });
    if (kinds && tab === "calendar") {
      if (!kindView) return null;
      // The service filters one type at a time; a kind reads its types together, in calendar order.
      const types = query.type ? [query.type] : catalystKindTypes(kindView);
      const limit = catalystStreamLimit(types);
      const read = createCatalystKindLoader(types, (type, offset, force, signal) => loadCatalysts({ ...query, type, limit, offset }, accessKey, force, signal), query);
      return ({ offset, signal, force }: PageRequest) => read({ offset, signal, force });
    }
    return async ({ offset, signal, force }: PageRequest) => {
      const result = await loadCatalysts({ ...query, limit: 100, offset }, accessKey, force, signal);
      const data = result.payload;
      return { ...result, rows: data.events, nextOffset: data.offset + data.events.length, hasMore: data.access?.pro !== false && data.events.length > 0 && data.offset + data.events.length < data.total };
    };
  }, [snapshot, kinds, tab, kindView, query, accessKey]);
  const resource = usePagedRows(loader, { getId: (event) => event.id,
    savedCopy: snapshot || !session.displayScope ? null : { key: kindView ? ["catalysts", query, accessKey, kindView] : ["catalysts", query, accessKey] } });
  const choosing = kinds && tab === "calendar" && !kind;
  const page = resource.pages[0];
  const data = page?.payload;
  const error = resource.error ?? resource.moreError;
  const denied = isAccessDenied(error);
  const rows = denied ? [] : resource.rows;
  const selected = rows.find((event) => event.id === selectedId) ?? rows[0] ?? null;
  const lockedRows = Math.min(3, data?.access?.lockedRows ?? 0);
  // Grouped by month on the calendar and by day in the change feed, in the order the server sends them.
  // A month of one or two events reads from their dates, without a heading of its own.
  const items = useMemo<Row[]>(() => {
    return [...buildSectionedRows(catalystSections(rows, query, tab === "changes"), (event) => event.id, { minItemsForHeader: tab === "calendar" ? 3 : 0 }),
      ...Array.from({ length: lockedRows }, (_, index): Row => ({ kind: "locked", key: `locked:${index}` }))];
  }, [rows, query, tab, lockedRows]);
  // "Upgrade for 16 more events (2 upcoming)": what the preview holds back, and how much of it is still ahead.
  const locked = catalystLockedText(data?.access, litigation ? "case" : "event");
  const upgradeText = locked ? `Upgrade for ${locked}` : "Upgrade for every catalyst and its history";
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
  const selectView = (value: string) => {
    setSelectedId(null);
    if (!isCatalystKind(value)) { setTab(catalystTab(value)); return; }
    setTab("calendar");
    setKind(value);
    // A type of another kind would empty the view picked.
    if (query.type && catalystKindOf(query.type) !== value) setFilters((old) => ({ ...old, type: "" }));
  };
  const viewTabs = kinds ? [...CATALYST_KINDS.map(({ value, label }) => ({ value, label })), CATALYST_TABS[1]]
    : CATALYST_TABS.map((item) => item.value === "calendar" ? { ...item, label: "Dockets" } : item);
  const { strip, rows: tabRows } = usePaneTabs(!openId ? { tabs: viewTabs, activeValue: tab === "changes" || !kinds ? tab : kind ?? "", onSelect: selectView, focused, dense: true } : null);
  const selectedSymbol = selected ? catalystSymbol(selected) : symbol;
  const hints: PaneHint[] = [
    ...(!openId && selectedSymbol ? [{ id: "description", key: "d", label: "es", onPress: () => openDescription(selectedSymbol) },
      { id: "financials", key: "f", label: "a", onPress: () => createPaneFromTemplate("financial-analysis-pane", { symbol: selectedSymbol }) },
      { id: "chart", key: "g", label: "raph", onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: selectedSymbol }) },
      { id: "related", key: "t", label: litigation ? "o calendar" : "o litigation", onPress: () => createPaneFromTemplate(litigation ? "catalysts-pane" : "litigation-pane", { symbol: selectedSymbol }) }] : []),
    ...(!openId ? [{ id: "alert", key: "a", label: "lert", onPress: () => openPluginCommandWorkflow("set-event-alert") }] : []),
    ...(data?.access && data.access.lockedRows > 0 ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: openUpgrade }] : []),
  ];
  usePaneStatusFooter({ registrationId: "catalysts", enabled: !openId, loading: resource.loading || resource.loadingMore || probe.loading, error: data ? error?.message ?? page?.refreshError : null, stale: page?.stale,
    info: data?.asOf ? [{ id: "as-of", parts: [{ text: `as of ${data.asOf.slice(0, 16).replace("T", " ")} UTC`, tone: "muted" }] }] : [], hints });
  usePaneNoticeFooter({ registrationId: "catalysts:notice", focused, notices: [
    ...(page?.refreshError ? [page.refreshError] : []),
    ...(data?.coverage.sources.filter((source) => source.enabled && source.state?.lastError).map((source) => `${source.agency} records are delayed. Last successful collection: ${source.state?.lastOkAt?.slice(0, 16).replace("T", " ") ?? "not yet available"}.`) ?? []),
  ] });
  const changeFilter = (key: string, value: unknown) => { setFilters((old) => ({ ...old, [key]: value })); setSelectedId(null); };
  const typeChoices = litigation ? [] : kindView ? catalystKindTypes(kindView) : tab === "changes" ? CATALYST_TYPES : [];
  const options = (values: readonly string[]) => [{ value: "", label: "All" }, ...values.map((value) => ({ value, label: catalystLabel(catalystAgency(value)) }))];
  const queryBar = <QueryBar width={width} search={{ value: String(filters.search ?? ""), onChange: (value) => changeFilter("search", value), placeholder: "Search events or parties", focused, active: searchActive, onActiveChange: setSearchActive, debounceMs: 300 }} filters={[
    ...(["from", "to"] as const).map((key) => ({ id: key, kind: "text" as const, label: catalystLabel(key), value: String(filters[key] ?? ""), placeholder: "YYYY-MM-DD", focused, active: dateFieldActive === key, onActiveChange: (value: boolean) => setDateFieldActive(value ? key : null), onChange: (value: string) => changeFilter(key, value), width: 10, debounceMs: 400 })),
    // A kind's own types; the change feed's are every type.
    ...(typeChoices.length > 1 ? [{ id: "type", label: "Type", value: String(filters.type ?? ""), defaultValue: "", options: options(typeChoices), onChange: (value: string) => changeFilter("type", value) }] : []),
    ...(["agency", "country", "sector", "status"] as const).map((key) => ({ id: key, label: catalystLabel(key), value: String(filters[key] ?? ""), defaultValue: "", options: options(data?.facets[({ agency: "agencies", country: "countries", sector: "sectors", status: "statuses" } as const)[key]] ?? []), onChange: (value: string) => changeFilter(key, value) })),
    ...(tab === "calendar" ? [{ id: "upcoming", kind: "toggle" as const, label: "Upcoming", value: filters.upcoming === true, onChange: (value: boolean) => changeFilter("upcoming", value) },
      { id: "date", label: "Date", value: String(filters.dateField ?? "any"), options: [{ value: "any", label: "Any date" }, { value: "announced", label: "Announced" }, { value: "effective", label: "Effective" }, { value: "deadline", label: "Deadlines" }], onChange: (value: string) => changeFilter("dateField", value) }] : []),
  ]} />;
  // A company's own calendar names the others in a row, not the company again.
  const self = useMemo(() => kindView && symbol ? catalystSelf(rows, symbol) : null, [kindView, symbol, rows]);
  const hasOthers = useMemo(() => !!self && rows.some((event) => catalystWith(event, self) !== ""), [self, rows]);
  // A kind shows only what tells its rows apart, each column as wide as what it holds.
  const fold = useMemo(() => kindView ? catalystKindFold(rows, query, kindView) : null, [kindView, rows, query]);
  const widths = useMemo(() => kindView ? catalystKindWidths(rows, query, kindView, self) : undefined, [kindView, rows, query, self]);
  const columns = kindView
    ? catalystKindColumns(width, { kind: kindView, self: self ? { hasOthers } : null, fold, widths })
    : catalystColumns(width, tab === "changes", litigation, catalystBasisWidth(rows, query))
      // A docket list wholly loaded says once, not on each row, a date basis, type, agency or country its cases share.
      .map((column) => litigation && !resource.hasMore && LITIGATION_SHARED.has(column.id) ? { ...column, omitWhenSame: true } : column);
  const renderCell = (row: Row, column: (typeof columns)[number], _index: number, state: { selected: boolean }): DataTableCell => {
    if (row.kind === "locked") {
      if (!desktop && column.id === "title" && row.key === "locked:0") return { text: upgradeText, content: <UpgradeLabel text={upgradeText} onPress={openUpgrade} role="catalysts-upgrade" />, onMouseDown: openUpgrade };
      return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>{column.id === "title" ? "Additional catalyst" : "Hidden"}</Text></Blurred> } : { text: "░░░░", color: colors.textDim };
    }
    if (!isEventRow(row)) return EMPTY_TABLE_CELL;
    const event = row.item;
    const text = kindView ? catalystKindCell(event, column.id, query, kindView, self, true) : catalystCell(event, column.id, query, tab === "changes");
    if (column.id === "with") {
      if (!text) return { text: MISSING_VALUE, color: colors.textMuted };
      // A listed party reads as the Ticker column does, any others counted after it.
      const [, key, more = ""] = /^(\S+:\S+)( \+\d+)?$/.exec(text) ?? [];
      if (!key) return { text, color: colors.textBright };
      const listing = listingCell(key, colors, state.selected);
      return more ? { text, content: <Box flexDirection="row" height={1} overflow="hidden">{listing.content}<Text fg={state.selected ? colors.selectedText : colors.textDim}>{more}</Text></Box> } : listing;
    }
    if (column.id === "ticker") {
      const symbol = catalystSymbol(event);
      if (!symbol) return { text, color: colors.textMuted };
      const more = event.parties.filter((party) => party.ticker).length - 1;
      return more > 0 ? { text, color: colors.textBright } : listingCell(symbol, colors, state.selected);
    }
    if (column.id === "parties") return { text, color: text === MISSING_VALUE ? colors.textMuted : colors.textBright };
    if (column.id === "type") return { text, color: toneColor(catalystTypeTone(event.type), colors) };
    // The column has room for the flag beside a code.
    if (column.id === "country") return withCountryFlag({ text, color: colors.textDim }, text, desktop);
    if (column.id === "status") return { ...daysInTextCell(text), color: tab === "changes" ? colors.text : toneColor(catalystStatusTone(catalystShownStatus(event)), colors) };
    // A withheld date says so, quieter than a day.
    if (column.id === "date" && catalystDateWithheld(event, query.dateField)) return { text, color: colors.textMuted };
    // A date drawn day first exports as its ISO day, an observation with its UTC time.
    return { ...column.id === "date" ? daysInTextCell(text) : { text }, color: column.id === "title" || column.id === "date" || column.id === "phase" ? colors.text : colors.textDim };
  };
  if (isCloudSessionRequired(error?.message)) return <SignInWall placement="catalysts-signin" action="view catalysts" needsVerification={session.needsVerification} />;
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PageStackView focused={focused} detailOpen={!!openId} onBack={() => setOpenId("")} detailTitle={open?.title ?? "Catalyst"}
        detailContent={open ? <CatalystEventDetail key={open.id} event={open} accessKey={accessKey} snapshot={detailSnapshots[open.id]} width={width} height={Math.max(3, height - 1)} focused={focused} initialTab={detailTab} openUpgrade={openUpgrade} /> : <PaneStatusBody loading={externalOpen.loading} error={externalOpen.error} subject="catalyst event"><EmptyState title="Event unavailable." /></PaneStatusBody>}
        rootContent={<DataTableView<Row> rootWidth={width} rootHeight={Math.max(3, height - tabRows)} rootBefore={queryBar} focused={focused && !openId && !searchActive && !dateFieldActive}
          // A tab or filter change loads under the query bar, which stays.
          status={{ loading: (!data && resource.loading) || choosing, error: !data || denied ? error?.message : null, subject: litigation ? "company litigation" : "catalysts" }}
          items={items} sortColumnId={null} sortDirection="asc" columns={columns} getItemKey={rowKey}
          isNavigable={isSelectable} renderSectionHeader={(row) => row.kind === "locked" ? null : renderSectionedRowHeader(row)}
          selection={{ kind: "id", selectedId: selected?.id ?? null, getId: rowKey, onChange: (id) => { if (!id.startsWith("locked:")) setSelectedId(id); } }}
          onActivate={(row) => row.kind === "locked" ? openUpgrade() : isEventRow(row) ? setOpenId(row.item.id) : undefined}
          renderCell={renderCell}
          scrollRef={scrollRef} onBodyScrollActivity={loadMore} resetScrollKey={`${kindView ?? ""}:${JSON.stringify(query)}`} showHorizontalScrollbar selectedTextOverridesCellColor
          emptyStateTitle={catalystEmptyTitle(data, query, tab === "changes", kindView ? catalystKindNoun(kindView) : undefined)}
          bodyAfter={lockedRows && desktop ? <LockedOverlay rows={lockedRows} text={upgradeText} onPress={openUpgrade} role="catalysts-upgrade" /> : undefined} />}
      />
  </Box>;
}
