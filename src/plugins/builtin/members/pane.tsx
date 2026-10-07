import { useCallback, useMemo, useRef, useState } from "react";
import type { FundChange, FundMember } from "../../../api-client/members";
import { DataTableStackView, DataTableView, DetailScrollBody, EmptyState, KeyValueRow, PaneFooterScope, PaneStatusBody, Prose, QueryBar, StatGrid,
  isSectionedItemRow, renderSectionedRowHeader, useExternalLinkFooter, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, useQueryBarSearch,
  type DataTableCell, type DataTableColumn, type PaneFooterSegment, type SectionedRow } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneInstance, usePaneTickerIdentity, usePaneTitle, usePluginPaneState, usePluginTickerActions } from "../../../public/react";
import { priceColor } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, type ScrollBoxRenderable } from "../../../ui";
import { nextHeaderSort, type SortPreference } from "../../../utils/sort-values";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { cachedChanges, cachedFunds, cachedMembers, loadChanges, loadFunds, loadMembers } from "./client";
import { canonicalFund, changeColumns, changeLabel, COVERED, decimal, DEFAULT_SORT, isTab, memberColumns, memberRows, membersTitle, percent, TABS, type MembersTab } from "./model";

type ViewProps = Pick<PaneProps, "width" | "height" | "focused"> & { fund: string; active: boolean };
const rowKey = (row: SectionedRow<FundMember>) => row.key;

