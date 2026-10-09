import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { PerpBoardRow, PerpMarketPayload } from "../../../api-client/perps";
import { buildSectionedRows, ChartTableHeader, DataTableView, EmptyState, KeyValueRow, SectionHeading, PaneStatusBody, QueryBar, StatGrid, useChartTableSelection,
  usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, useQueryBarSearch, type DataTableCell, type PaneHint, type SectionedRow, type StatItem } from "../../../components";
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
import { cachedPerpSelection, cachedPerpsBoard, cachedPerpsCompare, cachedPerpsRankings, loadPerpSelection, loadPerpsBoard, loadPerpsCompare,
  loadPerpsHistoryForRange, loadPerpsRankings } from "./client";
import { ASSET_FILTERS, BOARD_SORTS, boardColumns, compact, compareColumns, dayChange, fundingInterval, fundingSpread, historyCaption, historyCell, historyChange, historyColumns,
  HISTORY_METRICS, historyRows, historySeries, historyValue, inPoints, isMarketTab, label, longShortReason, marketLabel, metricLabel, openingTab, perpCell, PERP_TABS, percent,
  positioningFields, price, rankingColumns, rankingRows, RANKINGS, ratioText, share, sortLabel, time, venueLabel, venueName, venuesOf, type HistoryMetric, type PerpColumnId,
  type PerpTab, type RankingKey } from "./model";

