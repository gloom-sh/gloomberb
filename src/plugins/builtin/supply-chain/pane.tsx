import { publicTickerKey } from "../../../utils/exchanges";
import { getSharedRegistry } from "../../registry/shared";
import { useCallback, useMemo, useState } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { SupplyChainPayload, SupplyRow } from "../../../api-client/supply-chain";
import { ActionRow, DataTableView, EmptyState, KeyValueRow, PageStackView, PaneStatusBody, QueryBar, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, type DataTableCell, type PaneHint } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, useRendererHost, useUiCapabilities } from "../../../ui";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { Blurred, LockedOverlay, UpgradeLabel } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedSupplyChain, loadSupplyChain, SUPPLY_UNAVAILABLE, validateSupplyChain } from "./client";
import { useSupplyEvidence } from "./evidence";
import { SupplyFlow } from "./flow";
import { cellText, COLUMNS, counterpartyName, dollars, percentage, ROLE_COLORS, roleLabel, sortRows, sourceLabel, type SupplySort } from "./model";

type Item = { kind: "edge"; row: SupplyRow } | { kind: "locked"; id: string };
const itemId = (item: Item) => item.kind === "edge" ? item.row.id : item.id;
function Evidence({ row, width, height }: { row: SupplyRow; width: number; height: number }) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  return <ScrollBox width={width} height={desktop ? undefined : height} flexGrow={1} flexBasis={0} contentOptions={{ paddingX: 1 }}>
    <KeyValueRow label="Reporting company" value={row.reportingEntity.name} labelWidth={20} />
    {row.counterparty.aggregate ? <KeyValueRow label="Counterparty type" value="Aggregate concentration group" labelWidth={20} /> : null}
    <KeyValueRow label="Relationship" value={`${roleLabel(row.role)} · ${row.direction === "in" ? "inbound" : row.direction === "out" ? "outbound" : "mutual"}`} labelWidth={20} />
    <KeyValueRow label="Concentration" value={percentage(row)} detail={row.pctOfRevenue === null ? undefined : `of ${row.reportingEntity.name}`} labelWidth={20} />
    {row.pctScope ? <KeyValueRow label="Percentage scope" value={row.pctScope} labelWidth={20} /> : null}
    <KeyValueRow label="Value" value={dollars(row)} labelWidth={20} />
    <KeyValueRow label="Period" value={row.period} detail={row.fiscalYear ? `FY ${row.fiscalYear}` : undefined} labelWidth={20} />
    <KeyValueRow label="Disclosure" value={`${sourceLabel(row)} · filed ${row.filedDate ?? "--"}`} detail={`${Math.round(row.confidence * 100)}% confidence`} labelWidth={20} />
    {row.quoteMatchMode ? <KeyValueRow label="Evidence match" value={row.quoteMatchMode === "exact" ? "Exact text" : row.quoteMatchMode === "whitespace" ? "Whitespace normalized" : "Unicode and whitespace normalized"} labelWidth={20} /> : null}
    <Box paddingY={1}><Text fg={colors.textBright}>{row.quote}</Text></Box>
    <ActionRow label="Open filing" onPress={() => void host.openExternal(row.filingUrl)} />
    <Text fg={colors.textDim}>{row.filingUrl}</Text>
  </ScrollBox>;
}