function Holdings({ fund, tab, width, height, focused, active }: ViewProps & { tab: MembersTab }) {
  const colors = useThemeColors();
  const { pinTicker } = usePluginTickerActions();
  const resource = useAsyncResource(useCallback((force: boolean) => loadMembers(fund, force), [fund]), { initialData: useCallback(() => cachedMembers(fund), [fund]) });
  const data = resource.data?.payload;
  const [sort, setSort] = usePluginPaneState<SortPreference<string>>(`sort:${fund}`, DEFAULT_SORT);
  const [selected, setSelected] = usePluginPaneState<string | null>(`member:${fund}`, null);
  const [query, setQuery] = useState("");
  const search = useQueryBarSearch();
  const movers = tab === "movers";
  const rows = useMemo(() => memberRows(data?.members ?? [], tab, query, sort), [data, tab, query, sort]);
  const columns = useMemo(() => memberColumns(width, movers), [width, movers]);
  useAutoRefresh(resource.updatedAt, () => { if (active) void resource.load(); });
  usePaneRefreshKey(() => void resource.reload(), { focused, enabled: active && !search.active });
  const info = useMemo<PaneFooterSegment[]>(() => data ? [{ id: "holdings-date", parts: [{ text: `holdings ${data.asOf}`, tone: "muted" }] },
    { id: "coverage", parts: [{ text: `${data.quotesUnavailable ? "returns unavailable" : "15m delayed"} · 1D ${data.aggregate.fresh1D}/${data.aggregate.total}`, tone: data.aggregate.fresh1D < data.aggregate.total ? "warning" : "muted" }] }] : [], [data]);
  usePaneStatusFooter({ registrationId: "members:status", loading: !!data && resource.loading,
    stale: !!data && (data.stale || resource.data!.stale || !!resource.error), info });
  usePaneNoticeFooter({ registrationId: "members:notices", focused, notices: [
    ...(resource.error || resource.data?.refreshError ? [resource.error ?? resource.data!.refreshError!] : []),
    ...(data?.quotesUnavailable ? ["Member returns and current prices are unavailable. Dated holdings remain available."] : []),
    ...(data && data.aggregate.fresh1D < data.aggregate.total ? [`Fresh 1D returns cover ${data.aggregate.fresh1D} of ${data.aggregate.total} holdings. Missing returns are excluded from contributions.`] : []),
    ...(movers && data?.aggregate.withinTolerance === false ? [`The covered contribution sum differs from the fund by ${percent(data.aggregate.residual, " pp")}.`] : []),
    ...(data?.excludedDerivatives ? [`${data.excludedDerivatives} derivative positions are excluded from these share holdings.`] : []),
  ] });
  const renderCell = useCallback((item: SectionedRow<FundMember>, column: DataTableColumn): DataTableCell => {
    if (!isSectionedItemRow(item)) return { text: "" };
    const row = item.item;
    if (column.id === "symbol") return { text: row.symbol ?? "--", color: colors.textBright };
    if (column.id === "name" || column.id === "sector") return { text: row[column.id] ?? "--", color: colors.text };
    if (column.id === "weight") return { text: row.weight == null ? "--" : decimal(row.weight * 100), value: row.weight == null ? null : row.weight * 100 };
    if (column.id === "shares") return { text: decimal(row.shares, 0), value: row.shares };
    if (column.id === "price") return { text: decimal(row.price), value: row.price };
    const value = row[column.id as "changePercent"];
    return { text: percent(value, column.id === "contribution" ? "" : "%"), value, color: value === null ? colors.textMuted : priceColor(value, colors) };
  }, [colors]);
  return <PaneStatusBody subject="fund holdings" loading={!data && resource.loading} error={!data ? resource.error : null}>
    {data && <DataTableView<SectionedRow<FundMember>> items={rows} columns={columns} rootWidth={width} rootHeight={height} focused={focused && !search.active}
      rootBefore={<Box flexDirection="column"><QueryBar width={width} search={{ value: query, onChange: setQuery, placeholder: "ticker, name or sector", focused, ...search.searchProps }} />
        {movers && <StatGrid width={width} items={[
          { label: "Covered move", value: percent(data.aggregate.sum, " pp"), color: priceColor(data.aggregate.sum ?? 0, colors) },
          { label: `${fund} 1D`, value: percent(data.aggregate.fundReturn), color: priceColor(data.aggregate.fundReturn ?? 0, colors) },
          { label: "Difference", value: percent(data.aggregate.residual, " pp"), tone: data.aggregate.withinTolerance === false ? "warning" : "muted" },
        ]} />}</Box>}
      selection={{ kind: "id", selectedId: selected, getId: rowKey, onChange: (id) => setSelected(String(id)) }} getItemKey={rowKey}
      isNavigable={isSectionedItemRow} renderSectionHeader={renderSectionedRowHeader}
      sortColumnId={movers ? null : sort.columnId} sortDirection={sort.direction}
      onHeaderClick={movers ? undefined : (id) => setSort((previous) => nextHeaderSort(previous, id, { firstDirection: (key) => ["symbol", "name", "sector"].includes(key) ? "asc" : "desc", resetTo: DEFAULT_SORT }))}
      onSortChange={movers ? undefined : (columnId, direction) => setSort({ columnId, direction })}
      onRootKeyDown={(event, context) => { if (context.selectedIndex <= 0 && isPlainArrowUp(event)) { stopSearchFocusNavigation(event); search.focus(); return true; } return false; }}
      onActivate={(row) => { if (isSectionedItemRow(row) && row.item.symbol) pinTicker(row.item.symbol, { floating: true, instrument: null }); }}
      renderCell={renderCell} selectedTextOverridesCellColor resetScrollKey={`${tab}:${query}`} emptyStateTitle={query ? "No matching holdings." : movers ? "No covered movers." : "No holdings."} />}
  </PaneStatusBody>;
}