function MarketEvidence({ row, data, width, height }: { row: PerpBoardRow; data: PerpMarketPayload; width: number; height: number }) {
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const upgrade = useCloudUpgradeAction("perp");
  const positioning = positioningFields(row);
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
    ...(positioning ? [["Positioning", positioning.map((field) => [field.label, field.text, field.detail])] as [string, Array<[string, string, string?]>]] : []),
    ...(row.underlying ? [["Underlying", [["Underlying last", `${price(row.underlying.price)} ${row.underlying.currency}`, time(row.underlying.asOf)], ["Underlying session", row.underlying.marketState ?? "Unknown"],
      ["Premium vs underlying", percent(row.underlyingPremium)], ["Closed-market premium", percent(row.closedMarketPremium)]]] as [string, Array<[string, string, string?]>]] : []),
    ["Contract", [["Contract", `${label(row.contractType)} · ${row.priceMultiplier}× price`], ["Margin", row.marginCurrency], ["Max leverage", row.maxLeverage == null ? "--" : `${row.maxLeverage}×`],
      ["Margin mode", row.isolatedOnly === null ? "Unspecified" : row.isolatedOnly ? "Isolated only" : "Cross / isolated"], ["Listing", row.delisted ? "Delisted" : "Active"], ["Confidence", label(row.confidence)]]],
  ];
  return <ScrollBox scrollY width={width} height={desktop ? undefined : height} flexGrow={1} flexBasis={0} minHeight={0} contentOptions={{ paddingX: 1 }}>
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
  // Venues count long and short accounts differently, so the long/short legend names the venue beside the definition.
  const seriesName = metric === "long-short" ? `${marketLabel(market)} · ${venueLabel(market)}` : marketLabel(market);
  const series = useMemo(() => historySeries(data, metric, seriesName, colors.warning), [data, metric, seriesName, colors.warning]);
  const upgrade = useCloudUpgradeAction("perp");
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  usePaneRefreshKey(() => { refreshMarket(); void resource.reload(); }, { focused });
  const lastTime = rows.at(-1)?.time;
  usePaneStatusFooter({ registrationId: "perps:history", loading: resource.loading, error: resource.error, stale: resource.data?.stale,
    info: lastTime ? [{ id: "history-asof", parts: [{ text: `${historyCaption(data, metric)} · ${time(lastTime)}`, tone: "muted" }] }] : [] });
  usePaneNoticeFooter({ registrationId: "perps:history-notice", focused, notices: [resource.data?.refreshError,
    data?.truncated ? "History reached the 5,000-observation limit. Narrow the range for all observations." : null].filter((value): value is string => !!value) });
  const periodChange = rows.length > 1 && rows[0]!.value != null && rows.at(-1)!.value != null ? rows.at(-1)!.value! - rows[0]!.value! : null;
  const tone = (n: number) => n === 0 ? colors.textMuted : n > 0 ? colors.positive : colors.negative;
  // Long/short: the latest reading stays free on the row; history adds its ratio and the day's move once it reaches back a day.
  const reading = market.longShortRatio ?? null;
  const day = metric === "long-short" ? dayChange(rows) : null;
  // The same four figures on every series: the series itself, its move over the range, and the market around it.
  const figures: StatItem[] = [
    { id: "latest", label: metric === "funding" ? "Funding / 8h" : metric === "oi" ? "Open interest USD" : metric === "premium" ? "Oracle premium" : metric === "long-short" ? "Long accounts" : `Price ${market.quoteCurrency}`,
      value: rows.length ? historyValue(rows.at(-1)?.value, metric) : metric === "funding" ? percent(market.fundingRate8h, 4) : metric === "oi" ? compact(market.openInterestUsd)
        : metric === "premium" ? percent(market.premium) : metric === "long-short" ? share(reading?.longShare, 2) : price(market.markPrice),
      // Annualised from the shown 8h rate, so the detail always agrees with the value beside it.
      ...(metric === "funding" && rows.at(-1)?.value != null ? { detail: `${percent(rows.at(-1)!.value! * 3 * 365, 1)} APR` } : {}) },
    ...(metric === "long-short" ? [{ id: "ratio", label: "Long / short", value: ratioText(rows.length ? rows.at(-1)!.ratio : reading?.ratio) }] : []),
    ...(day !== null ? [{ id: "day", label: "24h change", value: historyChange(day, metric), color: tone(day) }] : []),
    // On a one-day range the day's move already says it.
    ...(periodChange !== null && !(day !== null && range === "1") ? [{ id: "change", label: `${range}D change`, value: historyChange(periodChange, metric), color: tone(periodChange) }] : []),
    ...(metric !== "price" ? [{ id: "mark", label: `Mark ${market.quoteCurrency}`, value: price(market.markPrice) }] : []),
    ...(metric !== "oi" ? [{ id: "oi", label: "Open interest USD", value: compact(market.openInterestUsd) }] : []),
  ].slice(0, 4);
  // A series with one basis says it in the legend; the column only appears when the basis changes along the range.
  const oneBasis = rows.every((row) => row.basis === rows[0]?.basis);
  // A venue that publishes no long/short reading, or one not collected, says why instead of claiming to collect it.
  const reason = metric === "long-short" ? longShortReason(market) : null;
  const noSeries = reason && reason !== "Collecting" ? reason : null;
  const missing = noSeries ?? COLLECTING[metric];
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
          formatAxisValue: (n, domain) => {
            const steps = Math.ceil(-Math.log10(Math.abs(domain.max - domain.min) * 100 / 4));
            return metric === "funding" || metric === "premium" ? `${(n * 100).toFixed(Math.max(2, Math.min(6, steps)))}%`
              : metric === "long-short" ? `${(n * 100).toFixed(Math.max(0, Math.min(2, steps)))}%` : historyValue(n, metric);
          },
          loading: !data && resource.loading, empty: rows.length < 3 ? missing : undefined }} />}
      renderCell={(row, column) => historyCell(row, column.id, metric, colors)}
      getExportMetadata={() => [["As of", lastTime ?? ""], ["Market", market.marketId], ["Series", historyCaption(data, metric)], ["Source", market.sourceUrl],
        ["Retrieved", data?.asOf ?? ""], ["Funding basis", `${fundingInterval(market)}; every history point uses its own recorded interval`],
        ["Units", metric === "long-short" ? "percent of accounts; changes in percentage points; ratio is long over short accounts" : inPoints(metric) ? "percent; changes in percentage points" : metric === "oi" ? "USD" : market.quoteCurrency],
        ...(metric === "long-short" && reading ? [["Definition", `${venueLabel(market)}: ${reading.definitionText}`]] : [])]}
      emptyStateTitle={noSeries ?? "History is accumulating from the first observation."} />
  </PaneStatusBody>;
}

const COLLECTING: Record<HistoryMetric, string> = { funding: "Collecting funding history", oi: "Collecting open interest from our own snapshots",
  premium: "Collecting oracle premium from our own snapshots", price: "Collecting price history", "long-short": "Collecting long/short history" };

