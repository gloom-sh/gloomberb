import { publicTickerKey } from "../../../utils/exchanges";
import { getSharedRegistry } from "../../registry/shared";
import { useCallback, useMemo, useState } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { SupplyChainPayload, SupplyOptions, SupplyRole, SupplyRow, SupplyTierFilter } from "../../../api-client/supply-chain";
import {
  Badge, buildSectionedRows, DataTableView, EmptyState, isSectionedItemRow, PageStackView, renderSectionedRowHeader, PaneStatusBody, QueryBar, StatGrid, statGridRows, usePaneNoticeFooter,
  usePaneStatusFooter, usePaneTabs, type DataTableCell, type DataTableColumn, type PaneHint, type SectionedRow, type StatItem,
} from "../../../components";
import { RatioBar } from "../../../components/ui/ratio-bar";
import { getTableWidth } from "../../../components/ui/table-layout";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes, useRendererHost, useUiCapabilities } from "../../../ui";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { Blurred, LockedOverlay, UpgradeLabel } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedSupplyChain, loadSupplyChain, SUPPLY_UNAVAILABLE, validateSupplyChain } from "./client";
import { useSupplyEvidence } from "./evidence";
import { SupplyFlow } from "./flow";
import { SupplyGraphPane } from "./graph-pane";
import {
  cellText, counterpartyKind, counterpartyKindLabel, counterpartyLabel, counterpartyName, disclosedValue, nativeValue, percentage, ROLE_COLORS, roleLabel,
  shareParts, sortRows, supplyRoleCounts, type SupplySort,
} from "./model";
import { RowEvidence } from "./row-evidence";
import { evidenceDate, evidenceLabel, isUnconfirmed, matchesSupplyOptions, supplyOptions, TIER_OPTIONS } from "./trust";

type Item = { kind: "edge"; row: SupplyRow } | { kind: "locked"; id: string };
const itemId = (item: Item) => item.kind === "edge" ? item.row.id : item.id;
const ROLE_PLURALS: Record<SupplyRole, string> = { customer: "Customers", supplier: "Suppliers", partner: "Partners", competitor: "Competitors", investee: "Investees" };
/** A share figure is at most five cells (`99.9%`, `100%`), right-aligned so the bars line up. */
const SHARE_FIGURE_CELLS = 5;
/** Bar, gap and figure: below this a share cell shows the figure alone. */
const SHARE_BAR_MIN_CELLS = 3 + 1 + SHARE_FIGURE_CELLS;

/**
 * Cells of a share column's bar: as long as the column allows after the figure
 * and the longest basis that fits, between 3 and 8 cells, and the same on every
 * row so the bars and figures line up. Zero leaves the figure alone.
 */
function shareBarCells(width: number, bases: readonly number[]): number {
  if (width < SHARE_BAR_MIN_CELLS) return 0;
  // Room for the longest basis that can show at all; a longer one gives way, not every bar.
  const basis = longestBasis(bases, width);
  return Math.min(width >= 36 ? 8 : 5, Math.max(3, width - SHARE_FIGURE_CELLS - 2 - basis));
}
const longestBasis = (bases: readonly number[], width: number) => Math.max(0, ...bases.filter((cells) => SHARE_BAR_MIN_CELLS + 1 + cells <= width));

/**
 * Columns that fit the pane, giving up the least first: the share bar shortens
 * to keep the whole basis, the name shortens to 18 cells, the ticker folds into
 * the name and the period is left to the evidence view; then the share drops
 * its basis and its bar, and the name shortens further. Only a pane narrower
 * than that scrolls sideways, so the pane edge never cuts a share in half.
 * Value shows only when some row discloses a value, retaining its original
 * currency and units.
 */
