import { useCallback, useId, useMemo, useRef } from "react";
import {
  buildMetricTreemapNavigationTiles,
  findMetricTreemapNeighbor,
  MetricTreemapSurface,
  useTickerRowPaneMenu,
  type MetricTreemapDirection,
  type MetricTreemapItem,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import type { ColumnConfig } from "../../../types/config";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { useUiCapabilities } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { createRowValueCache, type RowValueCache } from "../../../components/ui/row-value-cache";
import { objectVersion } from "../../../utils/object-version";
import { columnContextVersion } from "./cell-version";
import { getColumnValue, getSortValue, type ColumnContext } from "./metrics";
import { getPortfolioPositionMetrics, getPortfolioQuoteDisplay } from "../../../portfolio/position-metrics";
import { tickerDisplayName } from "../../../portfolio/column-values";
import { PORTFOLIO_ROW_MENU_KEYS } from "./row-actions";
import { PORTFOLIO_REORDER_THROTTLE_MS } from "./use-throttled-ticker-order";
import { useThrottledMemo } from "./use-throttled-memo";
import { listedSymbol } from "../../../portfolio/listed-symbol";

// Tile text and colour follow quotes a few times a second; tile areas only
// move on the reorder cadence, so a tick does not reshuffle the layout.
const GRID_TILE_THROTTLE_MS = 250;

const PRICE_COLUMN: ColumnConfig = { id: "price", label: "Last", width: 10, align: "right" };
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
  if (!isPortfolioTab) return numericValue(getSortValue(CHANGE_PCT_COLUMN, ticker, financials, context));
  // The move the position is valued on, like its DAY P&L: an option's mark, not its last print.
  const quote = financials?.quote;
  const currency = quoteCurrency(ticker, financials);
  const valuation = getPortfolioQuoteDisplay(getPortfolioPositionMetrics(ticker, context.activeTab, currency, undefined, quote), quote);
  const changePercent = numericValue(valuation?.changePercent ?? null);
  if (changePercent == null) return null;
  const positionMetrics = getPortfolioPositionMetrics(ticker, context.activeTab, currency);
  return positionMetrics.grossPriceUnits > 0
    ? changePercent * positionMetrics.totalPriceUnits / positionMetrics.grossPriceUnits
    : null;
}

/**
 * A portfolio's ticker it holds no position in: one followed, as setup adds a
 * holding entered without shares. Its tile reads like a watchlist entry.
 */
function isFollowedOnly(
  ticker: TickerRecord,
  financials: TickerFinancials | undefined,
  context: ColumnContext,
  isPortfolioTab: boolean,
): boolean {
  return isPortfolioTab
    && getPortfolioPositionMetrics(ticker, context.activeTab, quoteCurrency(ticker, financials)).positionCount === 0;
}

function tileWeight(
  ticker: TickerRecord,
  financials: TickerFinancials | undefined,
  context: ColumnContext,
  isPortfolioTab: boolean,
): number {
  const weightColumn = isPortfolioTab ? MARKET_VALUE_COLUMN : MARKET_CAP_COLUMN;
  const fallbackColumn = isPortfolioTab ? MARKET_CAP_COLUMN : VOLUME_COLUMN;
  const weight = numericValue(getSortValue(weightColumn, ticker, financials, context))
    ?? numericValue(getSortValue(fallbackColumn, ticker, financials, context))
    ?? 1;
  return Math.max(1, Math.abs(weight));
}

/**
 * Each tile's area: a holding's market value, else what a watchlist sizes by.
 * A followed ticker beside holdings takes the smallest holding's area, since
 * its market cap would bury every position the portfolio values.
 */
function gridTileWeights(
  tickers: TickerRecord[],
  financialsMap: Map<string, TickerFinancials>,
  context: ColumnContext,
  isPortfolioTab: boolean,
): Map<string, number> {
  const weights = new Map<string, number>();
  const followed: string[] = [];
  let smallestHeld = Number.POSITIVE_INFINITY;
  for (const ticker of tickers) {
    const symbol = ticker.metadata.ticker;
    const financials = financialsMap.get(symbol);
    const weight = tileWeight(ticker, financials, context, isPortfolioTab);
    weights.set(symbol, weight);
    if (isFollowedOnly(ticker, financials, context, isPortfolioTab)) followed.push(symbol);
    else smallestHeld = Math.min(smallestHeld, weight);
  }
  if (Number.isFinite(smallestHeld)) {
    for (const symbol of followed) weights.set(symbol, smallestHeld);
  }
  return weights;
}

const TILE_COLUMN_IDS = [PRICE_COLUMN, MARKET_CAP_COLUMN, MARKET_VALUE_COLUMN, CHANGE_PCT_COLUMN, DAY_PNL_COLUMN, VOLUME_COLUMN, WEIGHT_COLUMN]
  .map((column) => column.id);

function tileVersion(
  ticker: TickerRecord,
  financials: TickerFinancials | undefined,
  context: ColumnContext,
  isPortfolioTab: boolean,
  weight: number | undefined,
): string {
  // The label names the venue by the list's home market (BA:LSE in a US list), so a tile is rebuilt when it changes.
  return `${isPortfolioTab}|${weight ?? ""}|${context.homeMarket ?? ""}|${objectVersion(ticker)}|${objectVersion(financials)}|${
    TILE_COLUMN_IDS.map((columnId) => columnContextVersion(columnId, context)).join("|")}`;
}

