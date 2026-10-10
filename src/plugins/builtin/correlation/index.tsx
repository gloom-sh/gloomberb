import { Box, ScrollBox, Text, TextAttributes, type InputRenderable, type ScrollBoxRenderable } from "../../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PaneStatusBody, QueryBar, usePaneFooter, usePaneNoticeFooter } from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { afterLayout } from "../../../components/ui/reveal-in-scroll-box";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { colors } from "../../../theme/colors";
import { usePluginAppActions, usePluginTickerActions } from "../../runtime";
import { useAppSelector, usePaneInstance, usePaneSettingValue } from "../../../state/app/context";
import { useChartQueries } from "../../../market-data/hooks";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { useShortcut } from "../../../react/input";
import { buildChartKey } from "../../../market-data/selectors";
import { formatTickerListInput } from "../../../tickers/list";
import { isPlainKey } from "../../../utils/keyboard";
import { useAsyncResource } from "../../../react/async-resource";
import { cloudGeoRequest } from "../world-venue-map/client";
import { geoSeriesToken, loadGeoCorrelationHistory } from "./geo";
import { formatCorrelation, type DailyClose } from "./compute";
import {
  CORRELATION_RANGE_OPTIONS,
  DEFAULT_CORRELATION_SYMBOLS,
  MAX_CORRELATION_TICKERS,
  buildCorrelationSettingsDef,
  getCorrelationPaneSettings,
  type CorrelationRangePreset,
} from "./settings";
import { resolveHeatCellColors } from "../../../theme/heat-colors";
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
  buildGeoCorrelationSeries,
  buildStatusSummary,
  type CorrelationSeries,
  displaySymbol,
  getSeriesForEntry,
  pairKey,
  rowHeaderColor,
} from "./matrix/model";
import { SymbolLabelCell } from "./matrix/symbol-cell";
import { correlationHeadless, relationshipHeadless } from "./headless";
import { CORRELATION_HISTORY_RESOLUTION } from "./history";
import { buildMatrixPairHistory, clampMatrixCursor, matrixChartRows, matrixSelection, moveMatrixCursor, type MatrixCursor } from "./matrix/selection";
import { MatrixPairChart } from "./matrix/pair-chart";

/** A map series' values and when they arrived; after a failed load, the error and any values kept from before. */
interface GeoSeriesLoad {
  values?: DailyClose[];
  fetchedAt?: number;
  error?: string;
}

