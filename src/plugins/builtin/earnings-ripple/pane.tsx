import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableView, EmptyState, PaneStatusBody, usePaneFooter, usePaneNoticeFooter, usePaneTabs,
  type DataTableCell, type DataTableColumn, type PaneHint } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { getTableWidth } from "../../../components/ui/table-layout";
import { usePlanAccess } from "../../../api-client/plan-access";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState, useTickers } from "../../../public/react";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { isUsListingExchange } from "../../../utils/exchanges";
import { displayWidth } from "../../../utils/format";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { UpgradeLabel } from "../shared/locked-rows";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedRippleSources, loadRipple, rippleRouteSettings } from "./client";
import { hopLabel, revenueOwner, RIPPLE_DAYS, type RippleRow, type SecondHopRow } from "./model";

/** Calls per refresh stay bounded: one disclosure request per holding, plus one graph request per holding on the second hop. */
const RIPPLE_HOLDINGS_LIMIT = 60;

const TABS = [{ value: "direct", label: "1 hop" }, { value: "two-hop", label: "2 hops" }];

const COLUMNS: DataTableColumn[] = [
  { id: "date", label: "Date", width: 11, align: "left" },
  { id: "timing", label: "Time", width: 5, align: "left" },
  { id: "company", label: "Reports", width: 24, align: "left" },
  { id: "link", label: "Link", width: 13, align: "left" },
  { id: "holding", label: "Holding", width: 9, align: "left" },
  { id: "pct", label: "Revenue share", width: 15, align: "right" },
  { id: "move", label: "Avg move", width: 9, align: "right" },
  { id: "holdingDate", label: "Holding reports", width: 16, align: "right" },
];

const SECOND_HOP_COLUMNS: DataTableColumn[] = [
  { id: "date", label: "Date", width: 10, align: "left" },
  { id: "timing", label: "Time", width: 5, align: "left" },
  { id: "company", label: "Reports", width: 14, flexGrow: 1, align: "left" },
  { id: "link", label: "Link", width: 19, align: "left" },
  { id: "via", label: "Via", width: 9, align: "left" },
  { id: "holding", label: "Holding", width: 9, align: "left" },
  { id: "shares", label: "Share per hop", width: 28, align: "left" },
  { id: "move", label: "Avg move", width: 9, align: "right" },
  { id: "holdingDate", label: "Holding reports", width: 16, align: "right" },
];
const HOP_SEPARATOR = " › ";

/**
 * Holding to via, then via to the company that reports. The first hop is
 * padded with no-break spaces, which the desktop does not collapse.
 */
function shareText(row: SecondHopRow, firstHopWidth: number) {
  const first = hopLabel(row.hops[0]);
  return `${first}${"\u00a0".repeat(Math.max(0, firstHopWidth - displayWidth(first)))}${HOP_SEPARATOR}${hopLabel(row.hops[1])}`;
}

/**
 * The 2 hops table at this width. The date, the company and the route (via,
 * holding, every hop's share) always show, so the route never scrolls out of
 * view; a pane too narrow for all of it clips the shares. What room is left
 * goes to the rest, most needed first, each only if it fits: the link, the
 * report time, a long via name in full, the average move, shares lined up so
 * every second hop starts at the same place, and the holding's own report.
 * `firstHopWidth` is what the first hop is padded to, 0 when not lined up.
 */