interface ListTabProps {
  accessKey: string;
  width: number;
  height: number;
  focused: boolean;
  /** The row under the cursor, so the footer actions and the other tabs follow it. */
  onPick: (row: PerpBoardRow | null) => void;
  /** Enter on a row: that market's history. */
  onOpen: (row: PerpBoardRow) => void;
}

const asOfInfo = (id: string, asOf: string | null | undefined) => asOf ? [{ id, parts: [{ text: time(asOf), tone: "muted" as const }] }] : [];
const moreText = (count: number, noun: string) => `Upgrade for ${count.toLocaleString("en-US")} more ${noun}`;

/** The preview's lock: under the rows it shows, or in place of the rows when none of the preview matches. */
function LockedPreview({ text, role, onPress }: { text: string; role: string; onPress: () => void }) {
  return <Box paddingX={1}><UpgradeLabel text={text} onPress={onPress} role={role} /></Box>;
}

function Board({ accessKey, width, height, focused, onPick, onOpen }: ListTabProps) {
  const colors = useThemeColors();
  const upgrade = useCloudUpgradeAction("perp");
  const session = useResearchCloudSession();
  const [openingAsset] = usePaneSettingValue("assetClass", "all");
  const [asset, setAsset] = usePluginPaneState<string>("perps:asset", openingAsset);
  const [openingVenue] = usePaneSettingValue("venue", "all");
  const [venue, setVenue] = usePluginPaneState<string>("perps:venue", openingVenue);
  const [openingSort] = usePaneSettingValue("sort", "oi");
  const [sort, setSort] = usePluginPaneState<string>("perps:sort", openingSort);
  const [search, setSearch] = usePluginPaneState<string>("perps:board-search", "");
  const [selectedId, setSelected] = usePluginPaneState<string | null>("perps:board-selected", null);
  const querySearch = useQueryBarSearch();
  // Asset class, search and order are the server's; the venue narrows what it returned.
  const query = useMemo(() => ({ ...(asset !== "all" ? { assetClass: asset } : {}), ...(search.trim() ? { search: search.trim() } : {}), sort }), [asset, search, sort]);
  const loader = useCallback((force: boolean) => loadPerpsBoard(query, accessKey, force), [query, accessKey]);
  const resource = useAsyncResource(loader, { initialData: () => cachedPerpsBoard(query, accessKey), clearOnError: isAccessDenied, keepPreviousData: true });
  const data = resource.data?.payload;
  const venues = useMemo(() => venuesOf(data?.rows ?? []), [data]);
  const rows = useMemo(() => venue === "all" ? data?.rows ?? [] : (data?.rows ?? []).filter((row) => row.venue === venue), [data, venue]);
  const selected = rows.find((row) => row.marketId === selectedId) ?? rows[0] ?? null;
  useEffect(() => { onPick(selected); }, [selected, onPick]);
  const columns = useMemo(() => boardColumns(width), [width]);
  const locked = typeof data?.locked === "number" ? data.locked : 0;
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  usePaneRefreshKey(() => { void resource.reload(); }, { focused: focused && !querySearch.active });
  usePaneStatusFooter({ registrationId: "perps:board", loading: resource.loading, error: data ? resource.error : null, stale: resource.data?.stale, info: asOfInfo("board-asof", data?.asOf) });
  usePaneNoticeFooter({ registrationId: "perps:board-notice", focused, notices: resource.data?.refreshError ? [resource.data.refreshError] : [] });
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall placement="perps-signin" action="view perpetual markets" needsVerification={session.needsVerification} />;
  const narrow = (apply: () => void) => { apply(); setSelected(null); };
  const lock = locked ? <LockedPreview text={moreText(locked, "markets")} onPress={upgrade} role="perps-board-upgrade" /> : null;
  const queryBar = <QueryBar width={width} search={{ focused, value: search, onChange: (value) => narrow(() => setSearch(value)), placeholder: "Search markets", debounceMs: 300, ...querySearch.searchProps }}
    filters={[
      { id: "asset", label: "Asset", value: asset, defaultValue: "all", options: ASSET_FILTERS.map((value) => ({ value, label: label(value) })), onChange: (value: string) => narrow(() => setAsset(value)) },
      { id: "venue", label: "Venue", value: venue, defaultValue: "all",
        options: ["all", ...venues, ...(venue !== "all" && !venues.includes(venue) ? [venue] : [])].map((value) => ({ value, label: value === "all" ? "All" : venueName(value) })),
        onChange: (value: string) => narrow(() => setVenue(value)) },
      { id: "sort", label: "Sort", value: sort, options: BOARD_SORTS.map((value) => ({ value, label: sortLabel(value) })), onChange: (value: string) => narrow(() => setSort(value)) },
    ]} />;
  return <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} subject="perpetual markets">
    <DataTableView<PerpBoardRow> columns={columns} items={rows} focused={focused && !querySearch.active} rootWidth={width} rootHeight={height} rootBefore={queryBar}
      getItemKey={(row) => row.marketId} sortColumnId={null} sortDirection="desc" resetScrollKey={`${JSON.stringify(query)}:${venue}`}
      selection={{ kind: "id", selectedId: selected?.marketId ?? null, getId: (row) => row.marketId, onChange: setSelected }} onActivate={(row) => onOpen(row)}
      renderCell={(row, column) => perpCell(row, column.id as PerpColumnId, colors)} selectedTextOverridesCellColor
      emptyStateTitle="No markets match these filters." emptyContent={lock && <Box paddingX={1} paddingY={1}><EmptyState title="No preview markets match." actions={<UpgradeLabel text={moreText(locked, "markets")} onPress={upgrade} role="perps-board-upgrade" />} /></Box>}
      bodyAfter={lock}
      getExportMetadata={() => [["As of", data?.asOf ?? ""], ["Units", "funding per its own interval, APR, premium and changes in percent; open interest in USD; long share in percent of accounts, each venue's definition"]]} />
  </PaneStatusBody>;
}

