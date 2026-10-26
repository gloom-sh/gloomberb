import { useCallback, useMemo, type ReactNode } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import type { PerpDepthRow, PerpLiquidationMarket, PerpLiquidationPrint } from "../../../api-client/perps";
import { ChartTableHeader, DataTableView, PaneStatusBody, QueryBar, useChartTableSelection, usePaneNoticeFooter, usePaneStatusFooter, useQueryBarSearch } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Box } from "../../../ui";
import { SignInWall } from "../cloud/auth-actions";
import { useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { UpgradeLabel } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { depthCell, depthColumns, depthFigures, depthFreshness, depthHistoryCount, depthSeries, LIQUIDATION_VIEWS, liquidationCell, liquidationColumns, liquidationFigures,
  liquidationFreshness, liquidationSeries, printCell, printColumns, printHour, printKey, type DepthColumnId, type LiquidationColumnId, type LiquidationView, type PrintColumnId } from "./cascade";
import { cachedPerpsDepth, cachedPerpsLiquidations, loadPerpsDepth, loadPerpsLiquidations } from "./client";
import { compact } from "./model";
import { useFreshnessStatusLine } from "./status-line";

export interface CascadeTabProps {
  /** The base asset the tab shows, shared with Compare. */
  asset: string;
  onAssetChange: (asset: string) => void;
  accessKey: string;
  width: number;
  height: number;
  focused: boolean;
  /** Enter on a contract: its history. */
  onOpenMarket: (marketId: string) => void;
}

const stamp = (s: string | null | undefined) => s ? `${s.slice(5, 10)} ${s.slice(11, 16)} UTC` : "";
const magnitude = (n: number) => compact(Math.abs(n));
const HOUR = 3_600_000;

/** The preview's lock under the rows: what Pro adds to the tab. */
function Lock({ text, role, onPress }: { text: string; role: string; onPress: () => void }) {
  return <Box paddingX={1}><UpgradeLabel text={text} onPress={onPress} role={role} /></Box>;
}

/**
 * One base asset's liquidations across the venues' public streams: the 24-hour and 7-day totals, the hourly columns
 * (Pro), and the contracts or the largest prints below them. What each stream leaves out is in the data warnings.
 */
export function Liquidations({ asset, onAssetChange, accessKey, width, height, focused, onOpenMarket }: CascadeTabProps) {
  const colors = useThemeColors();
  const upgrade = useCloudUpgradeAction("perp");
  const session = useResearchCloudSession();
  const querySearch = useQueryBarSearch();
  const [viewValue, setView] = usePluginPaneState<string>("perps:liquidation-view", "contracts");
  const view: LiquidationView = viewValue === "prints" ? "prints" : "contracts";
  const [selectedMarket, setSelectedMarket] = usePluginPaneState<string | null>("perps:liquidation-market", null);
  const [selectedPrint, setSelectedPrint] = usePluginPaneState<string | null>("perps:liquidation-print", null);
  const base = asset.trim().toUpperCase() || "BTC";
  const loader = useCallback((force: boolean) => loadPerpsLiquidations(base, accessKey, force), [base, accessKey]);
  const resource = useAsyncResource(loader, { initialData: () => cachedPerpsLiquidations(base, accessKey), clearOnError: isAccessDenied, keepPreviousData: true });
  const data = resource.data?.payload;
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  usePaneRefreshKey(() => { void resource.reload(); }, { focused: focused && !querySearch.active });
  const declare = useCallback(() => data ? liquidationFreshness(data) : null, [data]);
  const line = useFreshnessStatusLine(declare, resource.updatedAt);
  usePaneStatusFooter({ registrationId: "perps:liquidations", loading: resource.loading, error: data ? resource.error : null, stale: resource.data?.stale, info: line });
  usePaneNoticeFooter({ registrationId: "perps:liquidations-notice", focused, title: "Liquidation streams",
    notices: [...resource.data?.refreshError ? [resource.data.refreshError] : [], ...data?.notes ?? []] });
  const markets = data?.markets ?? [];
  const prints = data?.largest ?? [];
  const market = markets.find((row) => row.marketId === selectedMarket) ?? markets[0] ?? null;
  const print = prints.find((row) => printKey(row) === selectedPrint) ?? prints[0] ?? null;
  // A print stands in its hour's column, so the chart's cursor follows the selected print.
  const link = useChartTableSelection({ rows: prints, getId: printKey, getDate: printHour, selectedId: print ? printKey(print) : null, onSelect: setSelectedPrint,
    focused: focused && !querySearch.active, enabled: view === "prints" });
  const series = useMemo(() => liquidationSeries(data, colors), [data, colors]);
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall placement="perps-signin" action="view perpetual liquidations" needsVerification={session.needsVerification} />;
  const pro = data?.access === "pro";
  const since = data?.collectingSince ? Date.parse(data.collectingSince) : null;
  const asOf = data ? Date.parse(data.asOf) : Date.now();
  // The chart starts where collection did, when that is inside the week: earlier hours are missing, not quiet.
  const start = data ? Math.max(Date.parse(data.from), since === null ? -Infinity : Math.floor(since / HOUR) * HOUR - HOUR) : 0;
  const quiet = data?.collectingSince && since! > Date.parse(data.from) ? `No liquidations since collection started ${stamp(data.collectingSince)}` : "No liquidations in the last 7 days";
  const chart = data && pro ? { series: data.hourly.length ? series : [], formatValue: magnitude, formatAxisValue: magnitude, remoteKind: "perpetual-liquidations",
    ...(view === "prints" ? link : {}), viewport: { start: new Date(start), end: new Date(Math.ceil(asOf / HOUR) * HOUR) },
    loading: !data && resource.loading, empty: data.hourly.length ? undefined : data.status === "unavailable" ? "Liquidations are not collected yet" : quiet } : null;
  const figures = data ? liquidationFigures(data, colors) : [];
  const contractColumns = liquidationColumns(width);
  const shownPrintColumns = printColumns(width, data?.baseAsset ?? base);
  const columns = view === "prints" ? shownPrintColumns : contractColumns;
  const rows = view === "prints" ? prints.length : markets.length;
  const before: ReactNode = <>
    <QueryBar width={width} search={{ focused, value: asset, onChange: (value) => { onAssetChange(value); setSelectedMarket(null); setSelectedPrint(null); }, placeholder: "Base asset", debounceMs: 300, ...querySearch.searchProps }}
      view={{ value: view, options: LIQUIDATION_VIEWS, onChange: setView }} />
    <ChartTableHeader width={width} height={height - 1} tableRows={rows} tableColumns={columns} figures={figures} chart={chart} />
  </>;
  const lock = data && !pro ? <Lock text="Upgrade for hourly liquidations and the 20 largest prints" onPress={upgrade} role="perps-liquidations-upgrade" /> : null;
  const metadata = () => [["As of", data?.asOf ?? ""], ["Base asset", data?.baseAsset ?? base], ["Collecting since", data?.collectingSince ?? ""],
    ["Units", "notional in USD, stablecoins counted as USD; longs are long positions liquidated (forced sells), shorts short positions (forced buys)"],
    ...(data?.notes ?? []).map((note) => ["Note", note])];
  const empty = data?.status === "unavailable" ? "Liquidations are not collected yet." : `No perpetual contracts for ${base} on a liquidation stream.`;
  return <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} subject="perpetual liquidations">
    {view === "prints"
      ? <DataTableView<PerpLiquidationPrint> columns={shownPrintColumns} items={prints} focused={focused && !querySearch.active} rootWidth={width} rootHeight={height} rootBefore={before}
        getItemKey={printKey} sortColumnId={null} sortDirection="desc" resetScrollKey={`${base}:prints`}
        selection={{ kind: "id", selectedId: print ? printKey(print) : null, getId: printKey, onChange: setSelectedPrint }} onActivate={(row) => onOpenMarket(row.marketId)}
        renderCell={(row, column) => printCell(row, column.id as PrintColumnId, colors)} selectedTextOverridesCellColor
        emptyStateTitle={data?.status === "unavailable" ? empty : "No liquidations in the last 7 days."} bodyAfter={lock} getExportMetadata={metadata} />
      : <DataTableView<PerpLiquidationMarket> columns={contractColumns} items={markets} focused={focused && !querySearch.active} rootWidth={width} rootHeight={height} rootBefore={before}
        getItemKey={(row) => row.marketId} sortColumnId={null} sortDirection="desc" resetScrollKey={`${base}:contracts`}
        selection={{ kind: "id", selectedId: market?.marketId ?? null, getId: (row) => row.marketId, onChange: setSelectedMarket }} onActivate={(row) => onOpenMarket(row.marketId)}
        renderCell={(row, column) => liquidationCell(row, column.id as LiquidationColumnId, colors)} selectedTextOverridesCellColor
        emptyStateTitle={empty} bodyAfter={lock} getExportMetadata={metadata} />}
  </PaneStatusBody>;
}

