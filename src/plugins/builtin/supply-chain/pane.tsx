import { publicTickerKey } from "../../../utils/exchanges";
import { getSharedRegistry } from "../../registry/shared";
import { useCallback, useMemo, useState } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { SupplyChainPayload, SupplyRole, SupplyRow } from "../../../api-client/supply-chain";
import {
  Badge, DataTableView, EmptyState, ExternalLink, KeyValueRow, PageStackView, PaneStatusBody, QueryBar, StatGrid, statGridRows, usePaneNoticeFooter,
  usePaneStatusFooter, usePaneTabs, type DataTableCell, type DataTableColumn, type PaneHint, type StatItem,
} from "../../../components";
import { RatioBar } from "../../../components/ui/ratio-bar";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { blendHex } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, TextAttributes, useRendererHost, useUiCapabilities } from "../../../ui";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { Blurred, LockedOverlay, UpgradeLabel } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedSupplyChain, loadSupplyChain, SUPPLY_UNAVAILABLE, validateSupplyChain } from "./client";
import { useSupplyEvidence } from "./evidence";
import { SupplyFlow } from "./flow";
import {
  cellText, counterpartyKind, counterpartyKindLabel, counterpartyLabel, counterpartyName, dollars, percentage, ROLE_COLORS, roleLabel,
  shareParts, sortRows, sourceLabel, type SupplySort,
} from "./model";

type Item = { kind: "edge"; row: SupplyRow } | { kind: "locked"; id: string };
const itemId = (item: Item) => item.kind === "edge" ? item.row.id : item.id;
const ROLE_ORDER: SupplyRole[] = ["customer", "supplier", "partner", "competitor", "investee"];
const ROLE_PLURALS: Record<SupplyRole, string> = { customer: "Customers", supplier: "Suppliers", partner: "Partners", competitor: "Competitors", investee: "Investees" };
const BAR_CELLS = 8;

/**
 * A narrow pane folds the ticker into the name and leaves the filing to the
 * evidence view before anything scrolls sideways. Value shows only when some
 * row discloses dollars.
 */
function tableColumns(width: number, desktop: boolean, locked: boolean, hasValue: boolean): DataTableColumn[] {
  const wide = width >= 150, medium = width >= 110;
  return [
    { id: "name", label: "Counterparty", width: Math.max(locked && !desktop ? 34 : 0, wide ? 40 : medium ? 32 : 22), flexGrow: 1, align: "left" },
    ...(medium ? [{ id: "ticker", label: "Ticker", width: 9, align: "left" as const }] : []),
    { id: "role", label: "Role", width: medium ? 12 : 11, align: "left" },
    { id: "pct", label: "Share", width: wide ? 48 : medium ? 42 : 28, align: "left" },
    ...(hasValue ? [{ id: "usd", label: "Value", width: medium ? 10 : 8, align: "right" as const }] : []),
    { id: "fy", label: "Period", width: medium ? 10 : 7, align: "left" },
    ...(medium ? [{ id: "source", label: "Filing", width: 18, align: "left" as const }] : []),
    ...(wide ? [{ id: "confidence", label: "Conf", width: 5, align: "right" as const }] : []),
  ];
}

/** Company, then disclosed counterparties per role: the strip that heads both tabs. */
function supplyFigures(data: SupplyChainPayload, views: readonly ("says" | "names")[]): StatItem[] {
  const shown = views.flatMap((view) => data[view]);
  return [
    ...(data.entity ? [{ id: "company", label: "Company", value: data.entity.name }] : []),
    ...ROLE_ORDER.flatMap((role) => {
      const count = views.reduce((total, view) => total + data.counts[view][role], 0);
      const visible = shown.filter((row) => row.role === role).length;
      return count ? [{ id: role, label: ROLE_PLURALS[role], value: String(count), color: ROLE_COLORS[role],
        detail: visible < count ? `${visible} shown` : undefined }] : [];
    }),
  ];
}

/** The share as a bar on a 0 to 100% scale, the figure, and what it is a share of. */
function ShareCell({ row, focusId, width, selected }: { row: SupplyRow; focusId?: string; width: number; selected: boolean }) {
  const colors = useThemeColors();
  const share = shareParts(row, focusId);
  if (!share) return <Text fg={colors.textMuted}>{""}</Text>;
  return <Box flexDirection="row" width={width} height={1} gap={1} overflow="hidden">
    <RatioBar ratio={row.pctOfRevenue! / 100} width={width >= 36 ? BAR_CELLS : 5} color={ROLE_COLORS[row.role]} track />
    <Text fg={selected ? colors.selectedText : colors.textBright} attributes={TextAttributes.BOLD}>{share.value.padStart(5)}</Text>
    <Text fg={selected ? colors.selectedText : colors.textDim}>{truncateToDisplayWidth(share.basis, Math.max(4, width - (width >= 36 ? BAR_CELLS : 5) - 7))}</Text>
  </Box>;
}

