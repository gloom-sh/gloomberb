import { useCallback, useMemo } from "react";
import {
  buildMetricTreemapNavigationTiles,
  findMetricTreemapNeighbor,
  MetricTreemapSurface,
  type MetricTreemapDirection,
  type MetricTreemapItem,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import type { ColumnConfig } from "../../../types/config";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { useUiCapabilities } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { getColumnValue, getSortValue, type ColumnContext } from "./metrics";
import { getPortfolioPositionMetrics } from "./position-metrics";

const MARKET_CAP_COLUMN: ColumnConfig = { id: "market_cap", label: "Mkt Cap", width: 10, align: "right" };
const MARKET_VALUE_COLUMN: ColumnConfig = { id: "mkt_value", label: "Mkt Value", width: 10, align: "right" };
const CHANGE_PCT_COLUMN: ColumnConfig = { id: "change_pct", label: "Change", width: 8, align: "right" };
const DAY_PNL_COLUMN: ColumnConfig = { id: "day_pnl", label: "Day P&L", width: 10, align: "right" };
const VOLUME_COLUMN: ColumnConfig = { id: "volume", label: "Volume", width: 9, align: "right" };
const WEIGHT_COLUMN: ColumnConfig = { id: "weight", label: "Weight", width: 8, align: "right" };

function numericValue(value: number | string | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function quoteCurrency(ticker: TickerRecord, financials: TickerFinancials | undefined): string {
  return financials?.quote?.currency || ticker.metadata.currency || "USD";
}

function positionAdjustedChangePercent(
  ticker: TickerRecord,
  financials: TickerFinancials | undefined,
  context: ColumnContext,
  isPortfolioTab: boolean,
): number | null {
  const changePercent = numericValue(getSortValue(CHANGE_PCT_COLUMN, ticker, financials, context));
  if (changePercent == null || !isPortfolioTab) return changePercent;
  const positionMetrics = getPortfolioPositionMetrics(ticker, context.activeTab, quoteCurrency(ticker, financials));
  return positionMetrics.grossPriceUnits > 0
    ? changePercent * positionMetrics.totalPriceUnits / positionMetrics.grossPriceUnits
    : null;
}

function buildPortfolioGridItems(
  tickers: TickerRecord[],
  financialsMap: Map<string, TickerFinancials>,
  context: ColumnContext,
  isPortfolioTab: boolean,
): Array<MetricTreemapItem<TickerRecord>> {
  return tickers.map((ticker) => {
    const symbol = ticker.metadata.ticker;
    const financials = financialsMap.get(symbol);
    const weightColumn = isPortfolioTab ? MARKET_VALUE_COLUMN : MARKET_CAP_COLUMN;
    const primaryColumn = isPortfolioTab ? MARKET_VALUE_COLUMN : MARKET_CAP_COLUMN;
    const fallbackColumn = isPortfolioTab ? MARKET_CAP_COLUMN : VOLUME_COLUMN;
    const weight = numericValue(getSortValue(weightColumn, ticker, financials, context))
      ?? numericValue(getSortValue(fallbackColumn, ticker, financials, context))
      ?? 1;
    const primary = getColumnValue(primaryColumn, ticker, financials, context).text;
    const change = getColumnValue(CHANGE_PCT_COLUMN, ticker, financials, context).text;
    const secondary = isPortfolioTab
      ? `${getColumnValue(DAY_PNL_COLUMN, ticker, financials, context).text} ${change}`
      : change;
    const tertiary = isPortfolioTab
      ? getColumnValue(WEIGHT_COLUMN, ticker, financials, context).text
      : getColumnValue(VOLUME_COLUMN, ticker, financials, context).text;

    return {
      id: symbol,
      label: symbol,
      weight: Math.max(1, Math.abs(weight)),
      colorValue: positionAdjustedChangePercent(ticker, financials, context, isPortfolioTab),
      primaryText: primary,
      secondaryText: secondary,
      tertiaryText: tertiary,
      data: ticker,
    };
  });
}

export function PortfolioGrid({
  sortedTickers,
  financialsMap,
  columnContext,
  isPortfolioTab,
  cursorSymbol,
  setCursorSymbol,
  onRowActivate,
  onToggleViewMode,
  focused,
  width,
  height,
}: {
  sortedTickers: TickerRecord[];
  financialsMap: Map<string, TickerFinancials>;
  columnContext: ColumnContext;
  isPortfolioTab: boolean;
  cursorSymbol: string | null;
  setCursorSymbol: (symbol: string) => void;
  onRowActivate: (ticker: TickerRecord) => void;
  onToggleViewMode: () => void;
  focused?: boolean;
  width: number;
  height: number;
}) {
  const { cellWidthPx = 8, cellHeightPx = 18, nativePaneChrome } = useUiCapabilities();
  const chartWidth = Math.max(1, width - 2);
  const cellAspect = Math.max(0.5, Math.min(4, cellHeightPx / Math.max(1, cellWidthPx)));
  const items = useMemo(
    () => buildPortfolioGridItems(sortedTickers, financialsMap, columnContext, isPortfolioTab),
    [columnContext, financialsMap, isPortfolioTab, sortedTickers],
  );
  const navigationTiles = useMemo(
    () => buildMetricTreemapNavigationTiles(items, chartWidth, height, cellAspect, nativePaneChrome ? "float" : "integer"),
    [cellAspect, chartWidth, height, items, nativePaneChrome],
  );
  const selectedIdx = cursorSymbol
    ? sortedTickers.findIndex((ticker) => ticker.metadata.ticker === cursorSymbol)
    : -1;
  const activeIdx = selectedIdx >= 0 ? selectedIdx : (sortedTickers.length > 0 ? 0 : -1);

  const selectIndex = useCallback((index: number) => {
    const ticker = sortedTickers[index];
    if (ticker) setCursorSymbol(ticker.metadata.ticker);
  }, [setCursorSymbol, sortedTickers]);

  const selectNeighbor = useCallback((direction: MetricTreemapDirection) => {
    const target = findMetricTreemapNeighbor(navigationTiles, cursorSymbol, direction);
    if (target) setCursorSymbol(target.item.data.metadata.ticker);
  }, [cursorSymbol, navigationTiles, setCursorSymbol]);

  useShortcut((event) => {
    if (!focused) return;
    if (isPlainKey(event, "s")) {
      event.preventDefault();
      event.stopPropagation();
      onToggleViewMode();
      return;
    }
    if (isPlainKey(event, "j")) {
      event.preventDefault();
      event.stopPropagation();
      selectIndex(Math.min((activeIdx >= 0 ? activeIdx : 0) + 1, sortedTickers.length - 1));
      return;
    }
    if (isPlainKey(event, "k")) {
      event.preventDefault();
      event.stopPropagation();
      selectIndex(Math.max((activeIdx >= 0 ? activeIdx : 0) - 1, 0));
      return;
    }
    if (isPlainKey(event, "left", "h")) {
      event.preventDefault();
      event.stopPropagation();
      selectNeighbor("left");
      return;
    }
    if (isPlainKey(event, "right", "l")) {
      event.preventDefault();
      event.stopPropagation();
      selectNeighbor("right");
      return;
    }
    if (isPlainKey(event, "up")) {
      event.preventDefault();
      event.stopPropagation();
      selectNeighbor("up");
      return;
    }
    if (isPlainKey(event, "down")) {
      event.preventDefault();
      event.stopPropagation();
      selectNeighbor("down");
      return;
    }
    if (isPlainKey(event, "enter", "return")) {
      const ticker = sortedTickers[activeIdx];
      if (!ticker) return;
      event.preventDefault();
      event.stopPropagation();
      onRowActivate(ticker);
    }
  }, { enabled: focused });

  return (
    <MetricTreemapSurface
      items={items}
      width={width}
      height={height}
      selectedId={cursorSymbol}
      onSelect={(item) => setCursorSymbol(item.data.metadata.ticker)}
      onActivate={(item) => onRowActivate(item.data)}
      emptyStateTitle={isPortfolioTab ? "No portfolio positions" : "No watchlist tickers"}
    />
  );
}