function secondHopLayout(width: number, rows: readonly SecondHopRow[]) {
  const widest = (texts: readonly string[]) => Math.max(0, ...texts.map(displayWidth));
  const firstHop = widest(rows.map((row) => hopLabel(row.hops[0])));
  const shares = Math.min(44, Math.max(28, widest(rows.map((row) => shareText(row, 0)))));
  const aligned = Math.min(44, Math.max(shares, firstHop + HOP_SEPARATOR.length + widest(rows.map((row) => hopLabel(row.hops[1])))));
  const widths: Record<string, number> = { via: 9, shares };
  let firstHopWidth = 0;
  const shown = new Set(["date", "company", "via", "holding", "shares"]);
  const columns = () => SECOND_HOP_COLUMNS.filter((column) => shown.has(column.id))
    .map((column) => widths[column.id] ? { ...column, width: widths[column.id]! } : column);
  // The vertical scrollbar takes a cell, including when the rows fit.
  const room = () => width - 1 - getTableWidth(columns());
  const fitted = widths.shares = Math.max(28, shares + Math.min(0, room()));
  const extras: [add: () => void, undo: () => void][] = [
    ...["link", "timing"].map((id): [() => void, () => void] => [() => shown.add(id), () => shown.delete(id)]),
    [() => { widths.via = Math.min(18, Math.max(9, widest(rows.map((row) => row.via)))); }, () => { widths.via = 9; }],
    [() => shown.add("move"), () => shown.delete("move")],
    [() => { widths.shares = aligned; firstHopWidth = firstHop; }, () => { widths.shares = fitted; firstHopWidth = 0; }],
    [() => shown.add("holdingDate"), () => shown.delete("holdingDate")],
  ];
  for (const [add, undo] of extras) {
    add();
    if (room() < 0) undo();
  }
  return { columns: columns(), firstHopWidth };
}

const move = (row: RippleRow | SecondHopRow): DataTableCell =>
  ({ text: row.averageMove == null ? "--" : `±${(row.averageMove * 100).toFixed(1)}%`, value: row.averageMove });

function renderCell(row: RippleRow, column: DataTableColumn): DataTableCell {
  switch (column.id) {
    case "date": return { text: row.date };
    case "timing": return { text: row.timing?.toUpperCase() ?? "--" };
    case "company": return { text: `${row.company} ${row.companyName}` };
    case "link": return { text: row.link === "customer" ? "customer of" : "supplier to" };
    case "holding": return { text: row.holding };
    case "pct": return { text: `${row.pctOfRevenue}%${row.pctScope ? "*" : ""} of ${revenueOwner(row)}`, value: row.pctOfRevenue };
    case "move": return move(row);
    default: return { text: row.holdingDate ?? "--" };
  }
}

function renderSecondHopCell(row: SecondHopRow, column: DataTableColumn, firstHopWidth: number): DataTableCell {
  switch (column.id) {
    case "date": return { text: row.date };
    case "timing": return { text: row.timing?.toUpperCase() ?? "--" };
    case "company": return { text: `${row.company} ${row.companyName}` };
    case "link": return { text: row.link === "customer" ? "customer's customer" : "supplier's supplier" };
    case "via": return { text: row.via };
    case "holding": return { text: row.holding };
    case "shares": return { text: shareText(row, firstHopWidth), value: shareText(row, 0) };
    case "move": return move(row);
    default: return { text: row.holdingDate ?? "--" };
  }
}