function Changes({ fund, width, height, focused, active }: ViewProps) {
  const colors = useThemeColors();
  const resource = useAsyncResource(useCallback((force: boolean) => loadChanges(fund, force), [fund]), { initialData: useCallback(() => cachedChanges(fund), [fund]) });
  const data = resource.data?.payload;
  const [selected, setSelected] = usePluginPaneState<string | null>(`change:${fund}`, null);
  const [opened, setOpened] = usePluginPaneState<string | null>(`opened:${fund}`, null);
  const detail = data?.changes.find((row) => row.id === opened);
  const selectedRow = detail ?? data?.changes.find((row) => row.id === selected) ?? data?.changes[0];
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  useAutoRefresh(resource.updatedAt, () => { if (active) void resource.load(); });
  usePaneRefreshKey(() => void resource.reload(), { focused, enabled: active });
  useExternalLinkFooter({ registrationId: "members:source", focused, url: selectedRow?.url });
  usePaneStatusFooter({ registrationId: "members:changes", loading: !!data && resource.loading, stale: !!data && (data.stale || resource.data!.stale || !!resource.error),
    info: data?.asOf ? [{ id: "updated", parts: [{ text: `as of ${data.asOf.slice(0, 10)}`, tone: "muted" }] }] : [] });
  usePaneNoticeFooter({ registrationId: "members:changes-notices", focused, notices: resource.error || resource.data?.refreshError ? [resource.error ?? resource.data!.refreshError!] : [] });
  const renderCell = useCallback((row: FundChange, column: DataTableColumn): DataTableCell => {
    if (column.id === "effectiveDate") return { text: row.effectiveDate ?? "--" };
    if (column.id === "daysToGo") return { text: row.daysToGo === null ? "--" : String(row.daysToGo), value: row.daysToGo, color: row.daysToGo === null ? colors.textMuted : colors.warning };
    if (column.id === "added") return { text: row.added ?? "--", color: colors.positive };
    if (column.id === "removed") return { text: row.removed ?? "--", color: colors.negative };
    if (column.id === "estimate") { const value = row.estimates.length === 1 ? row.estimates[0]!.days : null; return { text: percent(value, ""), value }; }
    return { text: row.reason, color: colors.text };
  }, [colors]);
  return <PaneStatusBody subject="index changes" loading={!data && resource.loading} error={!data ? resource.error : null}>
    {data && !data.available ? <EmptyState title="Index changes are not covered for this fund." /> : data && <DataTableStackView<FundChange>
      rootWidth={width} rootHeight={height} focused={focused} columns={changeColumns(width)} items={data.changes}
      getItemKey={(row) => row.id} selection={{ kind: "id", selectedId: selected, getId: (row) => row.id, onChange: (id) => setSelected(String(id)) }}
      onActivate={(row) => setOpened(row.id)} sortColumnId={null} sortDirection="desc" renderCell={renderCell} selectedTextOverridesCellColor
      detailOpen={!!detail} onBack={() => setOpened(null)} detailTitle={detail ? changeLabel(detail) : undefined} detailScrollRef={scrollRef}
      detailContent={detail && <DetailScrollBody ref={scrollRef} resetScrollKey={detail.id}>
        <KeyValueRow label="Effective" value={detail.effectiveDate ?? "Not confirmed"} />
        {detail.announcedAt && <KeyValueRow label="Announced" value={detail.announcedAt.slice(0, 10)} />}
        {detail.headline && detail.added && <KeyValueRow label="Added" value={detail.added} />}{detail.headline && detail.removed && <KeyValueRow label="Removed" value={detail.removed} />}
        {detail.reason !== detail.headline && <Prose text={detail.reason} width={Math.max(8, width - 4)} />}
        {detail.estimates.map((estimate) => <KeyValueRow key={estimate.symbol} label={`${estimate.symbol} est. ADV days`} labelWidth={24} value={percent(estimate.days, "")} />)}
        {!!detail.estimates.length && <KeyValueRow label="Holdings as of" labelWidth={24} value={detail.estimates[0]!.asOf} />}
        {!!detail.estimates.length && <Prose text={data.estimateLabel} width={Math.max(8, width - 4)} />}
        {detail.kind === "history" && data.attribution && <Prose text={data.attribution.text} width={Math.max(8, width - 4)} />}
      </DetailScrollBody>} emptyStateTitle="No stored index changes." />}
  </PaneStatusBody>;
}

