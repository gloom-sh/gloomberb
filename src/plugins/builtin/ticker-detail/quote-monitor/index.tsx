import { useCallback, useMemo } from "react";
import { Box, useUiCapabilities } from "../../../../ui";
import type { PaneProps } from "../../../../types/plugin";
import { TICKER_RESEARCH_PANE_ID } from "../../../../types/config";
import type { QuoteSubscriptionTarget } from "../../../../types/data-provider";
import { quoteSubscriptionTargetFromTicker } from "../../../../market-data/request-types";
import { useAppSelector, usePaneInstance, usePaneTicker } from "../../../../state/app/context";
import { useQuoteUpdates } from "../../../../state/hooks/quote-streaming";
import { usePluginAppActions, usePluginTickerActions } from "../../../runtime";
import { colors } from "../../../../theme/colors";
import { EmptyState } from "../../../../components";
import { getQuoteMonitorPaneSettings } from "../settings";
import { useShortcut } from "../../../../react/input";
import { QuoteMonitorCard } from "./card";
import { useLiveStreamingSetting } from "../../shared/live-streaming";

function chunkSymbols(symbols: string[], columns: number): string[][] {
  const rows: string[][] = [];
  for (let index = 0; index < symbols.length; index += columns) {
    rows.push(symbols.slice(index, index + columns));
  }
  return rows;
}

function resolveGridColumnCount(symbolCount: number, width: number, height: number, nativePaneChrome: boolean): number {
  if (symbolCount <= 1) return 1;

  const contentWidth = Math.max(1, width - (nativePaneChrome ? 0 : 2));
  const contentHeight = Math.max(1, height);
  const minimumCellWidth = nativePaneChrome ? 34 : 28;
  const minimumCellHeight = nativePaneChrome ? 4 : 3;
  const maxColumns = Math.max(1, Math.min(symbolCount, Math.floor(contentWidth / minimumCellWidth)));
  const targetAspect = nativePaneChrome ? 5.5 : 4.5;
  let bestColumns = 1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let columns = 1; columns <= maxColumns; columns++) {
    const rows = Math.ceil(symbolCount / columns);
    const cellWidth = Math.floor(contentWidth / columns);
    const cellHeight = Math.floor(contentHeight / rows);
    const aspect = cellWidth / Math.max(1, cellHeight);
    const emptySlots = columns * rows - symbolCount;
    const widthPenalty = cellWidth < minimumCellWidth ? (minimumCellWidth - cellWidth) * 0.5 : 0;
    const heightPenalty = cellHeight < minimumCellHeight ? (minimumCellHeight - cellHeight) * 1.4 : 0;
    const score = Math.abs(Math.log(aspect / targetAspect))
      + emptySlots * 0.35
      + widthPenalty
      + heightPenalty
      - columns * 0.03;
    if (score < bestScore) {
      bestScore = score;
      bestColumns = columns;
    }
  }

  return bestColumns;
}

export function QuoteMonitorPane({ paneId, focused, width, height }: PaneProps) {
  const pane = usePaneInstance();
  const { symbol: fallbackSymbol, ticker: fallbackTicker } = usePaneTicker();
  const liveStreaming = useLiveStreamingSetting();
  const settings = useMemo(
    () => getQuoteMonitorPaneSettings(pane?.settings, fallbackSymbol),
    [fallbackSymbol, pane?.settings],
  );
  const symbols = settings.symbols;
  const financialsBySymbol = useAppSelector((state) => state.financials);
  const tickersBySymbol = useAppSelector((state) => state.tickers);
  const valueFlashingEnabled = useAppSelector((state) => state.config.valueFlashingEnabled);
  const streamingTargets = useMemo<QuoteSubscriptionTarget[]>(() => {
    const targets: QuoteSubscriptionTarget[] = [];
    for (const symbol of symbols) {
        const ticker = tickersBySymbol.get(symbol) ?? (fallbackTicker?.metadata.ticker === symbol ? fallbackTicker : null);
        const target = quoteSubscriptionTargetFromTicker(ticker, symbol, "provider");
        if (target) {
          targets.push({ ...target, surface: "monitor", visible: true, selected: symbol === fallbackSymbol, weight: symbol === fallbackSymbol ? 100 : 90 });
        }
    }
    return targets;
  }, [fallbackSymbol, fallbackTicker, symbols, tickersBySymbol]);
  useQuoteUpdates(streamingTargets, { liveStreaming });
  const { pinTicker } = usePluginTickerActions();
  const { openPaneSettings } = usePluginAppActions();
  const { nativePaneChrome } = useUiCapabilities();
  const openTicker = useCallback((nextSymbol: string) => {
    pinTicker(nextSymbol, { paneType: TICKER_RESEARCH_PANE_ID, floating: true });
  }, [pinTicker]);
  useShortcut((event) => {
    if (!focused || event.name !== "t") return;
    event.preventDefault?.();
    event.stopPropagation?.();
    openPaneSettings(paneId);
  });

  if (symbols.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <EmptyState title="No tickers selected." />
      </Box>
    );
  }

  const columns = resolveGridColumnCount(symbols.length, width, height, nativePaneChrome === true);
  const rows = chunkSymbols(symbols, columns);
  const contentWidth = Math.max(1, width - (nativePaneChrome ? 0 : 2));
  const contentHeight = Math.max(3, height);
  const cardHeight = Math.max(nativePaneChrome ? 4 : 3, Math.floor(contentHeight / rows.length));
  const cardWidth = Math.max(1, Math.floor(contentWidth / columns));

  if (nativePaneChrome) {
    return (
      <Box
        flexGrow={1}
        backgroundColor={colors.bg}
        overflow="hidden"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))",
          gridAutoRows: "minmax(66px, 1fr)",
          alignItems: "stretch",
          alignContent: "stretch",
          width: "100%",
          height: "100%",
        }}
      >
        {symbols.map((symbol) => {
          const ticker = tickersBySymbol.get(symbol) ?? (fallbackTicker?.metadata.ticker === symbol ? fallbackTicker : null);
          return (
            <QuoteMonitorCard
              key={symbol}
              symbol={symbol}
              ticker={ticker}
              cachedFinancials={financialsBySymbol.get(symbol) ?? null}
              width={width}
              height={height}
              showRightDivider={false}
              showBottomDivider
              chartPeriod={settings.chartPeriod}
              valueFlashingEnabled={valueFlashingEnabled}
              onOpen={openTicker}
            />
          );
        })}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      backgroundColor={colors.bg}
      paddingX={nativePaneChrome ? 0 : 1}
      paddingY={0}
      overflow="hidden"
    >
      {rows.map((row, rowIndex) => (
        <Box key={`${rowIndex}:${row.join(",")}`} flexDirection="row" height={cardHeight}>
          {row.map((symbol, columnIndex) => {
            const ticker = tickersBySymbol.get(symbol) ?? (fallbackTicker?.metadata.ticker === symbol ? fallbackTicker : null);
            return (
              <QuoteMonitorCard
                key={symbol}
                symbol={symbol}
                ticker={ticker}
                cachedFinancials={financialsBySymbol.get(symbol) ?? null}
                width={cardWidth}
                height={cardHeight}
                showRightDivider={columnIndex < row.length - 1}
                showBottomDivider={rowIndex < rows.length - 1}
                chartPeriod={settings.chartPeriod}
                valueFlashingEnabled={valueFlashingEnabled}
                onOpen={openTicker}
              />
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
