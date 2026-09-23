import { Box, ScrollBox, Text, type InputRenderable, type ScrollBoxRenderable } from "../../../ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { PaneStatusBody, QueryBar, usePaneFooter, usePaneNoticeFooter } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { colors } from "../../../theme/colors";
import { usePluginTickerActions } from "../../runtime";
import { useAppSelector, usePaneInstance, usePaneSettingValue } from "../../../state/app/context";
import { useChartQueries } from "../../../market-data/hooks";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { useShortcut } from "../../../react/input";
import { buildChartKey } from "../../../market-data/selectors";
import { formatTickerListInput } from "../../../tickers/list";
import { isPlainKey } from "../../../utils/keyboard";
import { formatCorrelation } from "./compute";
import {
  CORRELATION_RANGE_OPTIONS,
  DEFAULT_CORRELATION_SYMBOLS,
  MAX_CORRELATION_TICKERS,
  buildCorrelationSettingsDef,
  getCorrelationPaneSettings,
  type CorrelationRangePreset,
} from "./settings";
import { resolveCorrelationHeatmapCellColors } from "./colors";
import {
  buildRelationshipGraphSettingsDef,
  createRelationshipPaneTemplate,
  RELATIONSHIP_GRAPH_PANE_ID,
  RelationshipGraphPane,
} from "./relationship/pane";
import {
  MATRIX_CELL_WIDTH,
  MIN_MATRIX_CELL_WIDTH,
  ROW_HEADER_WIDTH,
  buildCorrelationMatrix,
  buildCorrelationPaneTitle,
  buildStatusSummary,
  type CorrelationSeries,
  displaySymbol,
  getSeriesForEntry,
  pairKey,
  rowHeaderColor,
} from "./matrix/model";
import { SymbolLabelCell } from "./matrix/symbol-cell";
import { correlationHeadless, relationshipHeadless } from "./headless";

