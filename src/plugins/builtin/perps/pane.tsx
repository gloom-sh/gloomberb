import { openFormModal } from "../../../components/form-modal";
import { getSharedRegistry } from "../../registry/shared";
import { useCallback, useMemo } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { PerpBoardRow, PerpBoardPayload } from "../../../api-client/perps";
import { ChartTableHeader, DataTableView, EmptyState, KeyValueRow, SectionHeading, PaneStatusBody, QueryBar, useChartTableSelection,
  usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, useQueryBarSearch, type DataTableCell, type PaneHint } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, useRendererHost, useUiCapabilities } from "../../../ui";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { UpgradeLabel } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedPerps, fetchPerpsRankings, fetchPerpsMarket, loadPerps, loadPerpsCompare, loadPerpsHistory, RANKING_KEYS, validatePerpsBoard } from "./client";
import { ASSET_FILTERS, BOARD_COLUMNS, boardColumns, boardRows, compact, fundingInterval, HISTORY_COLUMNS, historyRows, historySeries,
  historyValue, label, marketLabel, venueLabel, PERP_TABS, percent, price, time, type HistoryMetric, type PerpSort, type PerpTab } from "./model";

const RANKINGS = { fundingPositive: "Positive funding", fundingNegative: "Negative funding", oiSurges: "OI surges", premiumDislocations: "Oracle dislocations", closedMarketDislocations: "Closed-market dislocations" };
function MarketEvidence({ row, accessKey, width, height, focused }: { row: PerpBoardRow; accessKey: string; width: number; height: number; focused: boolean }) {
  const loader = useCallback(() => fetchPerpsMarket(row.marketId), [row.marketId, accessKey]);
  const evidence = useAsyncResource(loader, { clearOnError: isAccessDenied });
  usePaneStatusFooter({ registrationId: "perps:evidence", loading: evidence.loading, error: evidence.error });
  usePaneRefreshKey(() => void evidence.reload(), { focused });
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const fields: [string, string, string?][] = [
    ["Venue", venueLabel(row)], ["Contract symbol", row.symbol],
    ["Observed", time(row.observedAt)], ["Source as of", time(row.sourceAsOf)],
    ["Mark", `${price(row.markPrice)} ${row.quoteCurrency}`], ["Oracle", `${price(row.oraclePrice)} ${row.quoteCurrency}`],
    ["Premium vs oracle", percent(row.premium)], ["Funding", `${percent(row.fundingRate, 5)} / ${fundingInterval(row)}`, row.fundingKind === "last-paid" ? "Last paid" : row.fundingKind === "continuous" ? "Continuous rate" : "Current rate"],
    ["Funding 8h / APR", `${percent(row.fundingRate8h, 4)} / ${percent(row.fundingApr, 2)}`],
    ["Predicted funding", row.predictedFundingRate == null ? "Unavailable" : `${percent(row.predictedFundingRate)} / ${row.predictedFundingIntervalHours ?? "--"}h`],
    ["Next funding", time(row.nextFundingAt)], ["Open interest", `${compact(row.openInterestBase)} ${row.baseAsset} · ${compact(row.openInterestUsd)} USD`],
    ["OI change 1h / 24h", `${percent(row.oiChange1h, 2)} / ${percent(row.oiChange24h, 2)}`, "Own snapshots"],
    ["Underlying last", row.underlying ? `${price(row.underlying.price)} ${row.underlying.currency}` : "Unavailable", row.underlying ? time(row.underlying.asOf) : undefined],
    ["Underlying session", row.underlying?.marketState ?? "Unknown"], ["Premium vs underlying", percent(row.underlyingPremium)],
    ["Closed-market premium", percent(row.closedMarketPremium)], ["Contract", `${label(row.contractType)} · ${row.priceMultiplier}× price`],
    ["Margin", row.marginCurrency], ["Max leverage", row.maxLeverage == null ? "--" : `${row.maxLeverage}×`],
    ["Margin mode", row.isolatedOnly === null ? "Unspecified" : row.isolatedOnly ? "Isolated only" : "Cross / isolated"],
    ["Listing", row.delisted ? "Delisted" : "Active"], ["Confidence", label(row.confidence)],
  ];
  return <ScrollBox width={width} height={desktop ? undefined : height} flexGrow={1} flexBasis={0} minHeight={0} contentOptions={{ paddingX: 1 }}>
    {fields.map(([name, value, detail]) => <KeyValueRow key={name} labelWidth={25} label={name} value={value} detail={detail} />)}
    {evidence.data?.evidence.length ? <SectionHeading title="Observation revisions" /> : null}
    {evidence.data?.evidence.map((entry) => <KeyValueRow key={entry.fingerprint} labelWidth={25} label={time(entry.period_at)}
      value={`${label(entry.kind)} · ${entry.superseded_at ? "Superseded" : "Current"}`}
      detail={`received ${time(entry.received_at)}${entry.superseded_at ? ` · corrected ${time(entry.superseded_at)}` : ""}`} />)}
  </ScrollBox>;
}
function History({ market, accessKey, width, height, focused, range, metric }: { market: PerpBoardRow; accessKey: string; width: number; height: number; focused: boolean; range: string; metric: HistoryMetric }) {
  const colors = useThemeColors();
  const query = useMemo(() => ({ marketId: market.marketId, from: new Date(Date.now() - Number(range) * 86_400_000).toISOString(), resolution: "auto" as const, limit: 3000 }), [market.marketId, range]);
  const loader = useCallback((force: boolean) => loadPerpsHistory(query, accessKey, force), [query, accessKey]);
  const resource = useAsyncResource(loader, { clearOnError: isAccessDenied });
  const data = resource.data?.payload;
  const rows = useMemo(() => historyRows(data, metric), [data, metric]);
  const [selectedId, setSelected] = usePluginPaneState<string | null>("perps:history-point", null);
  const selected = rows.find((row) => row.time === selectedId) ?? rows.at(-1);
  const link = useChartTableSelection({ rows, getId: (row) => row.time, getDate: (row) => row.value == null ? null : new Date(row.time), selectedId: selected?.time ?? null, onSelect: setSelected, focused });
  const series = useMemo(() => historySeries(data, metric, marketLabel(market), colors.warning), [data, metric, market, colors.warning]);
  const upgrade = useCloudUpgradeAction("perp");
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  usePaneRefreshKey(() => void resource.reload(), { focused });
  usePaneStatusFooter({ registrationId: "perps:history", loading: resource.loading && !data, error: resource.error, stale: resource.data?.stale });
  usePaneNoticeFooter({ registrationId: "perps:history-notice", focused, notices: resource.data?.refreshError ? [resource.data.refreshError] : [] });
  const figures = [{ id: "latest", label: metric === "funding" ? "Funding / 8h" : metric === "oi" ? "Open interest USD" : metric === "premium" ? "Premium vs oracle" : `Price ${market.quoteCurrency}`, value: historyValue(rows.at(-1)?.value, metric) },
    { id: "change", label: "Period change", value: historyValue(rows.length > 1 && rows[0]!.value != null && rows.at(-1)!.value != null ? rows.at(-1)!.value! - rows[0]!.value! : null, metric), detail: metric === "premium" || metric === "funding" ? "percentage points" : undefined }];
  return <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} subject="perpetual history" empty={!!data && !rows.length}
    emptyTitle={data?.locked ? "Full history requires Gloom Pro." : "History is accumulating from the first observation."}>
    <DataTableView columns={HISTORY_COLUMNS} items={rows} focused={focused} rootWidth={width} rootHeight={height} getItemKey={(row) => row.time} sortColumnId="time" sortDirection="asc"
      selection={{ kind: "id", selectedId: selected?.time ?? null, getId: (row) => row.time, onChange: setSelected }}
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={HISTORY_COLUMNS} figures={figures}
        chart={resource.error ? null : { series, formatValue: (n) => historyValue(n, metric), remoteKind: "perpetual-history", ...link,
          viewport: rows.length > 1 ? { start: new Date(rows[0]!.time), end: new Date(rows.at(-1)!.time) } : undefined,
          formatAxisValue: (n, domain) => metric === "funding" || metric === "premium" ? `${(n * 100).toFixed(Math.max(2, Math.min(6, Math.ceil(-Math.log10(Math.abs(domain.max - domain.min) * 100 / 4)))))}%` : historyValue(n, metric),
          loading: !data && resource.loading, empty: rows.length < 3 ? "History is accumulating from the first observation." : undefined }} />}
      renderCell={(row, column) => column.id === "time" ? { text: time(row.time), value: row.time }
        : column.id === "basis" ? { text: row.basis, color: colors.textDim }
          : { text: historyValue(column.id === "change" ? row.change : row.value, metric), value: (column.id === "change" ? row.change : row.value) == null ? null : (column.id === "change" ? row.change! : row.value!) * (["funding", "premium"].includes(metric) ? 100 : 1) }}
      emptyStateTitle={data?.access === "preview" ? "Full history requires Gloom Pro." : "History is accumulating from the first observation."}
      bodyAfter={data?.locked ? <UpgradeLabel text="Upgrade for full history" onPress={upgrade} role="perps-history-upgrade" /> : undefined} />
  </PaneStatusBody>;
}

