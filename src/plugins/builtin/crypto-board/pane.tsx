import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, TextAttributes } from "../../../ui";
import {
  DataTableView,
  PaneStatusBody,
  Tabs,
  usePaneFooter,
  usePaneHeaderTabs,
  usePaneNoticeFooter,
  type DataTableCell,
  type DataTableKeyEvent,
} from "../../../components";
import { PriceSparkline } from "../../../components/price-sparkline/view";
import type { CryptoAssetKind, CryptoMarketAsset } from "../../../api-client/crypto-markets";
import { ApiRequestError } from "../../../api-client/errors";
import { useAsyncResource } from "../../../react/async-resource";
import { useAppVisible } from "../../../state/app/activity";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { colors, priceColor } from "../../../theme/colors";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import type { QueryEntry } from "../../../market-data/result-types";
import type { PaneProps } from "../../../types/plugin";
import { publicTickerKey } from "../../../utils/exchanges";
import { formatCompact } from "../../../utils/format";
import { usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { useLiveStreamingSetting } from "../shared/live-streaming";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedCryptoMarkets, loadCryptoMarkets } from "./client";
import {
  buildCryptoColumns,
  buildCryptoRows,
  CRYPTO_TABS,
  DEFAULT_CRYPTO_SORT,
  formatCryptoPercent,
  nextCryptoSort,
  sortCryptoRows,
  type CryptoColumn,
  type CryptoRow,
  type CryptoSortPreference,
} from "./model";

/**
 * The board is the price for every row without a live stream: coins the live
 * feed does not carry, and every coin on a delayed plan, whose streamed quotes
 * trail it by 15 minutes. It refreshes on this clock, not the app's data one.
 */
export const CRYPTO_BOARD_REFRESH_MS = 15_000;
/** Rows streamed beyond the visible window so a short scroll lands on live prices. */
const STREAM_OVERSCAN = 8;
/** Before the table reports its window, stream what a full-height pane shows. */
const INITIAL_STREAM_ROWS = 40;

const NO_QUOTES = new Map<string, QueryEntry<Quote>>();

const clearDenied = (error: unknown) =>
  error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);

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

function renderCryptoCell(row: CryptoRow, column: CryptoColumn, selected: boolean): DataTableCell {
  const selectedColor = selected ? colors.selectedText : undefined;
  const signed = (value: number | null) => ({
    text: formatCryptoPercent(value),
    color: selectedColor ?? (value == null ? colors.textDim : priceColor(value)),
  });
  switch (column.id) {
    case "rank":
      return { text: String(row.rank), color: selectedColor ?? colors.textDim };
    case "code":
      return { text: row.code, color: selectedColor ?? colors.textBright, attributes: TextAttributes.BOLD };
    case "name":
      return { text: row.name, color: selectedColor };
    case "price":
      return { text: row.priceText, color: selectedColor };
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
      return { text: row.volume24h == null ? "—" : formatCompact(row.volume24h, { fixedDecimals: true }), color: selectedColor ?? colors.textDim };
    case "marketCap":
      return { text: row.marketCap == null ? "—" : formatCompact(row.marketCap, { fixedDecimals: true }), color: selectedColor ?? colors.textDim };
  }
}