function CorrelationMatrixPane({ focused, width, height }: PaneProps) {
  const pane = usePaneInstance();
  const { navigateTicker, pinTicker } = usePluginTickerActions();
  const tickers = useAppSelector((state) => state.tickers);
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null);
  const settings = useMemo(() => getCorrelationPaneSettings(pane?.settings), [pane?.settings]);
  const [rangePreset, setRangePreset] = usePaneSettingValue<CorrelationRangePreset>("rangePreset", settings.rangePreset);
  const [symbolsText, setSymbolsText] = usePaneSettingValue<string>("symbolsText", settings.symbolsText);
  const [symbolsEditing, setSymbolsEditing] = useState(false);
  const [symbolsFocusToken, setSymbolsFocusToken] = useState(0);
  const symbolsInputRef = useRef<InputRenderable | null>(null);
  // The list as it was when editing began, for Esc to put back. The field
  // applies drafts as they are typed, so the saved value is not it.
  const symbolsBeforeEditRef = useRef(symbolsText);
  // Remounts the query bar so the field drops the draft Esc threw away.
  const [queryBarRevision, setQueryBarRevision] = useState(0);
  const matrixScrollRef = useRef<ScrollBoxRenderable | null>(null);

  const instruments = useMemo(() => {
    if (settings.symbolsError) return [];
    return settings.symbols.map((symbol) => {
      const ticker = tickers.get(symbol);
      return {
        symbol,
        exchange: ticker?.metadata.exchange ?? "",
      };
    });
  }, [settings.symbols.join(","), settings.symbolsError, tickers]);

  const instrumentKey = instruments.map((instrument) => `${instrument.symbol}|${instrument.exchange}`).join(",");

  const chartRequests = useMemo(
    () => instruments.map((instrument) => ({
      instrument: {
        symbol: instrument.symbol,
        exchange: instrument.exchange,
      },
      bufferRange: settings.rangePreset,
      granularity: "resolution" as const,
      resolution: "1d" as const,
    })),
    [instrumentKey, settings.rangePreset],
  );

  const chartEntries = useChartQueries(chartRequests);

  const seriesBySymbol = useMemo(() => {
    const map = new Map<string, CorrelationSeries>();
    for (let i = 0; i < instruments.length; i++) {
      const instrument = instruments[i]!;
      const request = chartRequests[i]!;
      const key = buildChartKey(request);
      const entry = chartEntries.get(key);
      map.set(instrument.symbol, getSeriesForEntry(instrument.symbol, entry, settings.rangePreset));
    }
    return map;
  }, [chartEntries, chartRequests, instruments, settings.rangePreset]);

  const symbols = instruments.map((instrument) => instrument.symbol);
  const symbolsKey = symbols.join(",");

  const matrix = useMemo(() => {
    return buildCorrelationMatrix(symbols, seriesBySymbol);
  }, [symbolsKey, seriesBySymbol]);

  const statusSummary = useMemo(
    () => buildStatusSummary(symbols, seriesBySymbol, matrix.sampleMin, matrix.sampleMax, matrix.hasThinPair),
    [symbolsKey, seriesBySymbol, matrix.sampleMin, matrix.sampleMax, matrix.hasThinPair],
  );

  const refresh = useCallback(() => {
    const coordinator = getSharedMarketDataCoordinator();
    for (const request of chartRequests) void coordinator?.loadChart(request, { forceRefresh: true });
  }, [chartRequests]);

  const openSymbol = useCallback((symbol: string) => {
    if (tickers.has(symbol)) {
      pinTicker(symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
      return;
    }
    navigateTicker(symbol);
  }, [navigateTicker, pinTicker, tickers]);

  /** The row cursor shares the hover highlight, so mouse and keys point at one symbol. */
  const moveSymbolCursor = useCallback((offset: -1 | 1) => {
    if (symbols.length === 0) return;
    const index = hoveredSymbol ? symbols.indexOf(hoveredSymbol) : -1;
    const next = index < 0
      ? (offset > 0 ? 0 : symbols.length - 1)
      : Math.max(0, Math.min(symbols.length - 1, index + offset));
    setHoveredSymbol(symbols[next]!);
    const scroll = matrixScrollRef.current;
    if (!scroll) return;
    const viewportHeight = Math.max(1, scroll.viewport?.height ?? 1);
    if (next < scroll.scrollTop) scroll.scrollTo(next);
    else if (next + 1 > scroll.scrollTop + viewportHeight) scroll.scrollTo(next + 1 - viewportHeight);
  }, [hoveredSymbol, symbolsKey]);

  useShortcut((event) => {
    if (!focused || symbolsEditing || event.defaultPrevented) return;
    if (isPlainKey(event, "r")) {
      event.preventDefault();
      event.stopPropagation();
      refresh();
    } else if (isPlainKey(event, "j", "down", "k", "up")) {
      event.preventDefault();
      event.stopPropagation();
      moveSymbolCursor(event.name === "j" || event.name === "down" ? 1 : -1);
    } else if (isPlainKey(event, "return", "enter") && hoveredSymbol && symbols.includes(hoveredSymbol)) {
      event.preventDefault();
      event.stopPropagation();
      openSymbol(hoveredSymbol);
    }
  });

  // Esc cancels an edit of the list instead of clearing it: the field's own
  // Esc empties the draft, which would fall back to the default tickers.
  useShortcut((event) => {
    if (!isPlainKey(event, "escape", "esc")) return;
    event.preventDefault();
    event.stopPropagation();
    if (symbolsText !== symbolsBeforeEditRef.current) setSymbolsText(symbolsBeforeEditRef.current);
    setSymbolsEditing(false);
    setQueryBarRevision((revision) => revision + 1);
  }, {
    allowEditable: true,
    enabled: focused && symbolsEditing,
    phase: "before",
    scope: "correlation:tickers",
  });
  usePaneNoticeFooter({
    registrationId: "correlation-warnings", focused,
    notices: [...seriesBySymbol.values()].flatMap((series) => series.refreshError
      ? [`${series.symbol}: ${series.refreshError}${series.fetchedAt ? ` Retained history retrieved ${new Date(series.fetchedAt).toISOString()}.` : ""}`]
      : []),
  });

  // The ticker set and range are visible in-pane and an invalid list shows in
  // the body, so the footer only carries load state. `r` is global: no hint.
  usePaneFooter("correlation", () => ({
    info: !settings.symbolsError && symbols.length >= 2 && statusSummary
      ? [{ id: "status", parts: [{ text: statusSummary, tone: "muted" as const }] }]
      : [],
  }), [settings.symbolsError, statusSummary, symbols.length]);

  const clearHoveredSymbol = useCallback((symbol: string) => {
    setHoveredSymbol((current) => (current === symbol ? null : current));
  }, []);

  const headerBg = colors.panel;
  const rowHeaderWidth = Math.max(
    ROW_HEADER_WIDTH,
    Math.min(12, Math.max(0, ...symbols.map((symbol) => displaySymbol(symbol).length)) + 2),
  );
  const cellCount = Math.max(1, symbols.length);
  const availableCellWidth = Math.floor((Math.max(width - rowHeaderWidth - 4, cellCount * MIN_MATRIX_CELL_WIDTH)) / cellCount);
  const cellWidth = Math.max(MIN_MATRIX_CELL_WIDTH, Math.min(MATRIX_CELL_WIDTH, availableCellWidth));
  // Rows are exactly as wide as the matrix (after the one-cell inset), so the
  // zebra and hover bands stop at the last column instead of running on.
  const matrixRowWidth = 1 + rowHeaderWidth + symbols.length * cellWidth;
  const bodyStatus = settings.symbolsError
    ? <PaneStatusBody error={settings.symbolsError} />
    : symbols.length < 2
      ? <PaneStatusBody empty emptyTitle="Enter at least 2 tickers." />
      : null;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <QueryBar
        key={queryBarRevision}
        width={width}
        search={{
          value: symbolsText,
          onChange: (query) => setSymbolsText(query),
          placeholder: "tickers",
          focused,
          active: symbolsEditing,
          onActiveChange: (active) => {
            if (!active) {
              setSymbolsEditing(false);
              return;
            }
            if (!symbolsEditing) symbolsBeforeEditRef.current = symbolsText;
            setSymbolsEditing(true);
            setSymbolsFocusToken((token) => token + 1);
          },
          focusToken: symbolsFocusToken,
          inputRef: symbolsInputRef,
          debounceMs: 500,
        }}
        view={{
          value: rangePreset,
          options: CORRELATION_RANGE_OPTIONS.map((range) => ({ label: range, value: range })),
          onChange: (value: string) => setRangePreset(value as CorrelationRangePreset),
          focused: focused && !symbolsEditing,
          shortcutScope: "correlation:range",
        }}
      />
      {bodyStatus ?? (
        <>
          {/* Column header row */}
          <Box flexDirection="row" paddingLeft={1} height={1} width={matrixRowWidth} backgroundColor={headerBg}>
            <Box width={rowHeaderWidth} flexShrink={0} />
            {symbols.map((sym) => (
              <SymbolLabelCell
                key={sym}
                symbol={sym}
                width={cellWidth}
                align="flex-end"
                color={colors.textDim}
                hovered={hoveredSymbol === sym}
                onHover={setHoveredSymbol}
                onLeave={clearHoveredSymbol}
                onOpen={openSymbol}
              />
            ))}
          </Box>

          {/* Matrix rows */}
          <ScrollBox ref={matrixScrollRef} flexGrow={1} scrollY scrollX focusable={false}>
            <Box flexDirection="column">
              {symbols.map((rowSym, rowIndex) => (
                <Box key={rowSym} flexDirection="row" paddingLeft={1} width={matrixRowWidth} backgroundColor={rowIndex % 2 === 0 ? colors.bg : undefined}>
                  {/* Row header */}
                  <Box
                    width={rowHeaderWidth}
                    flexShrink={0}
                    overflow="hidden"
                  >
                    <SymbolLabelCell
                      symbol={rowSym}
                      width={rowHeaderWidth}
                      color={rowHeaderColor(seriesBySymbol.get(rowSym)?.status ?? "loading")}
                      hovered={hoveredSymbol === rowSym}
                      onHover={setHoveredSymbol}
                      onLeave={clearHoveredSymbol}
                      onOpen={openSymbol}
                    />
                  </Box>
                  {/* Cells */}
                  {symbols.map((colSym) => {
                    const r = matrix.results.get(pairKey(rowSym, colSym))?.correlation ?? null;
                    const cellColors = resolveCorrelationHeatmapCellColors(r);
                    const text = formatCorrelation(r);
                    return (
                      <Box
                        key={colSym}
                        width={cellWidth}
                        flexDirection="row"
                        justifyContent="flex-end"
                        paddingRight={1}
                        backgroundColor={cellColors.background}
                      >
                        <Text fg={cellColors.foreground}>{text}</Text>
                      </Box>
                    );
                  })}
                </Box>
              ))}
            </Box>
          </ScrollBox>
        </>
      )}
    </Box>
  );
}