export function PerpsPane({ width, height, focused, embedded = false }: Pick<PaneProps, "width" | "height" | "focused"> & { embedded?: boolean }) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "pro" : "preview"}`;
  const { createPaneFromTemplate, notify } = usePluginAppActions();
  const upgrade = useCloudUpgradeAction("perp");
  const [snapshotSetting] = usePaneSettingValue<PerpBoardPayload | null>("perpsSnapshot", null);
  const snapshot = useMemo(() => { try { return snapshotSetting ? validatePerpsBoard(snapshotSetting) : null; } catch { return null; } }, [snapshotSetting]);
  const loader = useCallback((force: boolean) => snapshot ? Promise.resolve({ payload: snapshot, stale: false, refreshError: null }) : loadPerps(accessKey, force), [accessKey, snapshot]);
  const resource = useAsyncResource(loader, { initialData: () => cachedPerps(accessKey), clearOnError: isAccessDenied });
  const data = resource.data?.payload;
  const [openingTab] = usePaneSettingValue("tab", "board");
  const [savedTab, setTab] = usePluginPaneState<string>("perps:tab", openingTab);
  const tab = PERP_TABS.includes(savedTab as PerpTab) ? savedTab as PerpTab : "board";
  const [openingSearch] = usePaneSettingValue("market", "");
  const [search, setSearch] = usePluginPaneState<string>("perps:search", openingSearch);
  const [openingAsset] = usePaneSettingValue("asset", "all");
  const [asset, setAsset] = usePluginPaneState<string>("perps:asset", openingAsset);
  const [selectedId, setSelected] = usePluginPaneState<string | null>("perps:selected", null);
  const [sort, setSort] = usePluginPaneState<PerpSort>("perps:sort", { column: "openInterestUsd", direction: "desc" });
  const [ranking, setRanking] = usePluginPaneState<string>("perps:ranking", "fundingPositive");
  const [range, setRange] = usePluginPaneState<string>("perps:range", "7");
  const [metricValue, setMetric] = usePluginPaneState<string>("perps:metric", "funding");
  const metric: HistoryMetric = ["funding", "oi", "premium", "price"].includes(metricValue) ? metricValue as HistoryMetric : "funding";
  const querySearch = useQueryBarSearch();
  const filtered = useMemo(() => boardRows(data?.rows ?? [], asset, search, sort), [data, asset, search, sort]);
  const selected = filtered.find((row) => row.marketId === selectedId) ?? filtered[0] ?? null;
  const rankingsLoader = useCallback(() => fetchPerpsRankings(), [accessKey]);
  const rankings = useAsyncResource(tab === "rankings" ? rankingsLoader : null, { clearOnError: isAccessDenied });
  const compareLoader = useCallback((force: boolean) => loadPerpsCompare(selected!.baseAsset, accessKey, force), [selected?.baseAsset, accessKey]);
  const compare = useAsyncResource(tab === "compare" && selected ? compareLoader : null, { clearOnError: isAccessDenied });
  const rankKey = RANKING_KEYS.includes(ranking as typeof RANKING_KEYS[number]) ? ranking as typeof RANKING_KEYS[number] : "fundingPositive";
  const rankingRows = rankings.data?.[rankKey] ?? [];
  const rows = tab === "rankings" ? boardRows(rankingRows, asset, search, sort).sort((a, b) => rankingRows.indexOf(a) - rankingRows.indexOf(b))
    : tab === "compare" ? boardRows(compare.data?.payload.rows ?? [], "all", "", sort) : filtered;
  const active = rows.find((row) => row.marketId === selectedId) ?? selected;
  const tabConfig = { tabs: PERP_TABS.map((value) => ({ value, label: label(value) })), activeValue: tab, onSelect: setTab, focused, dense: true, ...(embedded ? { queryBarWidth: width } : {}) };
  const { strip, rows: tabRows } = usePaneTabs(tabConfig);
  const reload = useCallback(() => { void resource.reload(); if (tab === "rankings") void rankings.reload(); if (tab === "compare") void compare.reload(); }, [resource.reload, rankings.reload, compare.reload, tab]);
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  usePaneRefreshKey(reload, { focused: focused && tab !== "history" });
  const navigate = (template: string) => { if (active?.underlyingSymbol) createPaneFromTemplate(template, { symbol: active.underlyingSymbol, arg: active.underlyingSymbol }); };
  const hints: PaneHint[] = [
    ...(active && getSharedRegistry()?.commands.has("set-event-alert") ? [{ id: "alert", key: "a", label: "lert", onPress: () => {
      if (!openFormModal({ kind: "plugin-command", commandId: "set-event-alert", values: { event: "perps_threshold", "perps_threshold:marketId": active.marketId } })) notify({ body: "Open this from the main window.", type: "info" });
    } }] : []),
    ...(active ? [{ id: "evidence", key: "e", label: "vidence", onPress: () => setTab("evidence") }, { id: "source", key: "o", label: "pen source", onPress: () => void host.openExternal(active.sourceUrl) }] : []),
    ...(active?.underlyingSymbol ? [{ id: "description", key: "d", label: "es", onPress: () => navigate("new-ticker-detail-pane") }, { id: "financials", key: "f", label: "a", onPress: () => navigate("financial-analysis-pane") }, { id: "graph", key: "g", label: "raph", onPress: () => navigate("chart-composer-pane") }] : []),
    ...(data?.access === "preview" ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: upgrade }] : []),
  ];
  usePaneStatusFooter({ registrationId: "perps", loading: resource.loading && !data, error: data ? resource.error : null, stale: resource.data?.stale || !!active?.stale,
    info: data?.asOf ? [{ id: "asof", parts: [{ text: time(data.asOf), tone: "muted" }] }] : [], hints });
  usePaneNoticeFooter({ registrationId: "perps:notices", focused, notices: [resource.data?.refreshError, rankings.error, compare.error,
    ...(active?.qualityFlags.map((flag) => flag.replaceAll("_", " ").replaceAll("-", " ")) ?? [])].filter((s): s is string => !!s) });
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall action="view perpetual markets" needsVerification={session.needsVerification} />;
  const query = <QueryBar width={width} search={{ focused, value: search, onChange: (value) => { setSearch(value); setSelected(null); }, placeholder: "Market or underlying", ...querySearch.searchProps }}
    filters={[{ id: "asset", label: "Asset", value: asset, defaultValue: "all", options: ASSET_FILTERS.map((value) => ({ value, label: label(value) })), onChange: (value: string) => { setAsset(value); setSelected(null); } },
      ...(tab === "history" || tab === "evidence" || tab === "compare" ? [{ id: "market", label: "Market", value: selected?.marketId ?? "", options: filtered.map((row) => ({ value: row.marketId, label: marketLabel(row) })), onChange: setSelected }] : []),
      ...(tab === "rankings" ? [{ id: "ranking", label: "Rank", value: rankKey, options: RANKING_KEYS.map((value) => ({ value, label: RANKINGS[value] })), onChange: setRanking }] : []),
      ...(tab === "history" ? [{ id: "metric", label: "Series", value: metric, options: ["funding", "oi", "premium", "price"].map((value) => ({ value, label: value === "oi" ? "OI" : label(value) })), onChange: setMetric },
        { id: "range", label: "Range", value: range, options: ["1", "7", "30", "90", "365"].map((value) => ({ value, label: `${value}D` })), onChange: setRange }] : [])]} />;
  const renderCell = (row: PerpBoardRow, column: typeof BOARD_COLUMNS[number]): DataTableCell => {
    if (column.id === "venue") return { text: venueLabel(row) };
    if (column.id === "contractType") return { text: `${label(row.contractType)} / ${row.marginCurrency}` };
    if (column.id === "market") return { text: marketLabel(row), color: row.stale ? colors.textDim : colors.textBright };
    if (column.id === "quoteCurrency") return { text: row.quoteCurrency, color: colors.textDim };
    if (column.id === "interval") return { text: fundingInterval(row), color: colors.textDim };
    const value = (row as unknown as Record<string, number | null>)[column.id] ?? null;
    const isPrice = column.id === "markPrice", isAmount = ["openInterestUsd", "volume24hUsd"].includes(column.id);
    return { text: isPrice ? price(value) : isAmount ? compact(value) : percent(value, column.id === "fundingApr" || column.id === "oiChange24h" ? 2 : column.id === "fundingRate" ? 5 : column.id === "fundingRate8h" ? 4 : 3), value: value === null ? null : value * (isPrice || isAmount ? 1 : 100),
      color: !isPrice && !isAmount && value != null ? value < 0 ? colors.negative : value > 0 ? colors.positive : colors.text : colors.text };
  };
  const columns = boardColumns(width, tab === "compare");
  const bodyHeight = Math.max(3, height - tabRows);
  const locked = tab === "rankings" ? rankings.data?.locked : tab === "compare" ? compare.data?.payload.locked : data?.locked;
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} subject="perpetual markets">
      {tab === "history" || tab === "evidence" ? <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
        {query}
        {selected ? tab === "history" ? <History key={selected.marketId} market={selected} accessKey={accessKey} width={width} height={bodyHeight - 1} focused={focused && !querySearch.active} range={range} metric={metric} />
          : <MarketEvidence row={selected} accessKey={accessKey} width={width} height={bodyHeight - 1} focused={focused} /> : <EmptyState title="No market matches." />}
      </Box> : <PaneStatusBody loading={tab === "rankings" ? rankings.loading && !rankings.data : tab === "compare" ? compare.loading && !compare.data : false}
        error={tab === "rankings" && !rankings.data ? rankings.error : tab === "compare" && !compare.data ? compare.error : null} subject={tab === "rankings" ? "perpetual rankings" : "market comparison"}>
        <DataTableView columns={columns} items={rows} rootWidth={width} rootHeight={bodyHeight} focused={focused && !querySearch.active}
          rootBefore={query} getItemKey={(row) => row.marketId} selection={{ kind: "id", selectedId: active?.marketId ?? null, getId: (row) => row.marketId, onChange: setSelected }}
          renderCell={renderCell} onActivate={(row) => { setSelected(row.marketId); setTab("history"); }} selectedTextOverridesCellColor
          showHorizontalScrollbar freezeFirstColumn sortable={tab !== "rankings"} sortColumnId={tab === "rankings" ? null : sort.column} sortDirection={sort.direction}
          onSortChange={(column, direction) => setSort({ column, direction })}
          onHeaderClick={tab === "rankings" ? undefined : (column) => setSort((old) => ({ column, direction: old.column === column && old.direction === "desc" ? "asc" : "desc" }))}
          resetScrollKey={`${tab}:${asset}:${search}:${ranking}`} emptyStateTitle="No markets match."
          bodyAfter={locked ? <UpgradeLabel text="Upgrade to see every market" onPress={upgrade} role="perps-upgrade" /> : undefined} />
      </PaneStatusBody>}
    </PaneStatusBody>
  </Box>;
}