export function CryptoBoardPane({ width, height, focused }: PaneProps) {
  const session = useResearchCloudSession();
  const loader = useCallback((force: boolean) => loadCryptoMarkets(force), [session.requestKey]);
  const resource = useAsyncResource(loader, { initialData: cachedCryptoMarkets, clearOnError: clearDenied });
  const data = resource.data?.payload;
  const { pinTicker } = usePluginTickerActions();
  const liveStreaming = useLiveStreamingSetting();
  const [activeTab, setActiveTab] = usePluginPaneState<CryptoAssetKind>("activeTab", "coin");
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selected", null);
  const [sort, setSort] = useState<CryptoSortPreference>(DEFAULT_CRYPTO_SORT);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: INITIAL_STREAM_ROWS });
  const appVisible = useAppVisible();
  const reloadBoard = resource.load;
  useEffect(() => {
    if (!appVisible) return;
    const timer = setInterval(() => void reloadBoard(false), CRYPTO_BOARD_REFRESH_MS);
    return () => clearInterval(timer);
  }, [appVisible, reloadBoard]);

  const tabAssets = useMemo(
    () => data?.assets.filter((asset) => asset.kind === activeTab) ?? [],
    [activeTab, data],
  );
  // The stream follows the rows on screen. Ordering by the board snapshot keeps
  // live ticks from reshuffling the subscription; the overscan covers the drift.
  const streamedAssets = useMemo(() => {
    const ordered = sortCryptoRows(buildCryptoRows(tabAssets, activeTab, NO_QUOTES), sort).map((row) => row.asset);
    const window = ordered.slice(
      Math.max(0, visibleRange.start - STREAM_OVERSCAN),
      visibleRange.end + STREAM_OVERSCAN,
    );
    const selected = ordered.find((asset) => asset.symbol === selectedId);
    return selected && !window.includes(selected) ? [...window, selected] : window;
  }, [activeTab, selectedId, sort, tabAssets, visibleRange]);
  const targets = useMemo(() => quoteTargets(streamedAssets, selectedId), [selectedId, streamedAssets]);
  const { entries, freshnessNow } = useLiveQuoteEntries(targets, {
    freshnessScopeKey: `crypto-board:${activeTab}`,
    liveStreaming,
  });

  const rows = useMemo(
    () => sortCryptoRows(buildCryptoRows(tabAssets, activeTab, entries, freshnessNow), sort),
    [activeTab, entries, freshnessNow, sort, tabAssets],
  );
  useEffect(() => {
    if (!rows.length) return;
    if (!selectedId || !rows.some((row) => row.id === selectedId)) setSelectedId(rows[0]!.id);
  }, [rows, selectedId, setSelectedId]);

  const latestUpdate = rows.reduce<number | null>(
    (latest, row) => (row.updatedAt != null && (latest == null || row.updatedAt > latest) ? row.updatedAt : latest),
    null,
  );
  const columns = useMemo(() => buildCryptoColumns(width), [width]);

  const tabItems = CRYPTO_TABS.map((tab) => ({
    label: tab.label,
    value: tab.value,
  }));
  const selectTab = (value: string) => {
    setActiveTab(value as CryptoAssetKind);
    setSelectedId(null);
    setVisibleRange({ start: 0, end: INITIAL_STREAM_ROWS });
  };
  const tabsInHeader = usePaneHeaderTabs({ tabs: tabItems, activeValue: activeTab, onSelect: selectTab, focused });

  usePaneNoticeFooter({
    registrationId: "crypto-board:notices",
    focused,
    notices: [...(data?.warnings ?? []), ...(resource.data?.refreshError ? [resource.data.refreshError] : [])],
  });
  usePaneFooter("crypto-board", () => ({
    info: [
      // Background refreshes run every 15s; only the first load is worth a label.
      ...(resource.loading && !data ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(data && resource.error ? [{ id: "refresh", parts: [{ text: "refresh failed", tone: "warning" as const }] }] : []),
      ...(latestUpdate != null ? [{
        id: "updated",
        parts: [{
          text: new Date(latestUpdate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          tone: "muted" as const,
        }],
      }] : []),
      ...(resource.data?.stale ? [{ id: "cached", parts: [{ text: "cached", tone: "warning" as const }] }] : []),
    ],
  }), [data, latestUpdate, resource.data?.stale, resource.error, resource.loading]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (event.name !== "r") return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    void resource.reload();
    return true;
  }, [resource.reload]);

  return (
    <Box width={width} height={height} flexDirection="column">
      {!tabsInHeader && (
        <Box height={1} paddingX={1}>
          <Tabs tabs={tabItems} activeValue={activeTab} onSelect={selectTab} compact variant="bare" focused={focused} />
        </Box>
      )}
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
          sortColumnId={sort.columnId}
          sortDirection={sort.direction}
          onHeaderClick={(columnId) => setSort((current) => nextCryptoSort(current, columnId))}
          getItemKey={(row) => row.id}
          onActivate={(row) => pinTicker(cryptoTickerKey(row), {
            floating: true,
            paneType: TICKER_RESEARCH_PANE_ID,
            instrument: null,
          })}
          visibleRangeKey={`${activeTab}:${sort.columnId}:${sort.direction}`}
          onVisibleRangeChange={setVisibleRange}
          renderCell={(row, column, _index, rowState) => renderCryptoCell(row, column, rowState.selected)}
          emptyStateTitle="No crypto assets returned."
        />
      </PaneStatusBody>
    </Box>
  );
}
