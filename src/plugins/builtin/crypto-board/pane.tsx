import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, TextAttributes } from "../../../ui";
import {
  ChartTableHeader,
  DataTableView,
  PaneStatusBody,
  QueryBar,
  stackedSeries,
  usePaneFooter,
  usePaneNoticeFooter,
  usePaneTabs,
  type DataTableCell,
  type DataTableKeyEvent,
  type StatItem,
} from "../../../components";
import { formatCompactAxis } from "../../../components/chart-table";
import { PriceSparkline } from "../../../components/price-sparkline/view";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import type { CryptoAssetKind, CryptoMarketAsset } from "../../../api-client/crypto-markets";
import { isAccessDenied } from "../../../api-client/errors";
import { useAsyncResource } from "../../../react/async-resource";
import { useAgeClock, useAutoRefresh } from "../../../react/auto-refresh";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { deriveHeadlessFreshness, paneStatusLine } from "../../../cli/pane-functions/freshness";
import { usePaneVisible } from "../../../state/app/activity";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { colors, priceColor } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import type { QueryEntry } from "../../../market-data/result-types";
import type { PaneProps } from "../../../types/plugin";
import { publicTickerKey } from "../../../utils/exchanges";
import { formatCompact, formatCompactAmount } from "../../../utils/format";
import { SERIES_COLORS } from "../../../theme/series-colors";
import { usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { useLiveStreamingSetting } from "../../../state/hooks/live-streaming";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { INITIAL_STREAM_RANGE, streamWindowRows } from "../shared/use-quote-board";
import { cachedCryptoMarkets, cachedStablecoinSupply, loadCryptoMarkets, loadStablecoinSupply } from "./client";
import {
  buildCryptoColumns,
  buildCryptoRows,
  CRYPTO_BOARD_FRESHNESS,
  CRYPTO_TABS,
  cryptoRowObservations,
  DEFAULT_CRYPTO_SORT,
  formatCryptoPercent,
  formatDayRangeTime,
  formatOffPeg,
  nextCryptoSort,
  offPegSeverity,
  sortCryptoRows,
  withCryptoSupply,
  type CryptoColumn,
  type CryptoRow,
  type CryptoSortPreference,
} from "./model";
import { stackedSupply, SUPPLY_RANGES, supplyByCode, supplyFailure, type SupplyRangeId } from "./supply";

/**
 * The board is the price for every row without a live stream: coins the live
 * feed does not carry, and every coin on a delayed plan, whose streamed quotes
 * trail it by 15 minutes. It refreshes on this clock, not the app's data one.
 */
const CRYPTO_BOARD_REFRESH_MS = 15_000;
/** Once every streamed row is live, the board only carries the rest of the tab. */
const CRYPTO_BOARD_STREAMING_REFRESH_MS = 60_000;

const NO_QUOTES = new Map<string, QueryEntry<Quote>>();

/** Supply moves once a day; the server reads its source daily, so half-hourly is plenty. */
const SUPPLY_REFRESH_MS = 30 * 60_000;

const SUPPLY_RANGE_OPTIONS = SUPPLY_RANGES.map(({ value, label }) => ({ value, label }));

const cryptoTickerKey = (row: CryptoRow) => publicTickerKey(row.asset.symbol, "CCC");

function quoteTargets(
  assets: readonly CryptoMarketAsset[],
  selectedId: string | null,
): QuoteSubscriptionTarget[] {
  return assets.map((asset) => ({
    symbol: asset.symbol,
    exchange: "CCC",
    surface: "screener",
    visible: true,
    selected: asset.symbol === selectedId,
    weight: asset.symbol === selectedId ? 100 : 70,
  }));
}

function renderCryptoCell(row: CryptoRow, column: CryptoColumn): DataTableCell {
  const signed = (value: number | null) => ({
    text: formatCryptoPercent(value),
    color: value == null ? colors.textDim : priceColor(value),
  });
  switch (column.id) {
    case "rank":
      return { text: String(row.rank), color: colors.textDim };
    case "code":
      return { text: row.code, color: colors.textBright, attributes: TextAttributes.BOLD };
    case "name":
      return { text: row.name };
    case "price":
      return { text: row.priceText };
    case "changePercent":
      return signed(row.changePercent);
    case "return7d":
      return signed(row.return7d);
    case "return30d":
      return signed(row.return30d);
    case "return1y":
      return signed(row.return1y);
    case "trend":
      return {
        text: "",
        content: <PriceSparkline priceHistory={row.history} width={column.width} period="1M" />,
      };
    case "volume24h":
      return { text: row.volume24h == null ? "—" : formatCompact(row.volume24h, { fixedDecimals: true }), color: colors.textDim };
    case "marketCap":
      return { text: row.marketCap == null ? "—" : formatCompact(row.marketCap, { fixedDecimals: true }), color: colors.textDim };
    case "pegText":
      return { text: row.pegText || "—", color: row.peg?.accrues || (row.peg && row.peg.currency !== "USD") ? colors.text : colors.textDim };
    case "offPegBp": {
      const severity = offPegSeverity(row.offPegBp);
      return {
        text: formatOffPeg(row.offPegBp),
        value: row.offPegBp,
        color: severity === "broken" ? colors.negative : severity === "watch" ? colors.warning : colors.text,
        keepColorWhenSelected: severity !== "none",
      };
    }
    case "low24h":
      return { text: row.low24hText, value: row.low24h };
    case "high24h":
      return { text: row.high24hText, value: row.high24h };
    case "low24hAt":
      return { text: formatDayRangeTime(row.low24hAt), value: row.low24hAt == null ? null : new Date(row.low24hAt), color: colors.textDim };
    case "high24hAt":
      return { text: formatDayRangeTime(row.high24hAt), value: row.high24hAt == null ? null : new Date(row.high24hAt), color: colors.textDim };
    case "supply":
      return { text: row.supply == null ? "—" : formatCompact(row.supply, { fixedDecimals: true }) };
    case "supply7dPercent":
      return signed(row.supply7dPercent);
    case "supply30dPercent":
      return signed(row.supply30dPercent);
    case "supply7d":
      return signedAmount(row.supply7d);
    case "supply30d":
      return signedAmount(row.supply30d);
    case "supplyShare":
      return { text: row.supplyShare == null ? "—" : `${row.supplyShare.toFixed(2)}%`, color: colors.textDim };
  }
}

function signedAmount(value: number | null): DataTableCell {
  return {
    text: value == null ? "—" : formatCompactAmount(value, { signed: true }),
    color: value == null ? colors.textDim : priceColor(value),
  };
}

const formatSupply = (value: number) => formatCompact(value, { fixedDecimals: true });

/** A supply change as a figure: the amount, its percent beside it, coloured by direction. */
function supplyChangeFigure(id: string, label: string, amount: number | null, percent: number | null): StatItem {
  return {
    id,
    label,
    value: amount == null ? "—" : formatCompactAmount(amount, { signed: true }),
    detail: formatCryptoPercent(percent),
    ...(amount == null ? {} : { color: priceColor(amount) }),
  };
}

export function CryptoBoardPane({ width, height, focused }: PaneProps) {
  const session = useResearchCloudSession();
  const loader = useCallback((force: boolean) => loadCryptoMarkets(force), [session.requestKey]);
  const resource = useAsyncResource(loader, { initialData: cachedCryptoMarkets, clearOnError: isAccessDenied });
  const data = resource.data?.payload;
  const { pinTicker } = usePluginTickerActions();
  const liveStreaming = useLiveStreamingSetting();
  const [activeTab, setActiveTab] = usePluginPaneState<CryptoAssetKind>("activeTab", "coin");
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selected", null);
  const [sort, setSort] = useState<CryptoSortPreference>(DEFAULT_CRYPTO_SORT);
  const [visibleRange, setVisibleRange] = useState(INITIAL_STREAM_RANGE);
  const paneVisible = usePaneVisible();
  const reloadBoard = resource.load;

  // Supply loads once the Stablecoins tab is first shown, and stays for the pane's life.
  const [supplyShown, setSupplyShown] = useState(activeTab === "stablecoin");
  useEffect(() => {
    if (activeTab === "stablecoin") setSupplyShown(true);
  }, [activeTab]);
  const supplyLoader = useCallback((force: boolean) => loadStablecoinSupply(force), [session.requestKey]);
  const supplyResource = useAsyncResource(supplyShown ? supplyLoader : null, { initialData: cachedStablecoinSupply });
  const supply = supplyResource.data?.payload ?? null;
  useAutoRefresh(supplyResource.updatedAt, supplyResource.load, { intervalMs: SUPPLY_REFRESH_MS });
  const [supplyRange, setSupplyRange] = usePluginPaneState<SupplyRangeId>("supplyRange", "1Y");
  const stablecoins = activeTab === "stablecoin";

  const tabAssets = useMemo(
    () => data?.assets.filter((asset) => asset.kind === activeTab) ?? [],
    [activeTab, data],
  );
  // The stream follows the rows on screen. Ordering by the board snapshot keeps
  // live ticks from reshuffling the subscription; the overscan covers the drift.
  const streamedAssets = useMemo(() => {
    const ordered = sortCryptoRows(buildCryptoRows(tabAssets, activeTab, NO_QUOTES), sort).map((row) => row.asset);
    return streamWindowRows(ordered, visibleRange, ordered.find((asset) => asset.symbol === selectedId));
  }, [activeTab, selectedId, sort, tabAssets, visibleRange]);
  const targets = useMemo(() => quoteTargets(streamedAssets, selectedId), [selectedId, streamedAssets]);
  const { entries, freshnessNow } = useLiveQuoteEntries(targets, {
    freshnessScopeKey: `crypto-board:${activeTab}`,
    liveStreaming,
  });

  const supplyRows = useMemo(() => (stablecoins ? supplyByCode(supply) : null), [stablecoins, supply]);
  const rows = useMemo(
    () => {
      const built = buildCryptoRows(tabAssets, activeTab, entries, freshnessNow);
      return sortCryptoRows(supplyRows ? withCryptoSupply(built, supplyRows) : built, sort);
    },
    [activeTab, entries, freshnessNow, sort, supplyRows, tabAssets],
  );
  const streamedIds = useMemo(() => new Set(streamedAssets.map((asset) => asset.symbol)), [streamedAssets]);
  const allStreamedLive = liveStreaming && streamedIds.size > 0
    && rows.every((row) => !streamedIds.has(row.id) || row.live);
  const boardRefreshMs = allStreamedLive ? CRYPTO_BOARD_STREAMING_REFRESH_MS : CRYPTO_BOARD_REFRESH_MS;
  useEffect(() => {
    if (!paneVisible) return;
    const timer = setInterval(() => void reloadBoard(false), boardRefreshMs);
    return () => clearInterval(timer);
  }, [boardRefreshMs, paneVisible, reloadBoard]);
  useEffect(() => {
    if (!rows.length) return;
    if (!selectedId || !rows.some((row) => row.id === selectedId)) setSelectedId(rows[0]!.id);
  }, [rows, selectedId, setSelectedId]);

  // Dated by the rows on screen while they stream, as `fn CRYP` and `shot CRYP` date the board.
  const observations = useMemo(() => cryptoRowObservations(liveStreaming && streamedIds.size > 0
    ? rows.filter((row) => streamedIds.has(row.id)) : rows), [liveStreaming, rows, streamedIds]);
  const now = useAgeClock(resource.updatedAt);
  useRemoteUiNode(observations.length ? {
    role: "report-freshness",
    label: "Price freshness",
    getMetadata: () => ({ ...CRYPTO_BOARD_FRESHNESS, observations }),
  } : null);
  const statusLine = useMemo(() => observations.length
    ? paneStatusLine(deriveHeadlessFreshness({ shape: "rows" }, { rows: observations, freshness: CRYPTO_BOARD_FRESHNESS }, now))
    : null, [now, observations]);
  const columns = useMemo(() => buildCryptoColumns(width, activeTab), [activeTab, width]);

  // Other is muted against the theme it is drawn on; the coins take the shared series palette, which the chart themes.
  const otherColor = useThemeColors().textMuted;
  const supplySeries = useMemo(() => {
    const stacked = stablecoins ? stackedSupply(supply, supplyRange) : null;
    if (!stacked) return [];
    return stackedSeries(stacked.dates, stacked.layers.map((layer, index) => ({
      ...layer,
      color: layer.id === "other" ? otherColor : SERIES_COLORS[index % SERIES_COLORS.length]!,
    })), { calendarSpaced: true });
  }, [otherColor, stablecoins, supply, supplyRange]);
  const supplyFigures = useMemo<StatItem[]>(() => {
    const total = supply?.total;
    if (!stablecoins || !total) return [];
    return [
      { id: "total", label: "Total supply", value: formatSupply(total.supply), ...(supply.asOf ? { detail: `as of ${supply.asOf}` } : {}) },
      supplyChangeFigure("change-7d", "7D change", total.change7d, total.change7dPercent),
      supplyChangeFigure("change-30d", "30D change", total.change30d, total.change30dPercent),
    ];
  }, [stablecoins, supply]);
  const supplyError = !supply && supplyResource.error ? supplyResource.error : null;

  const tabItems = CRYPTO_TABS.map((tab) => ({
    label: tab.label,
    value: tab.value,
  }));
  const selectTab = (value: string) => {
    setActiveTab(value as CryptoAssetKind);
    setSelectedId(null);
    setVisibleRange(INITIAL_STREAM_RANGE);
  };
  const { strip: tabStrip } = usePaneTabs({ tabs: tabItems, activeValue: activeTab, onSelect: selectTab, focused, compact: true, variant: "bare" });

  usePaneNoticeFooter({
    registrationId: "crypto-board:notices",
    focused,
    notices: [
      ...(data?.warnings ?? []),
      ...(resource.data?.refreshError ? [resource.data.refreshError] : []),
      ...(stablecoins ? [
        ...(supply?.warnings ?? []),
        ...(supplyResource.data?.refreshError ? [supplyFailure(supplyResource.data.refreshError)] : []),
        ...(supplyError ? [supplyFailure(supplyError)] : []),
      ] : []),
    ],
  });
  usePaneFooter("crypto-board", () => ({
    info: [
      // Background refreshes run every 15s; only the first load is worth a label.
      ...(resource.loading && !data ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(data && resource.error ? [{ id: "refresh", parts: [{ text: "refresh failed", tone: "warning" as const }] }] : []),
      ...(statusLine ? [{ id: "updated", asOf: true, parts: [{ text: statusLine, tone: "muted" as const }] }] : []),
      ...(resource.data?.stale ? [{ id: "cached", parts: [{ text: "cached", tone: "warning" as const }] }] : []),
    ],
  }), [data, statusLine, resource.data?.stale, resource.error, resource.loading]);

  const reloadSupply = supplyResource.reload;
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => (
    handleRefreshKey(event, () => {
      void resource.reload();
      if (stablecoins) void reloadSupply();
    }, { stopPropagation: true })
  ), [reloadSupply, resource.reload, stablecoins]);

  const bodyHeight = Math.max(1, height - (tabStrip ? 1 : 0));

  return (
    <Box width={width} height={height} flexDirection="column">
      {tabStrip && <Box height={1} paddingX={1}>{tabStrip}</Box>}
      <PaneStatusBody
        loading={resource.loading && !data}
        error={!data ? resource.error : null}
        subject="crypto prices"
        empty={!!data && !rows.length}
        emptyTitle="No crypto assets returned."
      >
        <DataTableView<CryptoRow, CryptoColumn>
          focused={focused}
          selection={{
            kind: "id",
            selectedId,
            getId: (row) => row.id,
            onChange: (id) => setSelectedId(id),
          }}
          onRootKeyDown={handleKeyDown}
          resetScrollKey={activeTab}
          columns={columns}
          items={rows}
          sortable
          sortColumnId={sort.columnId}
          sortDirection={sort.direction}
          onHeaderClick={(columnId) => setSort((current) => nextCryptoSort(current, columnId))}
          onSortChange={(columnId, direction) => setSort((current) => ({ ...current, columnId: columnId as CryptoSortPreference["columnId"], direction }))}
          isColumnSortable={(column) => column.id !== "trend"}
          getItemKey={(row) => row.id}
          onActivate={(row) => pinTicker(cryptoTickerKey(row), {
            floating: true,
            paneType: TICKER_RESEARCH_PANE_ID,
            instrument: null,
          })}
          visibleRangeKey={`${activeTab}:${sort.columnId}:${sort.direction}`}
          onVisibleRangeChange={setVisibleRange}
          renderCell={renderCryptoCell}
          selectedTextOverridesCellColor
          emptyStateTitle="No crypto assets returned."
          rootBefore={stablecoins ? (
            <ChartTableHeader
              width={width}
              height={bodyHeight}
              tableRows={rows.length}
              tableColumns={columns}
              query={<QueryBar width={width} view={{ value: supplyRange, options: SUPPLY_RANGE_OPTIONS, onChange: setSupplyRange, chartRange: true }} />}
              figures={supplyFigures}
              chart={{
                series: supplySeries,
                formatValue: formatSupply,
                formatAxisValue: formatCompactAxis,
                remoteKind: "stablecoin-supply-history",
                loading: supplyResource.loading && !supply,
                empty: supplyError ? "Stablecoin supply is unavailable right now." : "No stablecoin supply history yet.",
              }}
            />
          ) : undefined}
        />
      </PaneStatusBody>
    </Box>
  );
}
