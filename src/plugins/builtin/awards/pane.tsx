import { useCallback, useMemo, useRef } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { AwardAggregate, AwardCompanyLeader, AwardFilter, AwardRow, AwardType, AwardsPayload } from "../../../api-client/awards";
import { Badge, ChartTableHeader, DataTableView, PageStackView, PaneStatusBody, QueryBar, useChartTableSelection, usePagedRows,
  usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, useQueryBarSearch, useTableLoadMore, type DataTableColumn, type PaneHint, type QueryBarFilter } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { formatCompactAxis } from "../../../components/chart-table";
import { missingCell, shareCell } from "../shared/research-cells";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { publicTickerKey } from "../../../utils/exchanges";
import { truncateToDisplayWidth } from "../../../utils/format";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { Blurred, LockedOverlay, UpgradeLabel } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { AwardDetail } from "./detail";
import { useAwardAlerts } from "./alerts";
import { AWARDS_UNAVAILABLE, fetchAwards, loadAward, loadAwards, validateAwards } from "./client";
import { useAwardsEvidence } from "./evidence";
import { AWARD_TABS, aggregateId, awardHistorySeries, awardPercent, awardPeriod, awardScope, awardTab, awardTypeLabel, money, rankedAggregates } from "./model";

type Item = { kind: "award"; row: AwardRow } | { kind: "aggregate"; row: AwardAggregate } | { kind: "leader"; row: AwardCompanyLeader } | { kind: "locked"; id: string }
  | { kind: "section"; id: string; label: string; count: number };
const itemId = (item: Item) => item.kind === "locked" || item.kind === "section" ? item.id : item.kind === "award" ? item.row.id : item.kind === "leader" ? `${aggregateId(item.row)}:${item.row.sector}` : aggregateId(item.row);
const isRowItem = (item: Item) => item.kind !== "section";
/** Shares only compare inside one scope and currency, so each pair is its own section. */
function groupedAggregates<T extends AwardAggregate>(rows: readonly T[], toItem: (row: T) => Item): Item[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(`${awardScope(row.source)} · ${row.currency}`, [...(groups.get(`${awardScope(row.source)} · ${row.currency}`) ?? []), row]);
  return [...groups].flatMap(([label, members]) => [{ kind: "section" as const, id: `section:${label}`, label, count: members.length }, ...members.map(toItem)]);
}
const rowId = (row: AwardRow) => row.id;
const rowDate = (row: AwardRow) => new Date(`${row.awardDate}T00:00:00Z`);
const FEED_COLUMNS: DataTableColumn[] = [
  { id: "date", label: "Date", width: 11, align: "left" }, { id: "recipient", label: "Awardee", width: 28, flexGrow: 1, align: "left" },
  { id: "ticker", label: "Ticker", width: 10, align: "left" }, { id: "currency", label: "CCY", width: 5, align: "left" },
  { id: "value", label: "Value", width: 11, align: "right" }, { id: "obligated", label: "Obligated", width: 11, align: "right" },
  { id: "ceiling", label: "Ceiling", width: 11, align: "right" }, { id: "agency", label: "Agency", width: 28, align: "left" },
  { id: "country", label: "Country", width: 8, align: "left" }, { id: "period", label: "Performance period", width: 24, align: "left" },
  { id: "title", label: "Contract", width: 46, align: "left" },
  { id: "dateBasis", label: "Date basis", width: 14, align: "left" },
];
const EVENT_COLUMNS: DataTableColumn[] = [FEED_COLUMNS[0]!, FEED_COLUMNS[1]!, FEED_COLUMNS[2]!,
  { id: "ratio", label: "% revenue", width: 11, align: "right" }, FEED_COLUMNS[3]!, { ...FEED_COLUMNS[4]!, label: "Compared value" },
  { id: "revenue", label: "Annual revenue", width: 14, align: "right" }, { id: "basis", label: "Value basis", width: 13, align: "left" },
  { id: "revenuePeriod", label: "Revenue FY end", width: 15, align: "left" }, FEED_COLUMNS[7]!, FEED_COLUMNS[10]!];