function Evidence({ row, focusId, width, height }: { row: SupplyRow; focusId?: string; width: number; height: number }) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const share = shareParts(row, focusId);
  const figures: StatItem[] = [
    ...(share ? [{ id: "share", label: "Share", value: share.value, detail: share.basis }] : []),
    ...(row.usd !== null ? [{ id: "value", label: "Value", value: dollars(row) }] : []),
    { id: "period", label: "Period", value: row.fiscalYear ? `FY ${row.fiscalYear}` : row.period, detail: row.fiscalYear ? row.period : undefined },
    { id: "filed", label: "Filed", value: row.filedDate ?? "--", detail: sourceLabel(row) },
    { id: "confidence", label: "Confidence", value: `${Math.round(row.confidence * 100)}%` },
  ];
  const kind = counterpartyKindLabel(row);
  return <ScrollBox width={width} height={desktop ? undefined : height} flexGrow={1} flexBasis={0}>
    <StatGrid items={figures} width={width} />
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <KeyValueRow label="Reporting company" value={row.reportingEntity.name} labelWidth={20} />
      <KeyValueRow label="Relationship" value={`${roleLabel(row.role)} · ${row.direction === "in" ? "inbound" : row.direction === "out" ? "outbound" : "mutual"}`}
        color={ROLE_COLORS[row.role]} labelWidth={20} />
      {kind ? <KeyValueRow label="Counterparty type" value={counterpartyKind(row) === "group" ? "Aggregate concentration group" : "Undisclosed by the filer"}
        labelWidth={20} /> : null}
      {row.pctScope ? <KeyValueRow label="Percentage scope" value={row.pctScope} labelWidth={20} /> : null}
      {row.quoteMatchMode ? <KeyValueRow label="Evidence match" value={row.quoteMatchMode === "exact" ? "Exact text" : row.quoteMatchMode === "whitespace" ? "Whitespace normalized" : "Unicode and whitespace normalized"} labelWidth={20} /> : null}
      <Box marginY={1} paddingLeft={desktop ? 0 : 1} border={desktop ? undefined : ["left"]} borderColor={ROLE_COLORS[row.role]}
        style={desktop ? { borderLeft: `3px solid ${ROLE_COLORS[row.role]}`, paddingLeft: 12, paddingTop: 4, paddingBottom: 4, backgroundColor: blendHex(colors.bg, ROLE_COLORS[row.role], 0.07), borderRadius: 2 } : undefined}>
        <Text fg={colors.textBright}>{row.quote}</Text>
      </Box>
      <ExternalLink url={row.filingUrl} label={`Open ${row.form ?? "filing"}${row.filedDate ? ` filed ${row.filedDate}` : ""}`} />
    </Box>
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
  const focusId = data?.entity?.id;
  const columns = tableColumns(width, desktop, locked > 0, rows.some((row) => row.usd !== null));
  const renderCell = (item: Item, column: DataTableColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    if (item.kind === "locked") {
      if (!desktop && column.id === "name" && item.id === "locked:0") return { text: "Upgrade to see every relationship", content: <UpgradeLabel text="Upgrade to see every relationship" onPress={openUpgrade} role="supply-upgrade" />, onMouseDown: openUpgrade };
      return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>{column.id === "name" ? "Additional relationship" : "Hidden"}</Text></Blurred> }
        : { text: "░".repeat(Math.min(8, column.width - 1)), color: colors.textDim };
    }
    const row = item.row;
    const ink = state.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "name": {
        const company = counterpartyKind(row) === "company";
        // The kind label never gives way to a long cohort name; a column too narrow for the name says it in one word.
        const full = counterpartyKindLabel(row);
        const kind = full && displayWidth(counterpartyLabel(row)) + displayWidth(full) + 4 <= column.width ? full : counterpartyKindLabel(row, true);
        const ticker = !columns.some((entry) => entry.id === "ticker") ? row.counterparty.ticker : null;
        const room = Math.max(8, column.width - (kind ? displayWidth(kind) + 4 : 0) - (ticker ? displayWidth(ticker) + 1 : 0));
        return { text: cellText(row, "name"), content: <Box flexDirection="row" height={1} gap={ticker ? 1 : 2} overflow="hidden">
          <Text fg={ink ?? (company ? colors.textBright : colors.textDim)}>{truncateToDisplayWidth(counterpartyLabel(row), room)}</Text>
          {ticker ? <Text fg={ink ?? colors.textDim}>{ticker}</Text> : null}
          {kind ? desktop ? <Badge label={kind} /> : <Text fg={ink ?? colors.textMuted}>{kind}</Text> : null}
        </Box> };
      }
      case "ticker": {
        const ticker = row.counterparty.ticker;
        if (!ticker) return { text: "", value: null };
        return { text: ticker, color: colors.textBright, content: desktop ? <Badge label={ticker} tone="accent" /> : undefined };
      }
      case "role": return { text: roleLabel(row.role), content: <Box flexDirection="row" height={1} overflow="hidden">
        <Text fg={ROLE_COLORS[row.role]}>●</Text>
        <Text fg={ink ?? ROLE_COLORS[row.role]}>{` ${roleLabel(row.role)}`}</Text>
      </Box> };
      case "pct": return { text: percentage(row) === "--" ? "" : `${shareParts(row, focusId)?.value ?? ""} ${shareParts(row, focusId)?.basis ?? ""}`.trim(), value: row.pctOfRevenue,
        content: <ShareCell row={row} focusId={focusId} width={column.width} selected={state.selected} /> };
      case "usd": return row.usd === null ? { text: "", value: null } : { text: dollars(row).replace(/ (disclosed|derived)$/, ""), value: row.usd, color: colors.text };
      case "fy": return { text: row.fiscalYear ? `FY${row.fiscalYear}` : row.period, color: colors.textDim };
      case "source": return { text: width >= 110 ? `${sourceLabel(row)}${row.filedDate ? ` · ${row.filedDate}` : ""}` : sourceLabel(row), color: colors.textDim };
      case "confidence": return { text: `${Math.round(row.confidence * 100)}%`, value: row.confidence, color: colors.textMuted };
      default: return { text: cellText(row, column.id) };
    }
  };
  if (!symbol) return <EmptyState title="Select a ticker." />;
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall action="view supply chain disclosures" needsVerification={session.needsVerification} />;
  const bodyHeight = Math.max(3, height - tabRows);
  const figures = data ? supplyFigures(data, tab === "flow" ? ["says", "names"] : [view]) : [];
  const header = <Box flexDirection="column" flexShrink={0}>
    <QueryBar width={width} filters={[{ id: "direction", label: "Filings", inline: true, value: view,
      options: [{ value: "says", label: `${symbol} says` }, { value: "names", label: `Names ${symbol}` }], onChange: (value: string) => { setView(value); setSelected(null); setOpen(null); } }]}
      meta={view === "names" ? "% of reporting company's basis" : undefined} />
    <StatGrid items={figures} width={width} />
  </Box>;
  const flowFigureColumns = Math.min(Math.max(1, figures.length), Math.max(1, Math.floor(width / 24)));
  // A short flow keeps one row of figures, dropping the last roles, so the cards keep their room.
  const flowFigures = bodyHeight < 26 ? figures.slice(0, flowFigureColumns) : figures;
  const selectedShare = selected ? shareParts(selected, focusId) : null;
  const flowMeta = selected ? `${selected.reportingEntity.ticker ?? selected.reportingEntity.name} ${selected.form ?? "filing"} · ${selectedShare ? `${selectedShare.value} ${selectedShare.basis}`
    : selected.usd !== null ? dollars(selected) : `${roleLabel(selected.role)}, no figure disclosed`}` : undefined;
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PaneStatusBody loading={!data && resource.loading} error={!data && resource.error !== SUPPLY_UNAVAILABLE ? resource.error : null}
      empty={!data && resource.error === SUPPLY_UNAVAILABLE} emptyTitle={SUPPLY_UNAVAILABLE} subject="supply chain disclosures">
      {data ? <PageStackView focused={focused} detailOpen={!!openRow} onBack={() => setOpen(null)} detailTitle={openRow ? counterpartyName(openRow) : undefined}
        detailContent={openRow ? <Evidence row={openRow} focusId={focusId} width={width} height={bodyHeight - 1} /> : null}
        rootContent={tab === "flow" ? <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
          <QueryBar width={width} meta={flowMeta} />
          <StatGrid items={flowFigures} width={width} columns={flowFigureColumns} />
          <SupplyFlow rows={allRows} symbol={symbol} focusName={data.entity?.name ?? null} focusId={focusId} width={width}
            height={Math.max(10, bodyHeight - 1 - statGridRows(flowFigures, width, flowFigureColumns) - (data.truncated ? 1 : 0))} focused={focused && !openRow} selectedId={selectedId}
            onSelect={setSelected} onOpen={navigate} onVisible={setFlowIds} />
          {data.truncated ? <Box paddingX={1}><UpgradeLabel text="Upgrade to see every relationship" onPress={openUpgrade} role="supply-upgrade" /></Box> : null}
        </Box> : <DataTableView<Item> columns={columns}
          items={items} focused={focused && !openRow} rootWidth={width} rootHeight={bodyHeight} rootBefore={header}
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
