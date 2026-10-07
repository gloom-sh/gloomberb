import { Fragment, useCallback, useMemo } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { PerpBoardRow, PerpMarketPayload } from "../../../api-client/perps";
import { ChartTableHeader, DataTableView, EmptyState, KeyValueRow, SectionHeading, PaneStatusBody, QueryBar, StatGrid, useChartTableSelection,
  usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, useQueryBarSearch, type PaneHint, type StatItem } from "../../../components";
import { openFormModal } from "../../../components/form-modal";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePaneTitle, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, useRendererHost, useUiCapabilities } from "../../../ui";
import { getSharedRegistry } from "../../registry/shared";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { UpgradeLabel } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedPerpSelection, loadPerpSelection, loadPerpsHistoryForRange } from "./client";
import { compact, fundingInterval, historyCaption, historyCell, historyChange, historyColumns, historyRows, historySeries,
  historyValue, label, marketLabel, venueLabel, PERP_TABS, percent, price, time, type HistoryMetric, type PerpTab } from "./model";

function MarketEvidence({ row, data, width, height }: { row: PerpBoardRow; data: PerpMarketPayload; width: number; height: number }) {
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const upgrade = useCloudUpgradeAction("perp");
  // Grouped as a trader reads a contract; a stock reference only for a market that has one.
  const groups: Array<[string, Array<[string, string, string?]>]> = [
    ["Market", [["Venue", venueLabel(row)], ["Contract symbol", row.symbol], ["Observed", time(row.observedAt)], ["Source as of", time(row.sourceAsOf)],
      ["Mark", `${price(row.markPrice)} ${row.quoteCurrency}`], ["Oracle", `${price(row.oraclePrice)} ${row.quoteCurrency}`], ["Premium vs oracle", percent(row.premium)]]],
    ["Funding", [["Funding", `${percent(row.fundingRate, 5)} / ${fundingInterval(row)}`, row.fundingKind === "last-paid" ? "Last paid" : row.fundingKind === "continuous" ? "Continuous rate" : "Current rate"],
      ["Funding 8h / APR", `${percent(row.fundingRate8h, 4)} / ${percent(row.fundingApr, 2)}`],
      ...(row.predictedFundingRate != null ? [["Predicted funding", `${percent(row.predictedFundingRate)} / ${row.predictedFundingIntervalHours ?? "--"}h`] as [string, string]] : []),
      ...(row.nextFundingAt ? [["Next funding", time(row.nextFundingAt)] as [string, string]] : [])]],
    ["Open Interest", [["Open interest", `${compact(row.openInterestBase)} ${row.baseAsset} · ${compact(row.openInterestUsd)} USD`],
      ["OI change 1h / 24h", row.oiChange1h == null && row.oiChange24h == null ? "Collecting" : `${percent(row.oiChange1h, 2)} / ${percent(row.oiChange24h, 2)}`, "own snapshots"]]],
    ...(row.underlying ? [["Underlying", [["Underlying last", `${price(row.underlying.price)} ${row.underlying.currency}`, time(row.underlying.asOf)], ["Underlying session", row.underlying.marketState ?? "Unknown"],
      ["Premium vs underlying", percent(row.underlyingPremium)], ["Closed-market premium", percent(row.closedMarketPremium)]]] as [string, Array<[string, string, string?]>]] : []),
    ["Contract", [["Contract", `${label(row.contractType)} · ${row.priceMultiplier}× price`], ["Margin", row.marginCurrency], ["Max leverage", row.maxLeverage == null ? "--" : `${row.maxLeverage}×`],
      ["Margin mode", row.isolatedOnly === null ? "Unspecified" : row.isolatedOnly ? "Isolated only" : "Cross / isolated"], ["Listing", row.delisted ? "Delisted" : "Active"], ["Confidence", label(row.confidence)]]],
  ];
  return <ScrollBox width={width} height={desktop ? undefined : height} flexGrow={1} flexBasis={0} minHeight={0} contentOptions={{ paddingX: 1 }}>
    {groups.map(([title, fields]) => <Fragment key={title}>
      <SectionHeading title={title} />
      {fields.map(([name, value, detail]) => <KeyValueRow key={name} labelWidth={25} label={name} value={value} detail={detail} />)}
    </Fragment>)}
    {data.evidence.length ? <SectionHeading title="Observation Revisions" /> : null}
    {data.evidence.map((entry) => {
      const saved = entry.payload;
      return <Fragment key={`${entry.kind}:${entry.period_at}:${entry.received_at}:${entry.fingerprint}`}>
        <KeyValueRow labelWidth={25} label={time(entry.period_at)} value={`${label(entry.kind)} · ${entry.superseded_at ? "Superseded" : "Current"}`}
          detail={`received ${time(entry.received_at)}${entry.superseded_at ? ` · corrected ${time(entry.superseded_at)}` : ""}`} />
        {"markPrice" in saved ? <>
          <KeyValueRow labelWidth={25} label="Recorded mark / oracle" value={`${price(saved.markPrice)} / ${price(saved.oraclePrice)} ${saved.quoteCurrency}`} />
          <KeyValueRow labelWidth={25} label="Recorded funding / OI" value={`${percent(saved.fundingRate, 5)} / ${fundingInterval(saved)} · ${compact(saved.openInterestUsd)} USD`} />
        </> : "rate" in saved ? <KeyValueRow labelWidth={25} label="Recorded funding" value={`${percent(saved.rate, 5)} / ${saved.intervalHours}h paid`} />
          : "close" in saved ? <>
            <KeyValueRow labelWidth={25} label="Recorded open / close" value={`${price(saved.open)} / ${price(saved.close)} ${row.quoteCurrency}`} />
            <KeyValueRow labelWidth={25} label="Recorded high / low" value={`${price(saved.high)} / ${price(saved.low)} ${row.quoteCurrency}`} />
          </> : null}
      </Fragment>;
    })}
    {data.access === "preview" ? <UpgradeLabel text="Upgrade for observation revisions" onPress={upgrade} role="perps-evidence-upgrade" /> : null}
  </ScrollBox>;
}