// The share leads the figures: concentration is what these views are for.
const AGG_COLUMNS: DataTableColumn[] = [
  { id: "label", label: "Agency", width: 30, flexGrow: 1, align: "left" }, { id: "currency", label: "CCY", width: 5, align: "left" },
  { id: "share", label: "Share %", width: 24, align: "right" }, { id: "obligated", label: "Obligated", width: 12, align: "right" }, { id: "value", label: "Value", width: 12, align: "right" },
  { id: "ceiling", label: "Ceiling", width: 12, align: "right" },
  { id: "contracts", label: "Awards", width: 8, align: "right" },
  { id: "scope", label: "Scope", width: 27, align: "left" },
];
const LEADER_COLUMNS: DataTableColumn[] = [{ id: "label", label: "Company", width: 28, flexGrow: 1, align: "left" }, { ...FEED_COLUMNS[2]!, width: 8 },
  FEED_COLUMNS[3]!, AGG_COLUMNS[2]!, FEED_COLUMNS[4]!, FEED_COLUMNS[5]!, AGG_COLUMNS[6]!,
  { id: "sector", label: "Sector", width: 25, align: "left" }, AGG_COLUMNS[5]!, AGG_COLUMNS[7]!];

export function AwardsPane(props: PaneProps) {
  const { symbol } = usePaneTickerIdentity();
  return <AwardsView key={symbol ?? "global"} {...props} symbol={symbol} />;
}
function AwardsView({ width, height, focused, symbol }: PaneProps & { symbol: string | null }) {
  const colors = useThemeColors(), host = useRendererHost();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const session = useResearchCloudSession(), access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "full" : "preview"}`;
  const openUpgrade = useCloudUpgradeAction("awards");
  const { createPaneFromTemplate } = usePluginAppActions();
  const [initialTab] = usePaneSettingValue("tab", symbol ? "company" : "feed");
  const [savedTab, setTab] = usePluginPaneState<string>("awards:tab", initialTab);
  const tab = awardTab(savedTab);
  const [initialView] = usePaneSettingValue("leaderView", "companies");
  const [leaderView, setLeaderView] = usePluginPaneState("awards:leaders", initialView);
  const [ticker, setTicker] = usePluginPaneState("awards:ticker", symbol ?? "");
  const [initialQuery] = usePaneSettingValue("query", "");
  const [query, setQuery] = usePluginPaneState("awards:query", initialQuery);
  const [initialCountry] = usePaneSettingValue("jurisdiction", "");
  const [jurisdiction, setJurisdiction] = usePluginPaneState("awards:jurisdiction", initialCountry);
  const [initialCurrency] = usePaneSettingValue("currency", "");
  const [currency, setCurrency] = usePluginPaneState("awards:currency", initialCurrency);
  const [initialSource] = usePaneSettingValue("source", "");
  const [source, setSource] = usePluginPaneState("awards:source", initialSource);
  const [initialType] = usePaneSettingValue<AwardType>("awardType", "prime");
  const [awardType, setType] = usePluginPaneState<AwardType>("awards:type", initialType);
  const [initialAgency] = usePaneSettingValue("agency", "");
  const [agency, setAgency] = usePluginPaneState("awards:agency", initialAgency);
  const [initialSector] = usePaneSettingValue("sector", "");
  const [sector, setSector] = usePluginPaneState("awards:sector", initialSector);
  const [initialParent] = usePaneSettingValue("parentId", "");
  const [parentId, setParentId] = usePluginPaneState("awards:parentId", initialParent);
  const [from] = usePaneSettingValue("from", ""), [to] = usePaneSettingValue("to", "");
  const [range, setRange] = usePluginPaneState("awards:range", "all");
  const [initialAward] = usePaneSettingValue("award", "");
  const [openId, setOpen] = usePluginPaneState<string | null>("awards:open", initialAward || null);
  const [selectedId, setSelected] = usePluginPaneState<string | null>(`awards:selection:${tab}`, null);
  const search = useQueryBarSearch(), tickerSearch = useQueryBarSearch();
  const [snapshotSetting] = usePaneSettingValue<AwardsPayload | null>("awardsSnapshot", null);
  const snapshot = useMemo(() => { try { return snapshotSetting ? validateAwards(snapshotSetting) : null; } catch { return null; } }, [snapshotSetting]);
  const filter = useMemo<AwardFilter>(() => ({ ticker: ticker.trim().toUpperCase() || undefined, query: query.trim() || undefined,
    jurisdiction: jurisdiction || undefined, currency: currency || undefined, source: source || undefined, awardType, agency: agency || undefined, sector: sector || undefined, parentId: parentId || undefined,
    from: parentId ? undefined : range === "all" ? from || undefined : new Date(Date.now() - Number(range) * 86_400_000).toISOString().slice(0, 10), to: parentId ? undefined : to || undefined, limit: 100,
  }), [ticker, query, jurisdiction, currency, source, awardType, agency, sector, parentId, from, to, range]);
  const loader = useMemo(() => {
    const cursors = new Map<number, string>();
    return async ({ offset, force, signal }: { offset: number; force: boolean; signal: AbortSignal }) => {
      const loaded = snapshot ? { payload: snapshot, stale: false, refreshError: null } : offset === 0 ? await loadAwards(filter, accessKey, force)
        : { payload: await fetchAwards({ ...filter, cursor: cursors.get(offset) }, undefined, signal), stale: false, refreshError: null };
      const payload = loaded.payload;
      if (offset === 0) cursors.clear();
      if (payload.nextCursor) cursors.set(offset + payload.rows.length, payload.nextCursor);
      return { ...loaded, rows: payload.rows, hasMore: !snapshot && !!payload.nextCursor && !payload.locked, nextOffset: offset + payload.rows.length };
    };
  }, [filter, accessKey, snapshot]);
  const paged = usePagedRows(loader, { getId: rowId });
  const loaded = paged.pages[0], data = loaded?.payload;
  useAwardAlerts(data, JSON.stringify([filter, accessKey]), setOpen);
  const failed = paged.error ?? paged.moreError;
  const denied = failed && isAccessDenied(failed);
  useAutoRefresh(data ? Date.parse(data.generatedAt) : null, paged.reload);
  usePaneRefreshKey(paged.reload, { focused: focused && !openId });
  const detailLoader = useCallback((force: boolean) => loadAward(openId!, accessKey, force), [openId, accessKey]);
  const detail = useAsyncResource(openId ? detailLoader : null, { clearOnError: isAccessDenied });
  const openRow = detail.data?.payload.row ?? paged.rows.find((row) => row.id === openId) ?? data?.alerts.find((row) => row.id === openId) ?? null;
  const rows = tab === "events" ? data?.alerts ?? [] : paged.rows;
  const aggregates = useMemo(() => rankedAggregates(tab === "agencies" ? data?.agencies ?? [] : data?.sectors ?? [], currency, awardType), [data, tab, currency, awardType]);
  const aggregated = tab === "agencies" || tab === "sectors";
  const showLeaders = tab === "sectors" && leaderView === "companies";
  const items = useMemo<Item[]>(() => [
    ...(showLeaders ? groupedAggregates(data?.leaders ?? [], (row): Item => ({ kind: "leader", row })) : aggregated ? groupedAggregates(aggregates, (row): Item => ({ kind: "aggregate", row })) : rows.map((row): Item => ({ kind: "award", row }))),
    ...(data?.locked ? Array.from({ length: 3 }, (_, i): Item => ({ kind: "locked", id: `locked:${i}` })) : []),
  ], [showLeaders, aggregated, aggregates, rows, data?.leaders, data?.locked]);
  const selected = tab === "company" && !ticker ? null
    : items.find((item) => itemId(item) === selectedId && isRowItem(item)) ?? items.find(isRowItem) ?? null;
  const current = openRow ?? (selected?.kind === "award" ? selected.row : null);
  const selectedEntity = current?.entity ?? (selected?.kind === "leader" && selected.row.ticker ? { ticker: selected.row.ticker, exchange: selected.row.exchange } : null);
  const tableScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadMore = useTableLoadMore(tableScrollRef, !aggregated && tab !== "events" && !openId && paged.hasMore, paged.loadMore);
  const currencies = useMemo(() => [...new Set([currency, ...(data?.history.map((row) => row.currency) ?? []), ...rows.map((row) => row.currency)])].filter(Boolean).sort(), [data, rows, currency]);
  const chartCurrency = currency || currencies[0] || "USD";
  const scopes = useMemo(() => [...new Set([source, ...(data?.history.map((row) => row.source) ?? []), ...rows.map((row) => row.source)])].filter(Boolean).sort(), [data, rows, source]);
  const chartSource = source || scopes[0] || "";
  const series = useMemo(() => awardHistorySeries(data?.history ?? [], chartSource, chartCurrency, awardType, [colors.textBright, colors.warning]), [data, chartSource, chartCurrency, awardType, colors.textBright, colors.warning]);
  const chartSelection = useChartTableSelection({ rows, getId: rowId, getDate: rowDate,
    selectedId: selected?.kind === "award" ? selected.row.id : null, onSelect: setSelected, focused: focused && !openId && !search.active && !tickerSearch.active, enabled: tab === "company" });
  const navigate = (template: string) => {
    if (!selectedEntity) return;
    const target = publicTickerKey(selectedEntity.ticker, selectedEntity.exchange ?? undefined);
    createPaneFromTemplate(template, template === "chart-composer-pane" ? { arg: target } : { symbol: target });
  };
  const hints: PaneHint[] = [
    ...(current ? [{ id: "source", key: "o", label: "pen source", onPress: () => void host.openExternal(current.sourceUrl) }] : []),
    ...(current && !openId ? [{ id: "evidence", key: "e", label: "vidence", onPress: () => setOpen(current.id) }] : []),
    ...(selectedEntity ? [
      { id: "description", key: "d", label: "es", onPress: () => navigate("new-ticker-detail-pane") },
      { id: "financials", key: "f", label: "a", onPress: () => navigate("financial-analysis-pane") },
      { id: "graph", key: "g", label: "raph", onPress: () => navigate("chart-composer-pane") },
      { id: "supply", key: "s", label: "plc", onPress: () => navigate("supply-chain-pane") },
      { id: "calendar", key: "c", label: "alendar", onPress: () => navigate("earnings-calendar-pane") },
    ] : []),
    ...(data?.locked ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: openUpgrade }] : []),
  ];
  usePaneStatusFooter({ registrationId: "awards", loading: paged.loading || paged.loadingMore,
    error: data && !denied ? failed?.message ?? null : null, stale: loaded?.stale,
    info: data?.asOf ? [{ id: "asof", parts: [{ text: `as of ${data.asOf.slice(0, 10)}`, tone: "muted" }] }] : [], hints });
  usePaneNoticeFooter({ registrationId: "awards:notices", focused, notices: [
    ...(data?.status === "partial" ? ["Procurement coverage is incomplete for the selected scope."] : []),
    ...(loaded?.refreshError ? [loaded.refreshError] : []),
    ...(data?.truncated && Object.values(data.truncated).some(Boolean) ? ["Some aggregate history exceeds this response's limit. Narrow the date range or scope."] : []),
    ...(tab === "company" && currencies.length > 1 && !currency ? [`Chart in ${chartCurrency}; select a currency to inspect other obligations.`] : []),
    ...(tab === "company" && scopes.length > 1 && !source ? [`Chart covers ${awardScope(chartSource).toLowerCase()}; select a scope to inspect other contracts.`] : []),
  ] });
  const { strip, rows: tabRows } = usePaneTabs(!denied ? { tabs: [...AWARD_TABS], activeValue: tab, onSelect: (value) => { setTab(value); setOpen(null); }, focused, dense: true } : null);
  const bodyHeight = Math.max(3, height - tabRows);
  const filters: QueryBarFilter[] = [
    { id: "ticker", kind: "text", label: "Ticker", value: ticker, placeholder: "Company", focused, ...tickerSearch.searchProps, onChange: (value) => { setTicker(value.toUpperCase()); setOpen(null); }, width: 10 },
    { id: "country", label: "Country", value: jurisdiction, defaultValue: "", options: [{ value: "", label: "All countries" }, ...[...new Set(["US", "GB", "EU", "CA", "AU", "NZ", "FR", "DE", "ES", "IT", "PL", jurisdiction, ...rows.map((row) => row.jurisdiction)])].filter(Boolean).sort().map((value) => ({ value, label: value }))], onChange: setJurisdiction },
    { id: "currency", label: "CCY", value: currency, defaultValue: "", options: [{ value: "", label: "All currencies" }, ...[...new Set(["USD", "EUR", "GBP", "CAD", "AUD", "NZD", ...currencies])].sort().map((value) => ({ value, label: value }))], onChange: setCurrency },
    { id: "scope", label: "Scope", value: source, defaultValue: "", options: [{ value: "", label: "All scopes" }, ...scopes.map((value) => ({ value, label: awardScope(value) }))], onChange: setSource },
    { id: "type", label: "Type", value: awardType, options: (["prime", "subaward", "notice", "modification"] as const).map((value) => ({ value, label: awardTypeLabel(value) })), onChange: setType },
    { id: "range", label: "Range", value: range, defaultValue: "all", options: [{ value: "all", label: from || to ? `${from || "Start"} / ${to || "Now"}` : "All history" }, { value: "30", label: "30D" }, { value: "365", label: "1Y" }, { value: "1096", label: "3Y" }], onChange: setRange },
    ...(agency ? [{ id: "agency", label: "Agency", value: agency, defaultValue: "", options: [{ value: "", label: "All agencies" }, { value: agency, label: agency }], onChange: setAgency }] : []),
    ...(sector ? [{ id: "sector", label: "Sector", value: sector, defaultValue: "", options: [{ value: "", label: "All sectors" }, { value: sector, label: sector }], onChange: setSector }] : []),
    ...(parentId ? [{ id: "parent", label: "Parent contract", value: parentId, defaultValue: "", options: [{ value: "", label: "All contracts" }, { value: parentId, label: "Selected contract" }], onChange: setParentId }] : []),
  ];
  const queryBar = <QueryBar width={width} search={{ value: query, onChange: setQuery, placeholder: "Search contracts", focused, ...search.searchProps }} filters={filters}
    view={tab === "sectors" ? { value: leaderView, options: [{ value: "companies", label: "Companies" }, { value: "sectors", label: "Sectors" }], onChange: setLeaderView } : undefined} />;
  const columns = showLeaders ? LEADER_COLUMNS.filter((column) => column.id !== "scope" && column.id !== "currency")
    : aggregated ? AGG_COLUMNS.filter((column) => column.id !== "scope" && column.id !== "currency").map((column) => column.id === "label" ? { ...column, label: tab === "agencies" ? "Agency" : "Sector" } : column)
    : tab === "events" ? EVENT_COLUMNS : FEED_COLUMNS;
  const maxShare = Math.max(0, ...items.map((item) => item.kind === "aggregate" || item.kind === "leader" ? item.row.sharePercent ?? 0 : 0));
  const latest = data?.history.filter((row) => row.source === chartSource && row.currency === chartCurrency && row.awardType === awardType).at(-1);
  const chart = tab === "company" && ticker ? { series, formatValue: (value: number) => `${chartCurrency} ${money(value)}`, formatAxisValue: formatCompactAxis, ...chartSelection,
    remoteKind: "award-obligations", empty: series.length ? undefined : data?.locked ? "Full award history requires Pro." : "History is accumulating for this company." } : null;
  useAwardsEvidence(data, tab, tab === "company" && !ticker ? 0 : items.filter((item) => item.kind !== "locked").length);
  if (denied || !data && isCloudSessionRequired(failed?.message)) return <SignInWall placement="awards-signin" action="view government awards" needsVerification={session.needsVerification} />;
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PaneStatusBody loading={paged.loading && !data} error={!data && failed?.message !== AWARDS_UNAVAILABLE ? failed?.message : null}
      empty={!data && failed?.message === AWARDS_UNAVAILABLE} emptyTitle={AWARDS_UNAVAILABLE} subject="government awards">
      {data ? <PageStackView focused={focused} detailOpen={!!openId} onBack={() => setOpen(null)} detailTitle={openRow ? truncateToDisplayWidth(openRow.title, Math.max(20, width - 16)) : "Award evidence"}
        detailContent={openRow ? <AwardDetail key={openRow.id} row={openRow} accessKey={accessKey} width={width} height={bodyHeight - 1} focused={focused} openAward={setOpen} openUpgrade={openUpgrade}
          openChildren={(type) => { setParentId(openRow.id); setTicker(""); setSource(""); setQuery(""); setAgency(""); setSector(""); setCurrency(""); setJurisdiction(""); setRange("all"); setType(type); setOpen(null); setTab("feed"); }} />
          : <PaneStatusBody loading={detail.loading} error={detail.error} empty={!detail.loading && !detail.error} emptyTitle="Award no longer available." subject="award evidence" />}
        rootContent={<DataTableView<Item> columns={columns} items={tab === "company" && !ticker ? [] : items} rootWidth={width} rootHeight={bodyHeight}
          focused={focused && !openId && !search.active && !tickerSearch.active} scrollRef={tableScrollRef} onBodyScrollActivity={loadMore}
          rootBefore={<ChartTableHeader width={width} height={bodyHeight} tableRows={items.length} tableColumns={columns} query={queryBar} chart={chart}
            figures={tab === "company" && ticker && latest ? [{ id: "total", label: `Obligated ${chartCurrency}`, value: money(latest.cumulativeObligatedAmount) },
              { id: "period", label: "Latest cohort", value: latest.month.slice(0, 7), detail: awardScope(chartSource) }] : undefined} />}
          selection={{ kind: "id", selectedId: selected ? itemId(selected) : null, getId: itemId, onChange: setSelected }} getItemKey={itemId}
          isNavigable={isRowItem} renderSectionHeader={(item) => item.kind === "section" ? { text: `${item.label} (${item.count})` } : null}
          onActivate={(item) => { if (item.kind === "section") return; if (item.kind === "locked") openUpgrade(); else if (item.kind === "award") setOpen(item.row.id);
            else if (item.kind === "leader") { setCurrency(item.row.currency); setSource(item.row.source); setSector(item.row.sector);
              if (item.row.ticker) { setTicker(publicTickerKey(item.row.ticker, item.row.exchange ?? undefined)); setTab("company"); } else { setQuery(item.row.label); setTab("feed"); } }
            else { setCurrency(item.row.currency); setSource(item.row.source);
              if (tab === "agencies") { setAgency(item.row.key); setTab("feed"); } else { setSector(item.row.key); setLeaderView("companies"); } } }}
          sortColumnId={null} sortDirection="desc" selectedTextOverridesCellColor showHorizontalScrollbar resetScrollKey={JSON.stringify([tab, filter])}
          renderCell={(item, column, _index, state) => {
            if (item.kind === "section") return { text: "" };
            if (item.kind === "locked") {
              if (!desktop && ["recipient", "label"].includes(column.id) && item.id === "locked:0") return { text: "Upgrade for full awards", content: <UpgradeLabel text="Upgrade for full awards" onPress={openUpgrade} />, onMouseDown: openUpgrade };
              return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>{["recipient", "label"].includes(column.id) ? "Additional award" : "Hidden"}</Text></Blurred> }
                : { text: "░".repeat(Math.min(7, column.width - 1)), color: colors.textDim };
            }
            const row = item.row;
            if (column.id === "currency") return { text: row.currency, color: colors.textDim };
            if (["value", "obligated", "ceiling"].includes(column.id)) {
              const value = column.id === "value" ? tab === "events" && item.kind === "award" ? item.row.revenueComparison?.awardAmount : row.awardAmount : column.id === "obligated" ? row.obligatedAmount : row.ceilingAmount;
              return value == null ? missingCell(colors) : { text: money(value), value, color: column.id === "obligated" || column.id === "value" ? colors.textBright : colors.text };
            }
            if (item.kind === "aggregate" || item.kind === "leader") {
              if (column.id === "label") return { text: item.row.label, color: colors.textBright };
              if (column.id === "ticker" && item.kind === "leader") return item.row.ticker ? { text: item.row.ticker, content: <Badge label={item.row.ticker} /> } : missingCell(colors);
              if (column.id === "sector" && item.kind === "leader") return { text: item.row.sector, color: colors.textDim };
              if (column.id === "contracts") return { text: item.row.count.toLocaleString("en-US"), value: item.row.count, color: colors.textDim };
              if (column.id === "scope") return { text: awardScope(item.row.source), color: colors.textDim };
              return item.row.sharePercent === null ? missingCell(colors)
                : { ...shareCell(`${item.row.sharePercent.toFixed(1)}%`, maxShare ? item.row.sharePercent / maxShare : null, column.width, colors, state.selected), value: item.row.sharePercent };
            }
            const award = item.row;
            if (column.id === "date") return { text: award.awardDate, value: award.awardDate };
            if (column.id === "dateBasis") return { text: award.dateBasis === "period-start" ? "Period start" : award.dateBasis === "publication" ? "Publication" : "Award date", color: colors.textDim };
            if (column.id === "recipient") return { text: award.recipient.name, color: colors.textBright };
            if (column.id === "ticker") return award.entity ? { text: award.entity.ticker, content: <Badge label={award.entity.ticker} /> } : missingCell(colors);
            if (column.id === "agency") return { text: award.agency.name, color: colors.text };
            if (column.id === "country") return { text: award.jurisdiction, color: colors.textDim };
            if (column.id === "period") return { text: awardPeriod(award), color: colors.textDim };
            if (column.id === "title") return { text: award.title, color: colors.textDim };
            if (column.id === "ratio") return { text: awardPercent(award), value: award.revenueComparison?.percent ?? null, color: colors.warning, attributes: TextAttributes.BOLD, keepColorWhenSelected: true };
            if (column.id === "revenue") return { text: money(award.revenueComparison?.annualRevenue), value: award.revenueComparison?.annualRevenue ?? null };
            if (column.id === "basis") return { text: award.revenueComparison?.basis === "obligated" ? "Obligated" : "Award value", color: colors.textDim };
            return { text: award.revenueComparison?.periodEnd ?? "--", color: colors.textDim };
          }}
          emptyStateTitle={tab === "company" && !ticker ? "Enter a company ticker." : tab === "events" ? "No revenue-comparable awards in this scope." : "No awards match these filters."}
          bodyAfter={data.locked && desktop ? <LockedOverlay rows={3} text="Upgrade for complete awards and history" onPress={openUpgrade} /> : undefined} />} /> : null}
    </PaneStatusBody>
  </Box>;
}