function tableColumns(width: number, desktop: boolean, locked: boolean, valueWidth: number | null, bases: readonly number[]): DataTableColumn[] {
  const wide = width >= 150, medium = width >= 110;
  const name: DataTableColumn = { id: "name", label: "Counterparty", width: Math.max(locked && !desktop ? 34 : 0, wide ? 30 : medium ? 26 : 20), flexGrow: 1, align: "left" };
  const share: DataTableColumn = { id: "pct", label: "Share", width: wide ? 34 : medium ? 30 : 26, align: "left" };
  let columns: DataTableColumn[] = [
    name,
    { id: "evidence", label: "Evidence", width: 12, align: "left" },
    ...(medium ? [{ id: "ticker", label: "Ticker", width: 8, align: "left" as const }] : []),
    { id: "role", label: "Role", width: 11, align: "left" },
    share,
    ...(valueWidth !== null ? [{ id: "usd", label: "Value", width: Math.max(medium ? 10 : 8, valueWidth), align: "right" as const }] : []),
    { id: "fy", label: "Period", width: 10, align: "left" },
    ...(wide ? [
      { id: "filed", label: "Published", width: 10, align: "left" as const },
      { id: "publisher", label: "Publisher", width: 16, align: "left" as const },
      { id: "corroboration", label: "Origins", width: 8, align: "right" as const },
    ] : []),
  ];
  const preferred = { share: share.width, name: name.width };
  // The table ignores its last trailing gutter when deciding whether it fits.
  const overflow = () => getTableWidth(columns) - width - 1;
  // Native units keep their column before the share keeps its bar or basis.
  const shareFloor = valueWidth !== null ? SHARE_BAR_MIN_CELLS + 1 : SHARE_BAR_MIN_CELLS + 1 + longestBasis(bases, preferred.share);
  const fit = (shareMin: number, nameMin = 18) => {
    share.width = preferred.share; name.width = preferred.name;
    share.width = Math.max(shareMin, share.width - Math.max(0, overflow()));
    name.width = Math.max(nameMin, name.width - Math.max(0, overflow()));
  };
  fit(shareFloor);
  for (const id of ["ticker", "fy"]) {
    if (overflow() <= 0) break;
    if (!columns.some((column) => column.id === id)) continue;
    columns = columns.filter((column) => column.id !== id);
    fit(shareFloor);
  }
  // The narrowest panes keep the figure alone, then a shorter name, before anything scrolls.
  if (overflow() > 0) fit(SHARE_BAR_MIN_CELLS);
  if (overflow() > 0) fit(SHARE_FIGURE_CELLS + 2, 12);
  return columns;
}

/**
 * Company, then the counterparties per role on this tab, with how many
 * disclosures a free preview locks: the strip that heads the table and the flow.
 */
function supplyFigures(data: SupplyChainPayload, views: readonly ("says" | "names")[], options: Required<SupplyOptions>): StatItem[] {
  return [
    ...(data.entity ? [{ id: "company", label: "Company", value: data.entity.name }] : []),
    ...supplyRoleCounts(data, views, options).map(({ role, counterparties, locked }) => ({ id: role, label: ROLE_PLURALS[role], value: String(counterparties),
      color: ROLE_COLORS[role], detail: locked ? `+${locked} locked` : undefined })),
  ];
}

/**
 * The share as a bar on a 0 to 100% scale, the figure, and what it is a share
 * of. The basis shows whole or not at all: a column too narrow for it keeps
 * the bar and figure, and the evidence view says the rest.
 */