function History({ market, accessKey, width, height, focused, range, metric, refreshMarket }: {
  market: PerpBoardRow; accessKey: string; width: number; height: number; focused: boolean; range: string; metric: HistoryMetric; refreshMarket: () => void;
}) {
  const colors = useThemeColors();
  const loader = useCallback((force: boolean) => loadPerpsHistoryForRange(market.marketId, Number(range), accessKey, force), [market.marketId, range, accessKey]);
  const resource = useAsyncResource(loader, { clearOnError: isAccessDenied });
  const data = resource.data?.payload;
  const rows = useMemo(() => historyRows(data, metric), [data, metric]);
  const columns = useMemo(() => historyColumns(metric, market.quoteCurrency, !!data?.candles.length), [metric, market.quoteCurrency, data?.candles.length]);
  const [selectedId, setSelected] = usePluginPaneState<string | null>("perps:history-point", null);
  const selected = rows.find((row) => row.time === selectedId) ?? rows.at(-1);
  const link = useChartTableSelection({ rows, getId: (row) => row.time, getDate: (row) => row.value == null ? null : new Date(row.time), selectedId: selected?.time ?? null, onSelect: setSelected, focused });
  const series = useMemo(() => historySeries(data, metric, marketLabel(market), colors.warning), [data, metric, market, colors.warning]);
  const upgrade = useCloudUpgradeAction("perp");
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  usePaneRefreshKey(() => { refreshMarket(); void resource.reload(); }, { focused });
  const lastTime = rows.at(-1)?.time;
  usePaneStatusFooter({ registrationId: "perps:history", loading: resource.loading, error: resource.error, stale: resource.data?.stale,
    info: lastTime ? [{ id: "history-asof", parts: [{ text: `${historyCaption(data, metric)} · ${time(lastTime)}`, tone: "muted" }] }] : [] });
  usePaneNoticeFooter({ registrationId: "perps:history-notice", focused, notices: [resource.data?.refreshError,
    data?.truncated ? "History reached the 5,000-observation limit. Narrow the range for all observations." : null].filter((value): value is string => !!value) });
  const periodChange = rows.length > 1 && rows[0]!.value != null && rows.at(-1)!.value != null ? rows.at(-1)!.value! - rows[0]!.value! : null;
  // The same four figures on every series: the series itself, its move over the range, and the market around it.
  const figures: StatItem[] = [
    { id: "latest", label: metric === "funding" ? "Funding / 8h" : metric === "oi" ? "Open interest USD" : metric === "premium" ? "Oracle premium" : `Price ${market.quoteCurrency}`,
      value: rows.length ? historyValue(rows.at(-1)?.value, metric) : metric === "funding" ? percent(market.fundingRate8h, 4) : metric === "oi" ? compact(market.openInterestUsd) : metric === "premium" ? percent(market.premium) : price(market.markPrice),
      // Annualised from the shown 8h rate, so the detail always agrees with the value beside it.
      ...(metric === "funding" && rows.at(-1)?.value != null ? { detail: `${percent(rows.at(-1)!.value! * 3 * 365, 1)} APR` } : {}) },
    ...(periodChange !== null ? [{ id: "change", label: `${range}D change`, value: historyChange(periodChange, metric), color: periodChange === 0 ? colors.textMuted : periodChange > 0 ? colors.positive : colors.negative }] : []),
    ...(metric !== "price" ? [{ id: "mark", label: `Mark ${market.quoteCurrency}`, value: price(market.markPrice) }] : []),
    ...(metric !== "oi" ? [{ id: "oi", label: "Open interest USD", value: compact(market.openInterestUsd) }] : []),
  ].slice(0, 4);
  // A series with one basis says it in the legend; the column only appears when the basis changes along the range.
  const oneBasis = rows.every((row) => row.basis === rows[0]?.basis);
  const shownColumns = oneBasis ? columns.filter((column) => column.id !== "basis") : columns;
  if (data?.locked) return <Box flexDirection="column" flexGrow={1}>
    <StatGrid width={width} items={figures} />
    <Box paddingX={1} paddingTop={1}><EmptyState title="Full history requires Gloom Pro." actions={<UpgradeLabel text="Upgrade for full history" onPress={upgrade} role="perps-history-upgrade" />} /></Box>
  </Box>;
  return <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} subject="perpetual history">
    <DataTableView columns={shownColumns} items={rows} focused={focused} rootWidth={width} rootHeight={height} getItemKey={(row) => row.time} sortColumnId="time" sortDirection="asc"
      selection={{ kind: "id", selectedId: selected?.time ?? null, getId: (row) => row.time, onChange: setSelected }} selectedTextOverridesCellColor
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={shownColumns} figures={figures}
        chart={{ series: rows.length ? series : [], formatValue: (n) => historyValue(n, metric), remoteKind: "perpetual-history", ...link,
          viewport: rows.length > 1 ? { start: new Date(rows[0]!.time), end: new Date(rows.at(-1)!.time) } : undefined,
          formatAxisValue: (n, domain) => metric === "funding" || metric === "premium" ? `${(n * 100).toFixed(Math.max(2, Math.min(6, Math.ceil(-Math.log10(Math.abs(domain.max - domain.min) * 100 / 4)))))}%` : historyValue(n, metric),
          loading: !data && resource.loading, empty: rows.length < 3 ? COLLECTING[metric] : undefined }} />}
      renderCell={(row, column) => historyCell(row, column.id, metric, colors)}
      getExportMetadata={() => [["As of", lastTime ?? ""], ["Market", market.marketId], ["Series", historyCaption(data, metric)], ["Source", market.sourceUrl],
        ["Retrieved", data?.asOf ?? ""], ["Funding basis", `${fundingInterval(market)}; every history point uses its own recorded interval`],
        ["Units", metric === "funding" || metric === "premium" ? "percent; changes in percentage points" : metric === "oi" ? "USD" : market.quoteCurrency]]}
      emptyStateTitle="History is accumulating from the first observation." />
  </PaneStatusBody>;
}