type Ranked = { list: RankingKey; row: PerpBoardRow };
const rankedKey = (item: Ranked) => `${item.list}:${item.row.marketId}`;

function Rankings({ accessKey, width, height, focused, onPick, onOpen }: ListTabProps) {
  const colors = useThemeColors();
  const upgrade = useCloudUpgradeAction("perp");
  const session = useResearchCloudSession();
  const [selectedId, setSelected] = usePluginPaneState<string | null>("perps:rank-selected", null);
  const loader = useCallback((force: boolean) => loadPerpsRankings(accessKey, force), [accessKey]);
  const resource = useAsyncResource(loader, { initialData: () => cachedPerpsRankings(accessKey), clearOnError: isAccessDenied });
  const data = resource.data?.payload;
  const items = useMemo(() => buildSectionedRows(RANKINGS.map((ranking) => ({ label: ranking.label, emptyLabel: "None",
    items: rankingRows(data, ranking.key).map((row): Ranked => ({ list: ranking.key, row })) })), rankedKey), [data]);
  const ranked = items.flatMap((item) => item.kind === "item" ? [item.item] : []);
  const selected = ranked.find((item) => rankedKey(item) === selectedId) ?? ranked[0] ?? null;
  useEffect(() => { onPick(selected?.row ?? null); }, [selected, onPick]);
  const columns = useMemo(() => rankingColumns(width), [width]);
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  usePaneRefreshKey(() => { void resource.reload(); }, { focused });
  usePaneStatusFooter({ registrationId: "perps:rankings", loading: resource.loading, error: data ? resource.error : null, stale: resource.data?.stale, info: asOfInfo("rankings-asof", data?.asOf) });
  usePaneNoticeFooter({ registrationId: "perps:rankings-notice", focused, notices: resource.data?.refreshError ? [resource.data.refreshError] : [] });
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall placement="perps-signin" action="view perpetual rankings" needsVerification={session.needsVerification} />;
  const renderCell = (entry: SectionedRow<Ranked>, column: { id: string }): DataTableCell => {
    if (entry.kind === "empty") return column.id === columns[0]!.id ? { text: entry.label, color: colors.textDim } : { text: "" };
    if (entry.kind !== "item") return { text: "" };
    const { list, row } = entry.item;
    if (column.id !== "value") return perpCell(row, column.id as PerpColumnId, colors);
    const ranking = RANKINGS.find((item) => item.key === list)!;
    const value = row[ranking.field];
    return { text: percent(value, ranking.digits), value: value == null ? null : value * 100, color: value == null || value === 0 ? colors.textMuted : value > 0 ? colors.positive : colors.negative };
  };
  return <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} subject="perpetual rankings">
    <DataTableView<SectionedRow<Ranked>> columns={columns} items={items} focused={focused} rootWidth={width} rootHeight={height}
      getItemKey={(entry) => entry.key} sortColumnId={null} sortDirection="desc" isNavigable={(entry) => entry.kind === "item"}
      renderSectionHeader={(entry) => entry.kind === "section" ? { text: entry.label } : null}
      selection={{ kind: "id", selectedId: selected ? rankedKey(selected) : null, getId: (entry) => entry.key, onChange: (id) => { if (ranked.some((item) => rankedKey(item) === id)) setSelected(id); } }}
      onActivate={(entry) => { if (entry.kind === "item") onOpen(entry.item.row); }}
      renderCell={renderCell} selectedTextOverridesCellColor emptyStateTitle="No rankings yet." fillAvailableWidth={false}
      bodyAfter={data?.locked ? <LockedPreview text="Upgrade for the full rankings" onPress={upgrade} role="perps-rankings-upgrade" /> : undefined}
      getExportMetadata={() => [["As of", data?.asOf ?? ""], ["Units", "funding per 8 hours, OI change over 24 hours and premiums in percent; open interest in USD"]]} />
  </PaneStatusBody>;
}