function FundView({ fund, ...props }: Pick<PaneProps, "width" | "height" | "focused"> & { fund: string }) {
  const instance = usePaneInstance();
  const initial = isTab(instance?.settings?.tab) ? instance.settings.tab : "members";
  const [storedTab, setTab] = usePluginPaneState<MembersTab>("tab", initial);
  const tab = isTab(storedTab) ? storedTab : "members";
  const [visited, setVisited] = useState({ holdings: tab !== "changes", changes: tab === "changes" });
  const selectTab = (value: string) => { if (isTab(value)) { setTab(value); setVisited((previous) => ({ holdings: previous.holdings || value !== "changes", changes: previous.changes || value === "changes" })); } };
  const { strip, rows } = usePaneTabs({ tabs: TABS, activeValue: tab, onSelect: selectTab, focused: props.focused, compact: true, variant: "bare" });
  const height = Math.max(1, props.height - rows);
  return <Box width={props.width} height={props.height} flexDirection="column">
    {strip}
    {visited.holdings && <Box visible={tab !== "changes"} flexGrow={1} flexBasis={0} overflow="hidden"><PaneFooterScope active={tab !== "changes"}>
      <Holdings fund={fund} {...props} height={height} tab={tab} active={tab !== "changes"} focused={props.focused && tab !== "changes"} />
    </PaneFooterScope></Box>}
    {visited.changes && <Box visible={tab === "changes"} flexGrow={1} flexBasis={0} overflow="hidden"><PaneFooterScope active={tab === "changes"}>
      <Changes fund={fund} {...props} height={height} active={tab === "changes"} focused={props.focused && tab === "changes"} />
    </PaneFooterScope></Box>}
  </Box>;
}
function FundPicker({ width, height, focused, choose }: Pick<PaneProps, "width" | "height" | "focused"> & { choose: (fund: string) => void }) {
  const resource = useAsyncResource(loadFunds, { initialData: cachedFunds });
  const [selected, setSelected] = useState<string | null>(null);
  usePaneRefreshKey(() => void resource.reload(), { focused });
  usePaneStatusFooter({ registrationId: "members:picker", loading: resource.loading && !!resource.data, stale: resource.data?.stale });
  return <PaneStatusBody subject="covered funds" loading={!resource.data && resource.loading} error={!resource.data ? resource.error : null}>
    {resource.data && <DataTableView items={resource.data.payload.funds} emptyStateTitle="No covered funds." rootWidth={width} rootHeight={height} focused={focused}
      columns={[{ id: "ticker", label: "Fund", align: "left", width: 8 }, { id: "name", label: "Index", align: "left", width: 24, flexGrow: 1 }, { id: "asOf", label: "Holdings as of", align: "left", width: 16 }]}
      getItemKey={(row) => row.ticker} selection={{ kind: "id", selectedId: selected, getId: (row) => row.ticker, onChange: (id) => setSelected(String(id)) }}
      onActivate={(row) => choose(row.ticker)} sortColumnId={null} sortDirection="asc" renderCell={(row, col) => ({ text: String(row[col.id as "ticker"] ?? "--") })} />}
  </PaneStatusBody>;
}
export function MembersPane(props: PaneProps) {
  const { symbol } = usePaneTickerIdentity();
  const [chosen, choose] = usePluginPaneState("fund", "");
  const fund = canonicalFund(symbol ?? chosen);
  const definition = COVERED.find((item) => item.ticker === fund);
  usePaneTitle(membersTitle(symbol ?? chosen));
  if (!fund) return <FundPicker {...props} choose={choose} />;
  if (!definition) return <EmptyState title="This index or fund is not covered." hint="IVV, IJH, IJR, IWM and IWB are covered. Nasdaq-100 (NDX/QQQ) is not covered." />;
  return <FundView key={fund} fund={fund} {...props} />;
}