export function SupplyChainPane({ width, height, focused }: PaneProps) {
  const { symbol } = usePaneTickerIdentity();
  return <SupplyView key={symbol ?? "empty"} symbol={symbol} width={width} height={height} focused={focused} />;
}
function SupplyView({ symbol, width, height, focused }: Pick<PaneProps, "width" | "height" | "focused"> & { symbol: string | null }) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const { createPaneFromTemplate } = usePluginAppActions();
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "full" : "preview"}`;
  const openUpgrade = useCloudUpgradeAction("splc");
  const [snapshotSetting] = usePaneSettingValue<SupplyChainPayload | null>("supplySnapshot", null);
  const snapshot = useMemo(() => { try { return snapshotSetting ? validateSupplyChain(snapshotSetting) : null; } catch { return null; } }, [snapshotSetting]);
  const loader = useCallback((force: boolean) => snapshot ? Promise.resolve({ payload: snapshot, stale: false, refreshError: null }) : loadSupplyChain(symbol!, accessKey, force), [symbol, accessKey, snapshot]);
  const resource = useAsyncResource(symbol ? loader : null, {
    initialData: () => symbol ? cachedSupplyChain(symbol, accessKey) : null, clearOnError: isAccessDenied,
  });
  const data = resource.data?.payload ?? null;
  const [openingTab] = usePaneSettingValue("tab", "table");
  const [savedTab, setTab] = usePluginPaneState<string>("supply:tab", openingTab);
  const [openingView] = usePaneSettingValue("view", "says");
  const [savedView, setView] = usePluginPaneState<string>("supply:view", openingView);
  const view = savedView === "names" ? "names" : "says";
  const tooSmall = width < 70 || height < 13;
  const tab = savedTab === "flow" && !tooSmall ? "flow" : "table";
  const [sort, setSort] = usePluginPaneState<SupplySort>("supply:sort", { column: "pct", direction: "desc" });
  const [selectedId, setSelected] = usePluginPaneState<string | null>(`supply:selected:${view}`, null);
  const [openId, setOpen] = usePluginPaneState<string | null>("supply:evidence", null);
  const allRows = useMemo(() => data ? [...data.says, ...data.names] : [], [data]);
  const [flowIds, setFlowIds] = useState<string[]>([]);
  const rows = useMemo(() => data ? sortRows(data[view], sort) : [], [data, view, sort]);
  const selectionRows = tab === "flow" ? allRows.filter((row) => flowIds.includes(row.id)) : rows;
  const selected = tab === "flow" && selectedId?.startsWith("more:") ? null
    : selectionRows.find((row) => row.id === selectedId) ?? (tab === "flow" ? allRows.find((row) => row.id === flowIds[0]) : rows[0]) ?? null;
  const openRow = allRows.find((row) => row.id === openId) ?? null;
  useSupplyEvidence(data, tab, view, tab === "flow" ? flowIds : rows.map((row) => row.id));
  const locked = data ? Object.values(data.counts[view]).reduce((a, b) => a + b, 0) - rows.length : 0;
  const items = useMemo<Item[]>(() => [...rows.map((row): Item => ({ kind: "edge", row })),
    ...Array.from({ length: Math.min(3, locked) }, (_, i): Item => ({ kind: "locked", id: `locked:${i}` }))], [rows, locked]);
  const { strip, rows: tabRows } = usePaneTabs(data ? { tabs: [{ value: "table", label: "Table" }, { value: "flow", label: "Flow", disabled: tooSmall }], activeValue: tab, onSelect: setTab, focused, dense: true } : null);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused });
  const navigate = (row: SupplyRow, template = "supply-chain-pane") => {
    if (row.counterparty.ticker) createPaneFromTemplate(template, { symbol: publicTickerKey(row.counterparty.ticker, row.counterparty.exchange ?? undefined) });
    else setOpen(row.id);
  };
  const evidence = () => {
    if (!selected) return;
    setOpen(selected.id);
    void host.openExternal(selected.filingUrl);
  };
  const hints: PaneHint[] = [
    ...(selected ? [{ id: "evidence", key: "e", label: "vidence", onPress: evidence }] : []),
    ...(selected?.counterparty.ticker ? [
      { id: "description", key: "d", label: "es", onPress: () => navigate(selected, "new-ticker-detail-pane") },
      { id: "financials", key: "f", label: "a", onPress: () => navigate(selected, "financial-analysis-pane") },
      { id: "chart", key: "g", label: "raph", onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: publicTickerKey(selected.counterparty.ticker!, selected.counterparty.exchange ?? undefined) }) },
      ...(getSharedRegistry()?.paneTemplates.has("buildout-pane") ? [{ id: "buildout", key: "t", label: "bo", onPress: () => createPaneFromTemplate("buildout-pane") }] : []),
    ] : []),
    ...(data?.truncated ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: openUpgrade }] : []),
  ];
  usePaneStatusFooter({ registrationId: "supply-chain", loading: resource.loading, error: data ? resource.error : null, stale: resource.data?.stale,
    info: data?.asOf ? [{ id: "as-of", parts: [{ text: `as of ${data.asOf}`, tone: "muted" as const }] }] : [], hints });
  usePaneNoticeFooter({ registrationId: "supply-chain:notices", focused, notices: [
    ...(resource.data?.refreshError ? [resource.data.refreshError] : []),
    ...(savedTab === "flow" && tooSmall ? ["Flow needs a wider pane. Showing the table."] : []),
  ] });
  const renderCell = (item: Item, column: (typeof COLUMNS)[number]): DataTableCell => {
    if (item.kind === "locked") {
      if (!desktop && column.id === "name" && item.id === "locked:0") return { text: "Upgrade to see every relationship", content: <UpgradeLabel text="Upgrade to see every relationship" onPress={openUpgrade} role="supply-upgrade" />, onMouseDown: openUpgrade };
      return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>{column.id === "name" ? "Additional relationship" : "Hidden"}</Text></Blurred> }
        : { text: "░".repeat(Math.min(8, column.width - 1)), color: colors.textDim };
    }
    return { text: cellText(item.row, column.id), color: column.id === "role" ? ROLE_COLORS[item.row.role] : column.id === "name" ? colors.textBright : colors.text };
  };
  if (!symbol) return <EmptyState title="Select a ticker." />;
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall placement="supply-chain-signin" action="view supply chain disclosures" needsVerification={session.needsVerification} />;
  const bodyHeight = Math.max(3, height - tabRows);
  const query = <QueryBar width={width} filters={[{ id: "direction", label: "Filings", inline: true, value: view,
    options: [{ value: "says", label: `${symbol} says` }, { value: "names", label: `Names ${symbol}` }], onChange: (value: string) => { setView(value); setSelected(null); setOpen(null); } }]}
    meta={view === "names" ? "% of reporting company's basis" : undefined} />;
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PaneStatusBody loading={!data && resource.loading} error={!data && resource.error !== SUPPLY_UNAVAILABLE ? resource.error : null}
      empty={!data && resource.error === SUPPLY_UNAVAILABLE} emptyTitle={SUPPLY_UNAVAILABLE} subject="supply chain disclosures">
      {data ? <PageStackView focused={focused} detailOpen={!!openRow} onBack={() => setOpen(null)} detailTitle={openRow ? counterpartyName(openRow) : undefined}
        detailContent={openRow ? <Evidence row={openRow} width={width} height={bodyHeight - 1} /> : null}
        rootContent={tab === "flow" ? <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
          <QueryBar width={width} meta={selected ? `${selected.reportingEntity.ticker ?? selected.reportingEntity.name} filing · ${percentage(selected)}${selected.pctOfRevenue !== null ? ` of ${selected.reportingEntity.ticker ?? selected.reportingEntity.name}` : ""}` : undefined} />
          <SupplyFlow rows={allRows} symbol={symbol} focusId={data.entity?.id} width={width} height={Math.max(10, bodyHeight - 1 - (data.truncated ? 1 : 0))} focused={focused && !openRow} selectedId={selectedId} onSelect={setSelected} onOpen={navigate} onVisible={setFlowIds} />
          {data.truncated ? <UpgradeLabel text="Upgrade to see every relationship" onPress={openUpgrade} role="supply-upgrade" /> : null}
        </Box> : <DataTableView<Item> columns={!desktop && locked ? COLUMNS.map((column) => column.id === "name" ? { ...column, width: Math.max(column.width, 34) } : column) : COLUMNS}
          items={items} focused={focused && !openRow} rootWidth={width} rootHeight={bodyHeight} rootBefore={query}
          selection={{ kind: "id", selectedId: selected?.id ?? null, getId: itemId, onChange: (id) => setSelected(id) }} getItemKey={itemId}
          onActivate={(item) => item.kind === "edge" ? navigate(item.row) : openUpgrade()}
          renderCell={renderCell} sortColumnId={sort.column} sortDirection={sort.direction}
          onHeaderClick={(column) => setSort((old) => ({ column, direction: old.column === column && old.direction === "desc" ? "asc" : "desc" }))}
          selectedTextOverridesCellColor showHorizontalScrollbar resetScrollKey={`${symbol}:${view}`}
          emptyStateTitle={view === "says" ? "No relationships disclosed in this company's filings yet." : "No other filings name this company yet."}
          bodyAfter={locked > 0 && desktop ? <LockedOverlay rows={Math.min(3, locked)} text="Upgrade to see every relationship" onPress={openUpgrade} role="supply-upgrade" /> : undefined} />}
      /> : null}
    </PaneStatusBody>
  </Box>;
}