function buildPortfolioGridItems(
  tickers: TickerRecord[],
  financialsMap: Map<string, TickerFinancials>,
  context: ColumnContext,
  isPortfolioTab: boolean,
  layoutWeights: ReadonlyMap<string, number>,
  cache: RowValueCache<string, MetricTreemapItem<TickerRecord>>,
): Array<MetricTreemapItem<TickerRecord>> {
  return tickers.map((ticker) => {
    const symbol = ticker.metadata.ticker;
    const financials = financialsMap.get(symbol);
    const layoutWeight = layoutWeights.get(symbol);
    const version = tileVersion(ticker, financials, context, isPortfolioTab, layoutWeight);
    return cache.get(symbol, version, () => buildPortfolioGridItem(ticker, financials, context, isPortfolioTab, layoutWeight));
  });
}

function buildPortfolioGridItem(
  ticker: TickerRecord,
  financials: TickerFinancials | undefined,
  context: ColumnContext,
  isPortfolioTab: boolean,
  layoutWeight: number | undefined,
): MetricTreemapItem<TickerRecord> {
  const symbol = ticker.metadata.ticker;
  const change = getColumnValue(CHANGE_PCT_COLUMN, ticker, financials, context).text;
  // As the watchlist table lists it, by its price and day's move: a position's
  // value, day P&L and weight would be a dash on every line.
  const followed = isFollowedOnly(ticker, financials, context, isPortfolioTab);
  const held = isPortfolioTab && !followed;
  const primaryColumn = followed ? PRICE_COLUMN : isPortfolioTab ? MARKET_VALUE_COLUMN : MARKET_CAP_COLUMN;
  const primary = getColumnValue(primaryColumn, ticker, financials, context).text;
  const secondary = held
    ? `${getColumnValue(DAY_PNL_COLUMN, ticker, financials, context).text} ${change}`
    : change;
  const tertiary = followed
    ? null
    : getColumnValue(held ? WEIGHT_COLUMN : VOLUME_COLUMN, ticker, financials, context).text;

  return {
    id: symbol,
    // As the table's Ticker column names it: an option reads as its contract, not its OCC code, BA on LSE in a US list as BA:LSE.
    label: listedSymbol(ticker, tickerDisplayName(ticker), context.homeMarket),
    weight: layoutWeight ?? tileWeight(ticker, financials, context, isPortfolioTab),
    colorValue: positionAdjustedChangePercent(ticker, financials, context, held),
    primaryText: primary,
    secondaryText: secondary,
    tertiaryText: tertiary,
    data: ticker,
  };
}

export function PortfolioGrid({
  sortedTickers,
  financialsMap,
  columnContext,
  isPortfolioTab,
  cursorSymbol,
  setCursorSymbol,
  onRowActivate,
  onOpenInNewPane,
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
  onOpenInNewPane: (ticker: TickerRecord) => void;
  focused?: boolean;
  width: number;
  height: number;
}) {
  const { cellWidthPx = 8, cellHeightPx = 18, nativePaneChrome } = useUiCapabilities();
  const chartWidth = Math.max(1, width - 2);
  const cellAspect = Math.max(0.5, Math.min(4, cellHeightPx / Math.max(1, cellWidthPx)));
  const tileCacheRef = useRef(createRowValueCache<string, MetricTreemapItem<TickerRecord>>(2000));
  // Structure applies at once: membership, committed order, edited records,
  // the collection and the base currency. Only quote-driven inputs are throttled.
  const recordsKey = sortedTickers.map((ticker) => objectVersion(ticker)).join(",");
  const structureDeps = [isPortfolioTab, recordsKey, columnContext.activeTab, columnContext.baseCurrency];
  const layoutWeights = useThrottledMemo(
    () => gridTileWeights(sortedTickers, financialsMap, columnContext, isPortfolioTab),
    [financialsMap, columnContext],
    structureDeps,
    PORTFOLIO_REORDER_THROTTLE_MS,
  );
  const items = useThrottledMemo(
    () => buildPortfolioGridItems(sortedTickers, financialsMap, columnContext, isPortfolioTab, layoutWeights, tileCacheRef.current),
    [financialsMap, columnContext, layoutWeights, sortedTickers],
    structureDeps,
    GRID_TILE_THROTTLE_MS,
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
  const scopeId = useId();

  // The tile under the cursor gets the ticker table's row menu in the pane menu.
  const activeTicker = sortedTickers[activeIdx] ?? null;
  useTickerRowPaneMenu({
    ticker: activeTicker,
    financials: activeTicker ? financialsMap.get(activeTicker.metadata.ticker) ?? null : null,
    enabled: !!focused,
    accelerators: PORTFOLIO_ROW_MENU_KEYS,
  });

  // Arrows move between tiles by position and j/k by size order; h/l are left
  // to the collection tabs. The scope puts the arrows ahead of the tabs, which
  // would otherwise take left and right as well.
  useShortcut((event) => {
    if (!focused) return;
    if (isPlainKey(event, "home", "end", "pageup", "pagedown")) {
      if (sortedTickers.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      // Every tile is on screen, so a page is the whole map, as in a list that fits.
      selectIndex(event.name === "home" || event.name === "pageup" ? 0 : sortedTickers.length - 1);
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
    if (isPlainKey(event, "left")) {
      event.preventDefault();
      event.stopPropagation();
      selectNeighbor("left");
      return;
    }
    if (isPlainKey(event, "right")) {
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
    // Enter opens the tile, Shift+Enter in a new floating pane, as in the table.
    if ((event.name === "enter" || event.name === "return") && !event.ctrl && !event.meta && !event.super && !event.alt) {
      const ticker = sortedTickers[activeIdx];
      if (!ticker) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.shift) onOpenInNewPane(ticker);
      else onRowActivate(ticker);
    }
  }, { enabled: focused, scope: `portfolio-grid:${scopeId}` });

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