function Compare({ asset, onAssetChange, accessKey, width, height, focused, onPick, onOpen }: ListTabProps & { asset: string; onAssetChange: (asset: string) => void }) {
  const colors = useThemeColors();
  const upgrade = useCloudUpgradeAction("perp");
  const session = useResearchCloudSession();
  const [selectedId, setSelected] = usePluginPaneState<string | null>("perps:compare-selected", null);
  const querySearch = useQueryBarSearch();
  const base = asset.trim().toUpperCase() || "BTC";
  const loader = useCallback((force: boolean) => loadPerpsCompare(base, accessKey, force), [base, accessKey]);
  const resource = useAsyncResource(loader, { initialData: () => cachedPerpsCompare(base, accessKey), clearOnError: isAccessDenied, keepPreviousData: true });
  const data = resource.data?.payload;
  const rows = data?.rows ?? [];
  const selected = rows.find((row) => row.marketId === selectedId) ?? rows[0] ?? null;
  useEffect(() => { onPick(selected); }, [selected, onPick]);
  const columns = useMemo(() => compareColumns(width), [width]);
  const spread = useMemo(() => fundingSpread(rows), [rows]);
  const locked = typeof data?.locked === "number" ? data.locked : 0;
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  usePaneRefreshKey(() => { void resource.reload(); }, { focused: focused && !querySearch.active });
  usePaneStatusFooter({ registrationId: "perps:compare", loading: resource.loading, error: data ? resource.error : null, stale: resource.data?.stale, info: asOfInfo("compare-asof", data?.asOf) });
  usePaneNoticeFooter({ registrationId: "perps:compare-notice", focused, notices: resource.data?.refreshError ? [resource.data.refreshError] : [] });
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall placement="perps-signin" action="compare perpetual venues" needsVerification={session.needsVerification} />;
  const figures: StatItem[] = spread ? [{ id: "spread", label: "Funding spread 8h", value: spread.text, detail: spread.detail }] : [];
  const lock = locked ? <LockedPreview text={moreText(locked, locked === 1 ? "contract" : "contracts")} onPress={upgrade} role="perps-compare-upgrade" /> : null;
  const before: ReactNode = <>
    <QueryBar width={width} search={{ focused, value: asset, onChange: (value) => { onAssetChange(value); setSelected(null); }, placeholder: "Base asset", debounceMs: 300, ...querySearch.searchProps }} />
    <StatGrid width={width} items={figures} />
  </>;
  return <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} subject="perpetual contracts">
    <DataTableView<PerpBoardRow> columns={columns} items={rows} focused={focused && !querySearch.active} rootWidth={width} rootHeight={height} rootBefore={before}
      getItemKey={(row) => row.marketId} sortColumnId={null} sortDirection="desc" resetScrollKey={base}
      selection={{ kind: "id", selectedId: selected?.marketId ?? null, getId: (row) => row.marketId, onChange: setSelected }} onActivate={(row) => onOpen(row)}
      renderCell={(row, column) => perpCell(row, column.id as PerpColumnId, colors)} selectedTextOverridesCellColor
      emptyStateTitle={`No perpetual contracts for ${base}.`} emptyContent={lock && <Box paddingX={1} paddingY={1}><EmptyState title={`No preview contracts for ${base}.`} actions={<UpgradeLabel text={moreText(locked, locked === 1 ? "contract" : "contracts")} onPress={upgrade} role="perps-compare-upgrade" />} /></Box>}
      bodyAfter={lock}
      getExportMetadata={() => [["As of", data?.asOf ?? ""], ["Base asset", base], ...(spread ? [["Funding spread 8h", spread.text, spread.detail]] : []),
        ["Units", "funding per its own interval, per 8 hours, APR, premium and changes in percent; open interest in USD; long share in percent of accounts, each venue's definition"]]} />
  </PaneStatusBody>;
}