/**
 * One base asset's order books: the bids and asks resting within 0.5%, 1% and 2% of mid on each venue, read hourly.
 * Pro charts the selected book's 1% depth over the week. A band wider than the book a venue returns reads `≥`.
 */
export function Depth({ asset, onAssetChange, accessKey, width, height, focused, onOpenMarket }: CascadeTabProps) {
  const colors = useThemeColors();
  const upgrade = useCloudUpgradeAction("perp");
  const session = useResearchCloudSession();
  const querySearch = useQueryBarSearch();
  const [selectedId, setSelected] = usePluginPaneState<string | null>("perps:depth-selected", null);
  const base = asset.trim().toUpperCase() || "BTC";
  const loader = useCallback((force: boolean) => loadPerpsDepth(base, accessKey, force), [base, accessKey]);
  const resource = useAsyncResource(loader, { initialData: () => cachedPerpsDepth(base, accessKey), clearOnError: isAccessDenied, keepPreviousData: true });
  const data = resource.data?.payload;
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 300_000 });
  usePaneRefreshKey(() => { void resource.reload(); }, { focused: focused && !querySearch.active });
  const declare = useCallback(() => data?.rows.length ? depthFreshness(data) : null, [data]);
  const line = useFreshnessStatusLine(declare, resource.updatedAt);
  usePaneStatusFooter({ registrationId: "perps:depth", loading: resource.loading, error: data ? resource.error : null, stale: resource.data?.stale, info: line });
  usePaneNoticeFooter({ registrationId: "perps:depth-notice", focused, title: "Order book depth",
    notices: [...resource.data?.refreshError ? [resource.data.refreshError] : [], ...data?.notes ?? []] });
  const rows = data?.rows ?? [];
  const selected = rows.find((row) => row.marketId === selectedId) ?? rows[0] ?? null;
  const series = useMemo(() => depthSeries(data?.history ?? [], selected, colors), [data?.history, selected, colors]);
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall placement="perps-signin" action="view perpetual order book depth" needsVerification={session.needsVerification} />;
  const pro = data?.access === "pro";
  const columns = depthColumns(width);
  const points = depthHistoryCount(data?.history ?? [], selected?.marketId);
  // A chart that follows the selected book keeps its band on a book without history, and says so.
  const chart = data && pro && rows.length ? { series: points >= 3 ? series : [], formatValue: compact, formatAxisValue: compact, remoteKind: "perpetual-depth",
    empty: points >= 3 ? undefined : "Collecting hourly depth for this book" } : null;
  const before: ReactNode = <>
    <QueryBar width={width} search={{ focused, value: asset, onChange: (value) => { onAssetChange(value); setSelected(null); }, placeholder: "Base asset", debounceMs: 300, ...querySearch.searchProps }} />
    <ChartTableHeader width={width} height={height - 1} tableRows={rows.length} tableColumns={columns} figures={depthFigures(rows)} chart={chart} />
  </>;
  const lock = data && !pro ? <Lock text="Upgrade for hourly depth history" onPress={upgrade} role="perps-depth-upgrade" /> : null;
  return <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} subject="order book depth">
    <DataTableView<PerpDepthRow> columns={columns} items={rows} focused={focused && !querySearch.active} rootWidth={width} rootHeight={height} rootBefore={before}
      getItemKey={(row) => row.marketId} sortColumnId={null} sortDirection="desc" resetScrollKey={base}
      selection={{ kind: "id", selectedId: selected?.marketId ?? null, getId: (row) => row.marketId, onChange: setSelected }} onActivate={(row) => onOpenMarket(row.marketId)}
      renderCell={(row, column) => depthCell(row, column.id as DepthColumnId, colors)} selectedTextOverridesCellColor
      emptyStateTitle={data?.status === "unavailable" ? "Order book depth is not collected yet." : `No order book depth for ${base} yet.`} bodyAfter={lock}
      getExportMetadata={() => [["As of", data?.asOf ?? ""], ["Base asset", data?.baseAsset ?? base],
        ["Units", "quote notional in USD resting within the band of mid on each side; a value marked ≥ is a floor, the book returned ended inside the band; book reach in percent of mid"],
        ...(data?.notes ?? []).map((note) => ["Note", note])]} />
  </PaneStatusBody>;
}