function ShareCell({ row, focusId, width, bases, selected }: { row: SupplyRow; focusId?: string; width: number; bases: readonly number[]; selected: boolean }) {
  const colors = useThemeColors();
  const share = shareParts(row, focusId);
  if (!share) return <Text fg={colors.textMuted}>{""}</Text>;
  const bar = shareBarCells(width, bases);
  if (!bar) return <Text fg={selected ? colors.selectedText : colors.textBright} attributes={TextAttributes.BOLD}>{share.value}</Text>;
  const basis = bar + SHARE_FIGURE_CELLS + 2 + displayWidth(share.basis) <= width;
  return <Box flexDirection="row" width={width} height={1} gap={1} overflow="hidden">
    <RatioBar ratio={row.pctOfRevenue! / 100} width={bar} color={ROLE_COLORS[row.role]} track />
    <Text fg={selected ? colors.selectedText : colors.textBright} attributes={TextAttributes.BOLD}>{share.value.padStart(SHARE_FIGURE_CELLS)}</Text>
    {basis ? <Text fg={selected ? colors.selectedText : colors.textDim}>{share.basis}</Text> : null}
  </Box>;
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
  const [openingTab] = usePaneSettingValue("tab", "table");
  const [savedTab, setTab] = usePluginPaneState<string>("supply:tab", openingTab);
  const graphTab = savedTab === "graph" || savedTab === "path";
  const [openingTiers] = usePaneSettingValue("tiers", "sec,company,call");
  const initialTiers = useMemo(() => supplyOptions(openingTab === "graph" || openingTab === "path" ? undefined : openingTiers).tiers, [openingTiers, openingTab]);
  const [savedTiers, setTiers] = usePluginPaneState<SupplyTierFilter[]>("supply:tiers", initialTiers);
  const options = useMemo(() => supplyOptions(savedTiers), [savedTiers]);
  const loader = useCallback((force: boolean) => snapshot ? Promise.resolve({ payload: snapshot, stale: false, refreshError: null }) : loadSupplyChain(symbol!, accessKey, force, options), [symbol, accessKey, snapshot, options]);
  const resource = useAsyncResource(symbol && !graphTab ? loader : null, {
    initialData: () => symbol ? cachedSupplyChain(symbol, accessKey, options) : null, clearOnError: isAccessDenied,
  });
  const data = resource.data?.payload ?? null;
  const [openingView] = usePaneSettingValue("view", "says");
  const [savedView, setView] = usePluginPaneState<string>("supply:view", openingView);
  const view = savedView === "names" ? "names" : "says";
  const tooSmall = width < 70 || height < 13;
  const tab = graphTab ? savedTab : savedTab === "flow" && !tooSmall ? "flow" : "table";
  const [sort, setSort] = usePluginPaneState<SupplySort>("supply:sort", { column: "pct", direction: "desc" });
  const [selectedId, setSelected] = usePluginPaneState<string | null>(`supply:selected:${view}`, null);
  const [openingEvidence] = usePaneSettingValue("evidence", false);
  const [openId, setOpen] = usePluginPaneState<string | null>("supply:evidence", null);
  const allRows = useMemo(() => data ? [...data.says, ...data.names].filter((row) => matchesSupplyOptions(row, options)) : [], [data, options]);
  const [flowIds, setFlowIds] = useState<string[]>([]);
  const rows = useMemo(() => data ? sortRows(data[view].filter((row) => matchesSupplyOptions(row, options)), sort) : [], [data, view, sort, options]);
  const selectionRows = tab === "flow" ? allRows.filter((row) => flowIds.includes(row.id)) : rows;
  const selected = tab === "flow" && selectedId?.startsWith("more:") ? null
    : selectionRows.find((row) => row.id === selectedId) ?? (tab === "flow" ? allRows.find((row) => row.id === flowIds[0]) : rows[0]) ?? null;
  const openRow = allRows.find((row) => row.id === openId) ?? (openingEvidence && openId === null ? rows[0] : null) ?? null;
  useSupplyEvidence(graphTab ? null : data, tab, view, tab === "flow" ? flowIds : rows.map((row) => row.id), openRow?.id ?? null, options.tiers);
  const locked = data?.truncated ? Math.max(0, Object.values(data.counts[view]).reduce((a, b) => a + b, 0) - data[view].length) : 0;
  const items = useMemo<SectionedRow<Item>[]>(() => buildSectionedRows<Item>([
    { label: "Relationships", items: rows.filter((row) => !isUnconfirmed(row)).map((row) => ({ kind: "edge", row })) },
    { label: "Unconfirmed", items: rows.filter(isUnconfirmed).map((row) => ({ kind: "edge", row })) },
    { label: "Pro", items: Array.from({ length: Math.min(3, locked) }, (_, i) => ({ kind: "locked", id: `locked:${i}` })) },
  ], itemId), [rows, locked]);
  const { strip, rows: tabRows } = usePaneTabs(symbol ? { tabs: [{ value: "table", label: "Table" }, { value: "flow", label: "Flow", disabled: tooSmall }, { value: "graph", label: "Graph" }, { value: "path", label: "Path" }], activeValue: tab, onSelect: setTab, focused, dense: true } : null);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused: focused && !graphTab });
  const navigate = (row: SupplyRow, template = "supply-chain-pane") => {
    if (row.counterparty.ticker) createPaneFromTemplate(template, { symbol: publicTickerKey(row.counterparty.ticker, row.counterparty.exchange ?? undefined) });
    else setOpen(row.id);
  };
  const evidence = () => {
    if (!selected) return;
    setOpen(selected.id);
  };
  const current = openRow ?? selected;
  const hints: PaneHint[] = [
    ...(current ? [{ id: "source", key: "o", label: "pen source", onPress: () => void host.openExternal(current.filingUrl) }] : []),
    ...(!openRow && selected ? [{ id: "evidence", key: "e", label: "vidence", onPress: evidence }] : []),
    ...(selected?.counterparty.ticker ? [
      { id: "description", key: "d", label: "es", onPress: () => navigate(selected, "new-ticker-detail-pane") },
      { id: "financials", key: "f", label: "a", onPress: () => navigate(selected, "financial-analysis-pane") },
      { id: "chart", key: "g", label: "raph", onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: publicTickerKey(selected.counterparty.ticker!, selected.counterparty.exchange ?? undefined) }) },
      ...(getSharedRegistry()?.paneTemplates.has("buildout-pane") ? [{ id: "buildout", key: "t", label: "bo", onPress: () => createPaneFromTemplate("buildout-pane") }] : []),
    ] : []),
    ...(data?.truncated ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: openUpgrade }] : []),
  ];
  usePaneStatusFooter({ registrationId: "supply-chain", enabled: !graphTab, loading: resource.loading, error: data ? resource.error : null, stale: resource.data?.stale,
    info: data?.asOf ? [{ id: "as-of", parts: [{ text: `as of ${data.asOf}`, tone: "muted" as const }] }] : [], hints });
  usePaneNoticeFooter({ registrationId: "supply-chain:notices", focused, enabled: !graphTab, notices: [
    ...(resource.data?.refreshError ? [resource.data.refreshError] : []),
    ...(savedTab === "flow" && tooSmall ? ["Flow needs a wider pane. Showing the table."] : []),
  ] });
  const focusId = data?.entity?.id;
  const values = rows.filter((row) => nativeValue(row) !== null || row.usd !== null);
  const valueWidth = values.length ? Math.min(28, Math.max(...values.map((row) => displayWidth(disclosedValue(row).replace(/ (disclosed|derived)$/, ""))))) : null;
  const bases = rows.flatMap((row) => { const share = shareParts(row, focusId); return share ? [displayWidth(share.basis)] : []; });
  const columns = tableColumns(width, desktop, locked > 0, valueWidth, bases);
  const renderCell = (entry: SectionedRow<Item>, column: DataTableColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    if (!isSectionedItemRow(entry)) return { text: "" };
    const item = entry.item;
    if (item.kind === "locked") {
      if (!desktop && column.id === "name" && item.id === "locked:0") {
        const label = column.width >= 34 ? "Upgrade to see every relationship" : "Upgrade to Pro";
        return { text: label, content: <UpgradeLabel text={label} onPress={openUpgrade} role="supply-upgrade" />, onMouseDown: openUpgrade };
      }
      return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>{column.id === "name" ? "Additional relationship" : "Hidden"}</Text></Blurred> }
        : { text: "░".repeat(Math.min(8, column.width - 1)), color: colors.textDim };
    }
    const row = item.row;
    const ink = state.selected ? colors.selectedText : isUnconfirmed(row) ? colors.textDim : undefined;
    switch (column.id) {
      case "evidence": return { text: evidenceLabel(row), content: <Badge label={evidenceLabel(row)} tone={isUnconfirmed(row) ? "neutral" : "accent"} /> };
      case "filed": return { text: evidenceDate(row), color: colors.textDim };
      case "publisher": return { text: cellText(row, "publisher"), color: colors.textDim };
      case "corroboration": return { text: String(row.corroboration ?? 1), value: row.corroboration ?? 1, color: colors.textDim, content: <Text fg={colors.textDim}>{row.corroboration ?? 1}</Text> };
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
        content: <ShareCell row={row} focusId={focusId} width={column.width} bases={bases} selected={state.selected} /> };
      case "usd": return nativeValue(row) === null && row.usd === null ? { text: "", value: null }
        : { text: disclosedValue(row).replace(/ (disclosed|derived)$/, ""), value: row.nativeAmount != null ? row.nativeAmount * (row.nativeScale ?? 1) : row.usd, color: colors.text };
      case "fy": return { text: row.period, color: colors.textDim };
      default: return { text: cellText(row, column.id) };
    }
  };
  if (!symbol) return <EmptyState title="Select a ticker." />;
  if (graphTab) return <Box width={width} height={height} flexDirection="column">{strip}<SupplyGraphPane symbol={symbol} tab={savedTab as "graph" | "path"} width={width} height={Math.max(3, height - tabRows)} focused={focused} /></Box>;
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall placement="supply-chain-signin" action="view supply chain disclosures" needsVerification={session.needsVerification} />;
  const bodyHeight = Math.max(3, height - tabRows);
  const figures = data ? supplyFigures(data, tab === "flow" ? ["says", "names"] : [view], options) : [];
  const tierFilter = { id: "tiers", label: "Evidence", kind: "multi" as const, emptyLabel: "Primary", values: options.tiers, options: TIER_OPTIONS, onChange: (value: string[]) => { setTiers(supplyOptions(value).tiers); setSelected(null); setOpen(null); } };
  const header = <Box flexDirection="column" flexShrink={0}>
    <QueryBar width={width} filters={[{ id: "direction", label: "Direction", inline: true, value: view,
      options: [{ value: "says", label: `${symbol} says` }, { value: "names", label: `Names ${symbol}` }], onChange: (value: string) => { setView(value); setSelected(null); setOpen(null); } }, tierFilter]}
      meta={view === "names" ? "% of reporting company's basis" : undefined} />
    <StatGrid items={figures} width={width} />
  </Box>;
  const flowFigureColumns = Math.min(Math.max(1, figures.length), Math.max(1, Math.floor(width / 24)));
  // A short flow keeps one row of figures, dropping the last roles, so the cards keep their room.
  const flowFigures = bodyHeight < 26 ? figures.slice(0, flowFigureColumns) : figures;
  const selectedShare = selected ? shareParts(selected, focusId) : null;
  const flowMeta = selected ? `${selected.reportingEntity.ticker ?? selected.reportingEntity.name} ${evidenceLabel(selected)} · ${selectedShare ? `${selectedShare.value} ${selectedShare.basis}`
    : nativeValue(selected) !== null || selected.usd !== null ? disclosedValue(selected) : `${roleLabel(selected.role)}, no figure disclosed`}` : undefined;
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PaneStatusBody loading={!data && resource.loading} error={!data && resource.error !== SUPPLY_UNAVAILABLE ? resource.error : null}
      empty={!data && resource.error === SUPPLY_UNAVAILABLE} emptyTitle={SUPPLY_UNAVAILABLE} subject="supply chain disclosures">
      {data ? <PageStackView focused={focused} detailOpen={!!openRow} onBack={() => setOpen("")} detailTitle={openRow ? counterpartyName(openRow) : undefined}
        detailContent={openRow ? <RowEvidence row={openRow} focusId={focusId} width={width} height={bodyHeight - 1} focused={focused} /> : null}
        rootContent={tab === "flow" ? <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
          <QueryBar width={width} filters={[tierFilter]} meta={flowMeta} />
          <StatGrid items={flowFigures} width={width} columns={flowFigureColumns} />
          <SupplyFlow rows={allRows} symbol={symbol} focusName={data.entity?.name ?? null} focusId={focusId} width={width}
            height={Math.max(10, bodyHeight - 1 - statGridRows(flowFigures, width, flowFigureColumns) - (data.truncated ? 1 : 0))} focused={focused && !openRow} selectedId={selectedId}
            onSelect={setSelected} onOpen={navigate} onVisible={setFlowIds} />
          {data.truncated ? <Box paddingX={1}><UpgradeLabel text="Upgrade to see every relationship" onPress={openUpgrade} role="supply-upgrade" /></Box> : null}
        </Box> : <DataTableView<SectionedRow<Item>> columns={columns}
          items={items} focused={focused && !openRow} rootWidth={width} rootHeight={bodyHeight} rootBefore={header}
          selection={{ kind: "id", selectedId: selected?.id ?? null, getId: (entry) => entry.key, onChange: (id) => setSelected(id) }} getItemKey={(entry) => entry.key}
          isNavigable={isSectionedItemRow}
          // The placeholders stand for every locked disclosure; the header counts those, as the figures do.
          renderSectionHeader={(entry) => entry.kind === "section" && entry.label === "Pro" ? { text: `Pro (${locked})` } : renderSectionedRowHeader(entry)}
          onActivate={(entry) => { if (isSectionedItemRow(entry)) entry.item.kind === "edge" ? navigate(entry.item.row) : openUpgrade(); }}
          renderCell={renderCell} sortColumnId={sort.column} sortDirection={sort.direction}
          onHeaderClick={(column) => setSort((old) => ({ column, direction: old.column === column && old.direction === "desc" ? "asc" : "desc" }))}
          selectedTextOverridesCellColor showHorizontalScrollbar resetScrollKey={`${symbol}:${view}:${options.tiers.join(",")}`}
          emptyStateTitle="No relationships for the selected evidence tiers."
          bodyAfter={locked > 0 && desktop ? <LockedOverlay rows={Math.min(3, locked)} text="Upgrade to see every relationship" onPress={openUpgrade} role="supply-upgrade" /> : undefined} />}
      /> : null}
    </PaneStatusBody>
  </Box>;
}