// Optional host action boundary: no external plugin or trading dependency is registered here.
interface PerpMarketAction {
  id: string;
  key: string;
  label: string;
  onPress: (market: PerpBoardRow) => void;
}
/** Compare takes a base asset: a named symbol is one, a canonical identity waits for its market. */
const compareOpening = (market: string) => market.trim() && !market.includes(":") ? market.trim().toUpperCase() : "BTC";

export function PerpsPane({ width, height, focused, marketAction }: Pick<PaneProps, "width" | "height" | "focused"> & { marketAction?: PerpMarketAction }) {
  const host = useRendererHost();
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "pro" : "preview"}`;
  const { createPaneFromTemplate, notify } = usePluginAppActions();
  const upgrade = useCloudUpgradeAction("perp");
  const [openingMarket] = usePaneSettingValue("market", "");
  const [openingTabValue] = usePaneSettingValue("tab", openingTab(openingMarket));
  const [savedTab, setTab] = usePluginPaneState<string>("perps:tab", openingTabValue);
  const tab = PERP_TABS.includes(savedTab as PerpTab) ? savedTab as PerpTab : openingTab(openingMarket);
  const marketTab = isMarketTab(tab);
  const [search, setSearch] = usePluginPaneState<string>("perps:search", openingMarket);
  const [compareAsset, setCompareAsset] = usePluginPaneState<string>("perps:compare", compareOpening(openingMarket));
  // The row under a list's cursor, and the last one any list had: an empty list keeps the market it was given.
  const [listRow, setListRow] = useState<PerpBoardRow | null>(null);
  const [picked, setPicked] = useState<PerpBoardRow | null>(null);
  const pick = useCallback((row: PerpBoardRow | null) => { setListRow(row); if (row) setPicked(row); }, []);
  const [openingRange] = usePaneSettingValue("days", "7");
  const [range, setRange] = usePluginPaneState<string>("perps:range", openingRange);
  const [openingMetric] = usePaneSettingValue("metric", "funding");
  const [metricValue, setMetric] = usePluginPaneState<string>("perps:metric", openingMetric);
  const metric: HistoryMetric = HISTORY_METRICS.includes(metricValue as HistoryMetric) ? metricValue as HistoryMetric : "funding";
  // One market's selection only loads for its own tabs; the lists bring their own rows.
  const loader = useCallback((force: boolean) => loadPerpSelection(search, accessKey, force), [search, accessKey]);
  const resource = useAsyncResource(marketTab ? loader : null, { initialData: () => cachedPerpSelection(search, accessKey), clearOnError: isAccessDenied });
  const data = marketTab ? resource.data?.payload : undefined;
  const active = data?.rows[0] ?? null;
  usePaneTitle(active ? `PERP ${marketLabel(active)} · ${venueLabel(active)}` : "PERP");
  const querySearch = useQueryBarSearch();
  // The market on screen goes with the user: History and Evidence open the row picked on a list, Compare its base asset.
  const current = marketTab ? active : listRow;
  const carried = marketTab ? active : listRow ?? picked;
  const selectTab = useCallback((next: string) => {
    if (carried && isMarketTab(next) && !marketTab) setSearch(carried.marketId);
    if (carried && next === "compare") setCompareAsset(carried.baseAsset);
    setListRow(null);
    setTab(next);
  }, [carried, marketTab, setSearch, setCompareAsset, setTab]);
  const openMarket = useCallback((row: PerpBoardRow, next: PerpTab = "history") => { setSearch(row.marketId); setTab(next); }, [setSearch, setTab]);
  const { strip, rows: tabRows } = usePaneTabs({ tabs: PERP_TABS.map((value) => ({ value, label: label(value) })), activeValue: tab, onSelect: selectTab, focused, dense: true });
  const refreshMarket = useCallback(() => { void resource.reload(); }, [resource.reload]);
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  usePaneRefreshKey(refreshMarket, { focused: focused && marketTab && !querySearch.active && (tab !== "history" || !active) });
  const navigate = (template: string) => { if (current?.underlyingSymbol) createPaneFromTemplate(template, { symbol: current.underlyingSymbol, arg: current.underlyingSymbol }); };
  const preview = marketTab ? data?.access === "preview" : !access.hasProAccess;
  const hints: PaneHint[] = [
    ...(current && marketAction ? [{ id: marketAction.id, key: marketAction.key, label: marketAction.label, onPress: () => marketAction.onPress(current) }] : []),
    ...(current && getSharedRegistry()?.commands.has("set-event-alert") ? [{ id: "alert", key: "a", label: "lert", onPress: () => {
      if (!openFormModal({ kind: "plugin-command", commandId: "set-event-alert", values: { event: "perps_threshold", "perps_threshold:marketId": current.marketId } })) notify({ body: "Open this from the main window.", type: "info" });
    } }] : []),
    ...(current && tab !== "evidence" ? [{ id: "evidence", key: "e", label: "vidence", onPress: () => marketTab ? setTab("evidence") : openMarket(current, "evidence") }] : []),
    ...(current ? [{ id: "source", key: "o", label: "pen source", onPress: () => void host.openExternal(current.sourceUrl) }] : []),
    ...(current?.underlyingSymbol ? [{ id: "description", key: "d", label: "es", onPress: () => navigate("new-ticker-detail-pane") }, { id: "financials", key: "f", label: "a", onPress: () => navigate("financial-analysis-pane") }, { id: "graph", key: "g", label: "raph", onPress: () => navigate("chart-composer-pane") }] : []),
    ...(preview ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: upgrade }] : []),
  ];
  usePaneStatusFooter({ registrationId: "perps", loading: marketTab && resource.loading, error: data ? resource.error : null, stale: marketTab && (resource.data?.stale || !!active?.stale),
    info: active && (tab === "evidence" || data?.access === "preview") ? [{ id: "asof", parts: [{ text: time(active.observedAt), tone: "muted" }] }] : [], hints });
  usePaneNoticeFooter({ registrationId: "perps:notices", focused, notices: marketTab ? [resource.data?.refreshError,
    ...(active?.qualityFlags.map((flag) => flag.replaceAll("_", " ").replaceAll("-", " ")) ?? [])].filter((s): s is string => !!s) : [] });
  if (marketTab && !data && isCloudSessionRequired(resource.error)) return <SignInWall placement="perps-signin" action="view perpetual history" needsVerification={session.needsVerification} />;
  const listHeight = Math.max(3, height - tabRows);
  const list = { accessKey, width, height: listHeight, focused, onPick: pick, onOpen: (row: PerpBoardRow) => openMarket(row) };
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    {tab === "board" ? <Board {...list} /> : tab === "rankings" ? <Rankings {...list} />
      : tab === "compare" ? <Compare {...list} asset={compareAsset} onAssetChange={setCompareAsset} /> : <>
        <QueryBar width={width} search={{ focused, value: search, onChange: setSearch, placeholder: "Market or canonical identity", debounceMs: 300, ...querySearch.searchProps }}
          filters={tab === "history" ? [
            { id: "metric", label: "Series", value: metric, options: HISTORY_METRICS.map((value) => ({ value, label: metricLabel(value) })), onChange: setMetric },
            { id: "range", label: "Range", value: range, options: ["1", "7", "30", "90", "365"].map((value) => ({ value, label: `${value}D` })), onChange: setRange },
          ] : []} />
        <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} subject="perpetual market">
          {active ? tab === "history" ? <History key={active.marketId} market={active} accessKey={accessKey} width={width} height={listHeight - 1} focused={focused && !querySearch.active} range={range} metric={metric} refreshMarket={refreshMarket} />
            : <MarketEvidence row={active} data={data!} width={width} height={listHeight - 1} /> : <EmptyState title="No market matches." />}
        </PaneStatusBody>
      </>}
  </Box>;
}
