import { useCallback, useMemo } from "react";
import { DataTableView, EmptyState, PaneStatusBody, usePaneFooter, usePaneNoticeFooter,
  type DataTableCell, type DataTableColumn, type PaneHint } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { usePlanAccess } from "../../../api-client/plan-access";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState, useTickers } from "../../../public/react";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { isUsListingExchange } from "../../../utils/exchanges";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedRippleSources, loadRipple } from "./client";
import { revenueOwner, RIPPLE_DAYS, type RippleRow } from "./model";

/** Calls per refresh stay bounded: one disclosure request per holding. */
const RIPPLE_HOLDINGS_LIMIT = 60;

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

function renderCell(row: RippleRow, column: DataTableColumn): DataTableCell {
  switch (column.id) {
    case "date": return { text: row.date };
    case "timing": return { text: row.timing?.toUpperCase() ?? "--" };
    case "company": return { text: `${row.company} ${row.companyName}` };
    case "link": return { text: row.link === "customer" ? "customer of" : "supplier to" };
    case "holding": return { text: row.holding };
    case "pct": return { text: `${row.pctOfRevenue}%${row.pctScope ? "*" : ""} of ${revenueOwner(row)}`, value: row.pctOfRevenue };
    case "move": return { text: row.averageMove == null ? "--" : `±${(row.averageMove * 100).toFixed(1)}%`, value: row.averageMove };
    default: return { text: row.holdingDate ?? "--" };
  }
}

export function EarningsRipplePane({ width, height, focused }: PaneProps) {
  const [symbolsText] = usePaneSettingValue("symbols", "");
  const tickers = useTickers();
  const { createPaneFromTemplate } = usePluginAppActions();
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedRow", null);
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
  const loader = useCallback((force: boolean) => loadRipple(holdings, cachedRippleSources(accessKey, force)), [holdingsKey, accessKey]);
  const ripple = useAsyncResource(holdings.length ? loader : null);
  useAutoRefresh(ripple.updatedAt, ripple.load);
  usePaneRefreshKey(() => { void ripple.reload(); }, { focused });

  const rows = ripple.data?.rows ?? [];
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const failures = ripple.data?.failures ?? [];
  const truncated = ripple.data?.truncated ?? [];
  const openUpgrade = useCloudUpgradeAction("ripl");
  usePaneNoticeFooter({ registrationId: "earnings-ripple-notices", focused, notices: [
    ...(scope.total > holdings.length ? [`Checking ${holdings.length} of ${scope.total} holdings${scope.named ? "" : ", positions first. Name tickers in pane settings to pick others"}`] : []),
    ...(failures.length ? [`No disclosures for ${failures.map((failure) => failure.symbol).join(", ")}`] : []),
    ...(truncated.length ? [`Free preview: top three customers and suppliers for ${truncated.join(", ")}`] : []),
  ] });
  const openSupply = useCallback((row: RippleRow) => createPaneFromTemplate("supply-chain-pane", { symbol: row.holding }), [createPaneFromTemplate]);
  usePaneFooter("earnings-ripple", () => {
    const hints: PaneHint[] = [
      ...(selected ? [
        { id: "supply", key: "s", label: "upply chain", onPress: () => openSupply(selected) },
        { id: "earnings", key: "e", label: "arnings", onPress: () => createPaneFromTemplate("earnings-calendar-pane", { arg: selected.company }) },
      ] : []),
      ...(truncated.length ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: openUpgrade }] : []),
    ];
    return { info: [
      ...(ripple.loading ? [{ id: "loading", parts: [{ text: "loading disclosures", tone: "muted" as const }] }] : []),
      ...(ripple.data?.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
    ], hints };
  }, [ripple.loading, ripple.data?.stale, selected, openSupply, createPaneFromTemplate, truncated.length, openUpgrade]);

  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    {!holdings.length ? <EmptyState title="Add tickers to a portfolio or watchlist, or name them in pane settings." />
      : <PaneStatusBody subject="earnings ripple" loading={ripple.loading && !ripple.data} error={!ripple.data ? ripple.error : null}
        empty={!!ripple.data && !rows.length} emptyTitle={`No disclosed customer or supplier of these holdings reports in the next ${RIPPLE_DAYS} days.`}>
        <DataTableView<RippleRow> focused={focused} columns={COLUMNS} items={rows} rootWidth={width} rootHeight={height}
          getItemKey={(row) => row.id} emptyStateTitle="No reports." sortColumnId={null} sortDirection="asc"
          selection={{ kind: "id", selectedId: selected?.id ?? null, getId: (row) => row.id, onChange: setSelectedId }}
          onActivate={openSupply}
          getExportMetadata={() => [["window", `${ripple.data?.from} to ${ripple.data?.to}`], ["revenue share", "percent of the seller's revenue, as its filing discloses"]]}
          renderCell={renderCell} />
      </PaneStatusBody>}
  </Box>;
}
