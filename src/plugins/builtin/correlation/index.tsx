import { Box, ScrollBox, Text, type InputRenderable } from "../../../ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { InputSearchBar, SegmentedControl, usePaneFooter } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { colors } from "../../../theme/colors";
import { usePluginTickerActions } from "../../runtime";
import { useAppSelector, usePaneInstance, usePaneSettingValue } from "../../../state/app/context";
import { useChartQueries } from "../../../market-data/hooks";
import { buildChartKey } from "../../../market-data/selectors";
import { formatTickerListInput } from "../../../tickers/list";
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
      map.set(instrument.symbol, getSeriesForEntry(instrument.symbol, entry));
    }
    return map;
  }, [chartEntries, chartRequests, instruments]);

  const symbols = instruments.map((instrument) => instrument.symbol);
  const symbolsKey = symbols.join(",");

  const matrix = useMemo(() => {
    return buildCorrelationMatrix(symbols, seriesBySymbol);
  }, [symbolsKey, seriesBySymbol]);

  const statusSummary = useMemo(
    () => buildStatusSummary(symbols, seriesBySymbol, matrix.sampleMin, matrix.sampleMax, matrix.hasThinPair),
    [symbolsKey, seriesBySymbol, matrix.sampleMin, matrix.sampleMax, matrix.hasThinPair],
  );

  // The ticker set and range are visible in-pane, so the footer only carries
  // load state and errors.
  usePaneFooter("correlation", () => ({
    info: settings.symbolsError
      ? [{ id: "error", parts: [{ text: settings.symbolsError, tone: "warning" as const }] }]
      : statusSummary
        ? [{ id: "status", parts: [{ text: statusSummary, tone: "muted" as const }] }]
        : [],
  }), [settings.symbolsError, statusSummary]);

  const openSymbol = useCallback((symbol: string) => {
    if (tickers.has(symbol)) {
      pinTicker(symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
      return;
    }
    navigateTicker(symbol);
  }, [navigateTicker, pinTicker, tickers]);

  const clearHoveredSymbol = useCallback((symbol: string) => {
    setHoveredSymbol((current) => (current === symbol ? null : current));
  }, []);

  if (settings.symbolsError) {
    return (
      <Box flexDirection="column" width={width} height={height} paddingX={2} paddingY={1}>
        <Text fg={colors.negative}>Invalid CORR tickers: {settings.symbolsError}</Text>
        <Text fg={colors.textMuted}>Open pane settings and enter tickers like AAPL, MSFT, NVDA.</Text>
      </Box>
    );
  }

  if (symbols.length < 2) {
    return (
      <Box flexDirection="column" width={width} height={height} paddingX={2} paddingY={1}>
        <Text fg={colors.textMuted}>Enter at least 2 tickers in pane settings</Text>
      </Box>
    );
  }

  const headerBg = colors.panel;
  const rowHeaderWidth = Math.max(
    ROW_HEADER_WIDTH,
    Math.min(12, Math.max(...symbols.map((symbol) => displaySymbol(symbol).length)) + 2),
  );
  const availableCellWidth = Math.floor((Math.max(width - rowHeaderWidth - 4, symbols.length * MIN_MATRIX_CELL_WIDTH)) / symbols.length);
  const cellWidth = Math.max(MIN_MATRIX_CELL_WIDTH, Math.min(MATRIX_CELL_WIDTH, availableCellWidth));
  // Rows are exactly as wide as the matrix, so the zebra and hover bands stop at
  // the last column instead of running to the pane edge.
  const matrixRowWidth = rowHeaderWidth + symbols.length * cellWidth + 2;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1} flexDirection="row" overflow="hidden">
        <Box flexShrink={1} overflow="hidden">
          <InputSearchBar
            value={symbolsText}
            focused={focused}
            active={symbolsEditing}
            width={Math.max(12, Math.min(40, width - 24))}
            focusToken={symbolsFocusToken}
            inputRef={symbolsInputRef}
            placeholder="tickers"
            debounceMs={500}
            onFocus={() => {
              setSymbolsEditing(true);
              setSymbolsFocusToken((token) => token + 1);
            }}
            onBlur={() => setSymbolsEditing(false)}
            onQueryChange={(query) => setSymbolsText(query)}
          />
        </Box>
        <Box flexGrow={1} />
        <SegmentedControl
          options={CORRELATION_RANGE_OPTIONS.map((range) => ({ label: range, value: range }))}
          value={rangePreset}
          onChange={(value) => setRangePreset(value as CorrelationRangePreset)}
          focused={focused && !symbolsEditing}
          shortcutScope="correlation:range"
        />
      </Box>

      {/* Column header row */}
      <Box flexDirection="row" paddingX={1} height={1} width={matrixRowWidth} backgroundColor={headerBg}>
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
      <ScrollBox flexGrow={1} scrollY scrollX focusable={false}>
        <Box flexDirection="column">
          {symbols.map((rowSym, rowIndex) => (
            <Box key={rowSym} flexDirection="row" paddingX={1} width={matrixRowWidth} backgroundColor={rowIndex % 2 === 0 ? colors.bg : undefined}>
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
                const isDiag = rowSym === colSym;
                let r: number | null = null;
                if (isDiag) {
                  r = 1;
                } else {
                  r = matrix.results.get(pairKey(rowSym, colSym))?.correlation ?? null;
                }
                const cellColors = resolveCorrelationHeatmapCellColors(r);
                const text = isDiag ? " 1.00" : formatCorrelation(r);
                return (
                  <Box
                    key={colSym}
                    width={cellWidth}
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
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
      settings: buildRelationshipGraphSettingsDef(),
    },
  ],

  paneTemplates: [
    {
      id: "correlation-pane",
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
    createRelationshipPaneTemplate(),
  ],
};