export function EarningsRipplePane({ width, height, focused }: PaneProps) {
  const [symbolsText] = usePaneSettingValue("symbols", "");
  const [openingTab] = usePaneSettingValue("tab", "direct");
  const [savedTab, setTab] = usePluginPaneState<string>("tab", openingTab);
  const tab = savedTab === "two-hop" ? "two-hop" : "direct";
  const tickers = useTickers();
  const { createPaneFromTemplate } = usePluginAppActions();
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedRow", null);
  const [selectedSecondId, setSelectedSecondId] = usePluginPaneState<string | null>("selectedSecondHop", null);
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "full" : "preview"}`;
  // Named tickers, or every US listing in the user's portfolios and watchlists, positions first.
  const scope = useMemo(() => {
    const named = symbolsText.split(/[\s,]+/).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
    const all = named.length ? [...new Set(named)] : [...new Set([...tickers.values()]
      .filter((ticker) => ticker.metadata.portfolios.length + ticker.metadata.watchlists.length > 0 && isUsListingExchange(ticker.metadata.exchange))
      .sort((a, b) => Number(b.metadata.portfolios.length > 0) - Number(a.metadata.portfolios.length > 0) || a.metadata.ticker.localeCompare(b.metadata.ticker))
      .map((ticker) => ticker.metadata.ticker.toUpperCase()))];
    return { holdings: all.slice(0, RIPPLE_HOLDINGS_LIMIT), total: all.length, named: named.length > 0 };
  }, [symbolsText, tickers]);
  const holdings = scope.holdings;
  const holdingsKey = holdings.join(",");
  const secondHop = tab === "two-hop";
  // A free account's graph stops at one hop, so it makes no graph requests and its second tab reuses the first load.
  // Once a Pro account opens 2 hops the graph stays in the load, so going back and forth between tabs never reloads.
  // A refresh on 1 hop reads the graphs from the cache instead of asking for them again.
  const [graphOpened, setGraphOpened] = useState(false);
  useEffect(() => { if (secondHop && access.hasProAccess) setGraphOpened(true); }, [secondHop, access.hasProAccess]);
  const graphHop = access.hasProAccess && (secondHop || graphOpened);
  const secondHopShown = useRef(secondHop);
  secondHopShown.current = secondHop;
  const loader = useCallback((force: boolean) => loadRipple(holdings,
    cachedRippleSources(accessKey, force, !graphHop ? "off" : secondHopShown.current ? "load" : "cached"), undefined, { secondHop: graphHop }),
  [holdingsKey, accessKey, graphHop]);
  const ripple = useAsyncResource(holdings.length ? loader : null);
  useAutoRefresh(ripple.updatedAt, ripple.load);
  usePaneRefreshKey(() => { void ripple.reload(); }, { focused });
  const { strip, rows: tabRows } = usePaneTabs(holdings.length ? { tabs: TABS, activeValue: tab, onSelect: setTab, focused, dense: true } : null);

  const rows = ripple.data?.rows ?? [];
  const second = secondHop ? ripple.data?.secondHop ?? null : null;
  const secondRows = second?.rows ?? [];
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const selectedSecond = secondRows.find((row) => row.id === selectedSecondId) ?? secondRows[0] ?? null;
  const current = secondHop ? selectedSecond : selected;
  const failures = ripple.data?.failures ?? [];
  const truncated = ripple.data?.truncated ?? [];
  const locked = secondHop && (!access.hasProAccess || !!second?.locked);
  const openUpgrade = useCloudUpgradeAction("ripl");
  usePaneNoticeFooter({ registrationId: "earnings-ripple-notices", focused, notices: [
    ...(scope.total > holdings.length ? [`Checking ${holdings.length} of ${scope.total} holdings${scope.named ? "" : ", positions first. Name tickers in pane settings to pick others"}`] : []),
    ...(failures.length ? [`No disclosures for ${failures.map((failure) => failure.symbol).join(", ")}`] : []),
    ...(!secondHop && truncated.length ? [`Free preview: top three customers and suppliers for ${truncated.join(", ")}`] : []),
    ...(second?.failures.length ? [`No two-hop graph for ${second.failures.map((failure) => failure.symbol).join(", ")}`] : []),
    // The graph returns at most 50 companies per direction, so a large holding's list can be cut short.
    ...(second?.truncated.length ? [`Graph search capped for ${second.truncated.map((entry) => entry.symbol).join(", ")}; some companies two hops away may be missing`] : []),
  ] });
  const openSupply = useCallback((row: RippleRow) => createPaneFromTemplate("supply-chain-pane", { symbol: row.holding }), [createPaneFromTemplate]);
  // SPLC's own table does not reach a company two hops away; its Path view shows the row's route.
  const openRoute = useCallback((row: SecondHopRow) => createPaneFromTemplate("supply-chain-pane", { symbol: row.holding, values: rippleRouteSettings(row) }),
    [createPaneFromTemplate]);
  usePaneFooter("earnings-ripple", () => {
    const hints: PaneHint[] = [
      ...(secondHop && selectedSecond ? [{ id: "supply", key: "s", label: "upply chain", title: `Supply chain path from ${selectedSecond.holding} to ${selectedSecond.company}`,
        onPress: () => openRoute(selectedSecond) }]
        : !secondHop && selected ? [{ id: "supply", key: "s", label: "upply chain", onPress: () => openSupply(selected) }] : []),
      ...(current ? [{ id: "earnings", key: "e", label: "arnings", onPress: () => createPaneFromTemplate("earnings-calendar-pane", { arg: current.company }) }] : []),
      ...((secondHop ? locked : truncated.length) ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: openUpgrade }] : []),
    ];
    return { info: [
      ...(ripple.loading ? [{ id: "loading", parts: [{ text: secondHop && graphHop ? "loading supply chain graph" : "loading disclosures", tone: "muted" as const }] }] : []),
      ...(ripple.data?.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
    ], hints };
  }, [ripple.loading, ripple.data?.stale, current, selected, selectedSecond, secondHop, graphHop, locked, openSupply, openRoute, createPaneFromTemplate, truncated.length, openUpgrade]);

  const secondLayout = useMemo(() => secondHopLayout(width, secondRows), [width, secondRows]);
  const firstHopWidth = secondLayout.firstHopWidth;
  const renderSecondCell = useCallback((row: SecondHopRow, column: DataTableColumn) => renderSecondHopCell(row, column, firstHopWidth), [firstHopWidth]);
  const windowMeta = () => [["window", `${ripple.data?.from} to ${ripple.data?.to}`]];
  const bodyHeight = Math.max(3, height - tabRows);
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    {strip}
    {!holdings.length ? <EmptyState title="Add tickers to a portfolio or watchlist, or name them in pane settings." />
      : secondHop && locked ? <Box paddingX={1} paddingTop={1}><EmptyState title="Companies two hops away need Gloom Pro."
        actions={<UpgradeLabel text="Upgrade for two-hop supply chains" onPress={openUpgrade} role="ripple-upgrade" />} /></Box>
      : <PaneStatusBody subject={secondHop ? "two-hop supply chains" : "earnings ripple"} loading={ripple.loading && (!ripple.data || (secondHop && !second))}
        error={!ripple.data ? ripple.error : null}
        empty={secondHop ? !!second && !secondRows.length : !!ripple.data && !rows.length}
        emptyTitle={secondHop ? `No company two disclosed hops from these holdings reports in the next ${RIPPLE_DAYS} days.`
          : `No disclosed customer or supplier of these holdings reports in the next ${RIPPLE_DAYS} days.`}>
        {secondHop
          ? <DataTableView<SecondHopRow> focused={focused} columns={secondLayout.columns} items={secondRows} rootWidth={width} rootHeight={bodyHeight}
            getItemKey={(row) => row.id} emptyStateTitle="No reports." sortColumnId={null} sortDirection="asc"
            selection={{ kind: "id", selectedId: selectedSecond?.id ?? null, getId: (row) => row.id, onChange: setSelectedSecondId }}
            onActivate={openRoute}
            getExportMetadata={() => [...windowMeta(), ["share per hop", "percent of the reporting company's revenue unless another basis is named, holding to via, then via to the company"]]}
            renderCell={renderSecondCell} />
          : <DataTableView<RippleRow> focused={focused} columns={COLUMNS} items={rows} rootWidth={width} rootHeight={bodyHeight}
            getItemKey={(row) => row.id} emptyStateTitle="No reports." sortColumnId={null} sortDirection="asc"
            selection={{ kind: "id", selectedId: selected?.id ?? null, getId: (row) => row.id, onChange: setSelectedId }}
            onActivate={openSupply}
            getExportMetadata={() => [...windowMeta(), ["revenue share", "percent of the seller's revenue, as its filing discloses"]]}
            renderCell={renderCell} />}
      </PaneStatusBody>}
  </Box>;
}