export const correlationModule: PluginModule = {
  panes: [
    {
      id: "correlation",
      name: "Correlation Matrix",
      icon: "C",
      component: CorrelationMatrixPane,
      headless: correlationHeadless,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 90, height: 18 },
      settings: buildCorrelationSettingsDef(),
    },
    {
      id: RELATIONSHIP_GRAPH_PANE_ID,
      name: "Relationship Graph",
      icon: "R",
      component: RelationshipGraphPane,
      headless: relationshipHeadless,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
      settings: buildRelationshipGraphSettingsDef(),
    },
  ],

  paneTemplates: [
    {
      id: "correlation-pane",
      headless: correlationHeadless,
      paneId: "correlation",
      label: "Correlation Matrix",
      description: "Date-aligned Pearson correlation matrix for ticker returns.",
      keywords: ["correlation", "corr", "matrix", "pearson", "returns", "covariance"],
      shortcut: { prefix: "CORR", argPlaceholder: "tickers", argKind: "ticker-list" },
      wizard: [
        {
          key: "tickers",
          label: "Correlation Tickers",
          placeholder: formatTickerListInput(DEFAULT_CORRELATION_SYMBOLS),
          defaultValue: formatTickerListInput(DEFAULT_CORRELATION_SYMBOLS),
          body: [
            `Enter 2-${MAX_CORRELATION_TICKERS} ticker symbols separated by commas.`,
          ],
          type: "text",
        },
      ],
      createInstance: (_context, options) => {
        const symbols = options?.symbols && options.symbols.length >= 2
          ? options.symbols
          : DEFAULT_CORRELATION_SYMBOLS;
        return {
          title: buildCorrelationPaneTitle(),
          placement: "floating",
          settings: {
            rangePreset: "1Y",
            symbols,
            symbolsText: formatTickerListInput(symbols),
          },
        };
      },
    },
    { ...createRelationshipPaneTemplate(), headless: relationshipHeadless },
  ],
};