function CorrelationMatrixPane({ focused, width, height }: PaneProps) {
  const pane = usePaneInstance();
  const { navigateTicker, pinTicker } = usePluginTickerActions();
  const { createPaneFromTemplate } = usePluginAppActions();
  const tickers = useAppSelector((state) => state.tickers);
  const [{ cursor: cellCursor, hoveredSymbol }, setCursorState] = useState<{ cursor: MatrixCursor; hoveredSymbol: string | null }>({
    cursor: { row: 0, column: 1 }, hoveredSymbol: null,
  });
  const hoverSymbol = useCallback((symbol: string) => {
    setCursorState((current) => ({ ...current, hoveredSymbol: symbol }));
  }, []);
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
  const horizontalScrollRef = useRef<ScrollBoxRenderable | null>(null);

  const entries = settings.symbolsError ? [] : settings.symbols;
  const geoEntries = entries.filter((entry) => geoSeriesToken(entry));
  const geoKey = geoEntries.join(",");
  const instruments = useMemo(() => {
    if (settings.symbolsError) return [];
    return settings.symbols.filter((symbol) => !geoSeriesToken(symbol)).map((symbol) => {
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
      resolution: CORRELATION_HISTORY_RESOLUTION,
    })),
    [instrumentKey, settings.rangePreset],
  );

  const chartEntries = useChartQueries(chartRequests);

  // Map series load beside the tickers; one that fails leaves the others and every ticker pair working.
  // A failed refresh keeps the series' last values for the same range, as a ticker keeps its last history.
  const geoRetainedRef = useRef(new Map<string, { values: DailyClose[]; fetchedAt: number }>());
  const geoLoader = useMemo(() => geoKey ? async () => {
    const range = settings.rangePreset;
    const results = await Promise.allSettled(geoEntries.map((entry) => (
      loadGeoCorrelationHistory(cloudGeoRequest, geoSeriesToken(entry)!, range)
    )));
    return new Map(geoEntries.map((entry, index): [string, GeoSeriesLoad] => {
      const result = results[index]!;
      const key = `${range}|${entry}`;
      if (result.status === "fulfilled") {
        const loaded = { values: result.value, fetchedAt: Date.now() };
        geoRetainedRef.current.set(key, loaded);
        return [entry, loaded];
      }
      const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
      return [entry, { ...geoRetainedRef.current.get(key), error }];
    }));
  } : null, [geoKey, settings.rangePreset]);
  const geoHistory = useAsyncResource(geoLoader, { keepPreviousData: true });

  const seriesBySymbol = useMemo(() => {
    const map = new Map<string, CorrelationSeries>();
    for (let i = 0; i < instruments.length; i++) {
      const instrument = instruments[i]!;
      const request = chartRequests[i]!;
      const key = buildChartKey(request);
      const entry = chartEntries.get(key);
      map.set(instrument.symbol, getSeriesForEntry(instrument.symbol, entry, settings.rangePreset));
    }
    for (const symbol of geoEntries) {
      const loaded = geoHistory.data?.get(symbol);
      map.set(symbol, !loaded
        ? { symbol, prices: [], basis: "difference", status: "loading", observationCount: 0 }
        : loaded.values
          ? {
            ...buildGeoCorrelationSeries(symbol, loaded.values),
            loading: geoHistory.loading, refreshError: loaded.error, fetchedAt: loaded.fetchedAt,
          }
          : { symbol, prices: [], basis: "difference", status: "error", observationCount: 0, refreshError: loaded.error });
    }
    return map;
  }, [chartEntries, chartRequests, instruments, settings.rangePreset, geoKey, geoHistory.data, geoHistory.loading]);

  const symbols = entries;
  const symbolsKey = symbols.join(",");
  const cursor = clampMatrixCursor(cellCursor, symbols.length);
  const selection = matrixSelection(symbols, cursor);
  const pair = selection && selection[0] !== selection[1] ? selection : null;
  useEffect(() => {
    setCursorState((current) => ({ ...current, cursor: clampMatrixCursor(current.cursor, symbols.length) }));
  }, [symbolsKey]);
  const pairHistory = useMemo(() => pair ? buildMatrixPairHistory(
    seriesBySymbol.get(pair[0]), seriesBySymbol.get(pair[1]), settings.rangePreset,
  ) : null, [pair?.[0], pair?.[1], seriesBySymbol, settings.rangePreset]);

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
    if (geoKey) void geoHistory.reload();
  }, [chartRequests, geoKey, geoHistory.reload]);

  const openSymbol = useCallback((symbol: string) => {
    if (geoSeriesToken(symbol)) {
      createPaneFromTemplate("chart-composer-pane", { arg: symbol });
      return;
    }
    if (tickers.has(symbol)) {
      pinTicker(symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
      return;
    }
    navigateTicker(symbol);
  }, [createPaneFromTemplate, navigateTicker, pinTicker, tickers]);

  /** Hovered symbols remain a keyboard starting point; Left reaches their row cursor. */
  const moveCursor = (key: string) => {
    if (symbols.length === 0) return;
    setCursorState((current) => {
      const hoveredRow = current.hoveredSymbol ? symbols.indexOf(current.hoveredSymbol) : -1;
      const start = hoveredRow >= 0 ? { row: hoveredRow, column: -1 } : current.cursor;
      return { cursor: moveMatrixCursor(start, key, symbols.length), hoveredSymbol: null };
    });
  };

  useShortcut((event) => {
    if (!focused || symbolsEditing || event.defaultPrevented) return;
    if (handleRefreshKey(event, refresh, { stopPropagation: true })) return;
    if (isPlainKey(event, "j", "down", "k", "up", "h", "left", "l", "right")) {
      event.preventDefault();
      event.stopPropagation();
      moveCursor(event.name ?? event.key ?? "");
    } else if (isPlainKey(event, "return", "enter") && selection) {
      event.preventDefault();
      event.stopPropagation();
      if (hoveredSymbol && symbols.includes(hoveredSymbol)) openSymbol(hoveredSymbol);
      // Ratio and beta are price measures, so a pair with a map series charts both in G instead.
      else if (pair && pair.some((entry) => geoSeriesToken(entry))) createPaneFromTemplate("chart-composer-pane", { arg: formatTickerListInput(pair) });
      else if (pair) createPaneFromTemplate("relationship-graph-pane", { symbols: pair, arg: formatTickerListInput(pair) });
      else openSymbol(selection[0]);
    }
  }, { phase: "before", scope: "correlation:matrix" });

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
      : []).concat(pair && pairHistory?.unavailable ? [`${pair.join("/")}: ${pairHistory.unavailable}`] : []),
  });

  // The ticker set and range are visible in-pane and an invalid list shows in
  // the body, so the footer only carries load state. `r` is global: no hint.
  usePaneFooter("correlation", () => ({
    info: !settings.symbolsError && symbols.length >= 2 && statusSummary
      ? [{ id: "status", parts: [{ text: statusSummary, tone: "muted" as const }] }]
      : [],
  }), [settings.symbolsError, statusSummary, symbols.length]);

  const clearHoveredSymbol = useCallback((symbol: string) => {
    setCursorState((current) => current.hoveredSymbol === symbol ? { ...current, hoveredSymbol: null } : current);
  }, []);

  const headerBg = colors.panel;
  const labelWidth = Math.max(0, ...symbols.map((symbol) => displaySymbol(symbol).length));
  const rowHeaderWidth = Math.max(ROW_HEADER_WIDTH, Math.min(12, labelWidth + 2));
  // A map series label (SUEZ.TANKER) is wider than a ticker's: columns keep room for it and the matrix scrolls instead.
  const minCellWidth = Math.max(MIN_MATRIX_CELL_WIDTH, labelWidth + 2);
  const cellCount = Math.max(1, symbols.length);
  const availableCellWidth = Math.floor((Math.max(width - rowHeaderWidth - 4, cellCount * minCellWidth)) / cellCount);
  const cellWidth = Math.max(minCellWidth, Math.min(MATRIX_CELL_WIDTH, availableCellWidth));
  // Rows are exactly as wide as the matrix (after the one-cell inset), so the
  // zebra and hover bands stop at the last column instead of running on.
  const matrixRowWidth = 1 + rowHeaderWidth + symbols.length * cellWidth;
  const chartRows = pair ? matrixChartRows(width, height, symbols.length, matrixRowWidth) : 0;
  const matrixHeight = Math.max(1, height - 1 - (chartRows > 0 ? chartRows + 1 : 0));
  const horizontalBarRows = matrixRowWidth > width - 1 ? 1 : 0;

  // Scroll after React commits a movement, including several keys in one input batch.
  useEffect(() => afterLayout(() => {
    const scroll = matrixScrollRef.current;
    if (scroll) {
      const viewportHeight = Math.max(1, scroll.viewport?.height ?? 1);
      if (cursor.row < scroll.scrollTop) scroll.scrollTo(cursor.row);
      else if (cursor.row + 1 > scroll.scrollTop + viewportHeight) scroll.scrollTo(cursor.row + 1 - viewportHeight);
    }
    const horizontal = horizontalScrollRef.current;
    if (!horizontal) return;
    const left = cursor.column < 0 ? 0 : 1 + rowHeaderWidth + cursor.column * cellWidth;
    const right = left + (cursor.column < 0 ? rowHeaderWidth : cellWidth);
    const scrollLeft = horizontal.scrollLeft ?? 0;
    const viewportWidth = horizontal.viewport?.width || width;
    if (left < scrollLeft) horizontal.scrollTo({ x: left, y: 0 });
    else if (right > scrollLeft + viewportWidth) horizontal.scrollTo({ x: right - viewportWidth, y: 0 });
  }), [cursor.row, cursor.column, matrixHeight, rowHeaderWidth, cellWidth, width]);
  const bodyStatus = settings.symbolsError
    ? <PaneStatusBody error={settings.symbolsError} />
    : symbols.length < 2
      ? <PaneStatusBody empty emptyTitle="Enter at least 2 tickers." />
      : null;

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
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
          <ScrollBox ref={horizontalScrollRef} height={matrixHeight} flexShrink={1} minHeight={Math.min(matrixHeight, symbols.length + 1, 5)} scrollX scrollY={false} focusable={false}>
            <Box flexDirection="column" width={Math.max(width - 1, matrixRowWidth)} height={matrixHeight - horizontalBarRows}>
              {/* Column header row */}
              <Box flexDirection="row" paddingLeft={1} height={1} flexShrink={0} width={matrixRowWidth} backgroundColor={headerBg}>
                <Box width={rowHeaderWidth} flexShrink={0} />
                {symbols.map((sym) => (
                  <SymbolLabelCell
                    key={sym}
                    symbol={sym}
                    width={cellWidth}
                    align="flex-end"
                    color={colors.textDim}
                    hovered={hoveredSymbol === sym || selection?.[1] === sym}
                    onHover={hoverSymbol}
                    onLeave={clearHoveredSymbol}
                    onOpen={openSymbol}
                  />
                ))}
              </Box>

              {/* Matrix rows */}
              <ScrollBox ref={matrixScrollRef} flexGrow={1} flexBasis={0} minHeight={0} scrollY scrollX={false} focusable={false}>
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
                          hovered={hoveredSymbol === rowSym || selection?.[0] === rowSym}
                          onHover={hoverSymbol}
                          onLeave={clearHoveredSymbol}
                          onOpen={openSymbol}
                        />
                      </Box>
                      {/* Cells */}
                      {symbols.map((colSym, colIndex) => {
                        const r = matrix.results.get(pairKey(rowSym, colSym))?.correlation ?? null;
                        const cellColors = resolveHeatCellColors(r, { quiet: rowSym === colSym });
                        const text = formatCorrelation(r);
                        const selected = cursor.row === rowIndex && cursor.column === colIndex;
                        return (
                          <Box
                            key={colSym}
                            width={cellWidth}
                            flexShrink={0}
                            flexDirection="row"
                            justifyContent="flex-end"
                            paddingRight={1}
                            backgroundColor={cellColors.background}
                            style={{ cursor: "pointer" }}
                            onMouseDown={(event: any) => {
                              event.preventDefault?.();
                              event.stopPropagation?.();
                              setCursorState({ cursor: { row: rowIndex, column: colIndex }, hoveredSymbol: null });
                            }}
                          >
                            <Text fg={cellColors.foreground} attributes={selected ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.NONE}>{text}</Text>
                          </Box>
                        );
                      })}
                    </Box>
                  ))}
                </Box>
              </ScrollBox>
            </Box>
          </ScrollBox>
          {chartRows > 0 && pair && pairHistory ? (
            <MatrixPairChart
              pair={pair}
              history={pairHistory}
              fullPeriod={matrix.results.get(pairKey(...pair))?.correlation ?? null}
              width={width}
              height={chartRows}
            />
          ) : null}
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
      description: "Date-aligned Pearson correlation matrix for ticker returns and map series such as GEO:HORMUZ.",
      keywords: ["correlation", "corr", "matrix", "pearson", "returns", "covariance"],
      shortcut: { prefix: "CORR", argPlaceholder: "tickers", argKind: "ticker-list", keepArgToken: (token) => !!geoSeriesToken(token) },
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