const COLLECTING: Record<HistoryMetric, string> = { funding: "Collecting funding history", oi: "Collecting open interest from our own snapshots",
  premium: "Collecting oracle premium from our own snapshots", price: "Collecting price history" };

// Optional host action boundary: no external plugin or trading dependency is registered here.
interface PerpMarketAction {
  id: string;
  key: string;
  label: string;
  onPress: (market: PerpBoardRow) => void;
}
export function PerpsPane({ width, height, focused, marketAction }: Pick<PaneProps, "width" | "height" | "focused"> & { marketAction?: PerpMarketAction }) {
  const host = useRendererHost();
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "pro" : "preview"}`;
  const { createPaneFromTemplate, notify } = usePluginAppActions();
  const upgrade = useCloudUpgradeAction("perp");
  const [openingTab] = usePaneSettingValue("tab", "history");
  const [savedTab, setTab] = usePluginPaneState<string>("perps:tab", openingTab);
  const tab = PERP_TABS.includes(savedTab as PerpTab) ? savedTab as PerpTab : "history";
  const [openingSearch] = usePaneSettingValue("market", "BTC");
  const [search, setSearch] = usePluginPaneState<string>("perps:search", openingSearch);
  const [openingRange] = usePaneSettingValue("days", "7");
  const [range, setRange] = usePluginPaneState<string>("perps:range", openingRange);
  const [openingMetric] = usePaneSettingValue("metric", "funding");
  const [metricValue, setMetric] = usePluginPaneState<string>("perps:metric", openingMetric);
  const metric: HistoryMetric = ["funding", "oi", "premium", "price"].includes(metricValue) ? metricValue as HistoryMetric : "funding";
  const loader = useCallback((force: boolean) => loadPerpSelection(search, accessKey, force), [search, accessKey]);
  const resource = useAsyncResource(loader, { initialData: () => cachedPerpSelection(search, accessKey), clearOnError: isAccessDenied });
  const data = resource.data?.payload;
  const active = data?.rows[0] ?? null;
  usePaneTitle(active ? `PERP ${marketLabel(active)}` : "PERP");
  const querySearch = useQueryBarSearch();
  const { strip, rows: tabRows } = usePaneTabs({ tabs: PERP_TABS.map((value) => ({ value, label: label(value) })), activeValue: tab, onSelect: setTab, focused, dense: true });
  const refreshMarket = useCallback(() => { void resource.reload(); }, [resource.reload]);
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  usePaneRefreshKey(refreshMarket, { focused: focused && !querySearch.active && (tab !== "history" || !active) });
  const navigate = (template: string) => { if (active?.underlyingSymbol) createPaneFromTemplate(template, { symbol: active.underlyingSymbol, arg: active.underlyingSymbol }); };
  const hints: PaneHint[] = [
    ...(active && marketAction ? [{ id: marketAction.id, key: marketAction.key, label: marketAction.label, onPress: () => marketAction.onPress(active) }] : []),
    ...(active && getSharedRegistry()?.commands.has("set-event-alert") ? [{ id: "alert", key: "a", label: "lert", onPress: () => {
      if (!openFormModal({ kind: "plugin-command", commandId: "set-event-alert", values: { event: "perps_threshold", "perps_threshold:marketId": active.marketId } })) notify({ body: "Open this from the main window.", type: "info" });
    } }] : []),
    ...(active ? [{ id: "evidence", key: "e", label: "vidence", onPress: () => setTab("evidence") }, { id: "source", key: "o", label: "pen source", onPress: () => void host.openExternal(active.sourceUrl) }] : []),
    ...(active?.underlyingSymbol ? [{ id: "description", key: "d", label: "es", onPress: () => navigate("new-ticker-detail-pane") }, { id: "financials", key: "f", label: "a", onPress: () => navigate("financial-analysis-pane") }, { id: "graph", key: "g", label: "raph", onPress: () => navigate("chart-composer-pane") }] : []),
    ...(data?.access === "preview" ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: upgrade }] : []),
  ];
  usePaneStatusFooter({ registrationId: "perps", loading: resource.loading, error: data ? resource.error : null, stale: resource.data?.stale || !!active?.stale,
    info: active && (tab === "evidence" || data?.access === "preview") ? [{ id: "asof", parts: [{ text: time(active.observedAt), tone: "muted" }] }] : [], hints });
  usePaneNoticeFooter({ registrationId: "perps:notices", focused, notices: [resource.data?.refreshError,
    ...(active?.qualityFlags.map((flag) => flag.replaceAll("_", " ").replaceAll("-", " ")) ?? [])].filter((s): s is string => !!s) });
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall placement="perps-signin" action="view perpetual history" needsVerification={session.needsVerification} />;
  const bodyHeight = Math.max(3, height - tabRows - 1);
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <QueryBar width={width} search={{ focused, value: search, onChange: setSearch, placeholder: "Market or canonical identity", debounceMs: 300, ...querySearch.searchProps }}
      filters={tab === "history" ? [
        { id: "metric", label: "Series", value: metric, options: ["funding", "oi", "premium", "price"].map((value) => ({ value, label: value === "oi" ? "OI" : label(value) })), onChange: setMetric },
        { id: "range", label: "Range", value: range, options: ["1", "7", "30", "90", "365"].map((value) => ({ value, label: `${value}D` })), onChange: setRange },
      ] : []} />
    <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} subject="perpetual market">
      {active ? tab === "history" ? <History key={active.marketId} market={active} accessKey={accessKey} width={width} height={bodyHeight} focused={focused && !querySearch.active} range={range} metric={metric} refreshMarket={refreshMarket} />
        : <MarketEvidence row={active} data={data!} width={width} height={bodyHeight} /> : <EmptyState title="No market matches." />}
    </PaneStatusBody>
  </Box>;
}
