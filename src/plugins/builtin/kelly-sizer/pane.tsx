import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, TextAttributes, type InputRenderable } from "../../../ui";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import {
  InputSearchBar,
  Tabs,
  usePaneFooter,
} from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import { useFxRatesMap, useTickerFinancials, useTickerFinancialsMap } from "../../../market-data/hooks";
import { formatCurrency } from "../../../utils/format";
import { selectEffectiveExchangeRates } from "../../../utils/exchange-rate-map";
import {
  useAppDispatch,
  getFocusedCollectionId,
  getFocusedTickerSymbol,
  useAppSelector,
  usePaneInstance,
  usePaneStateValue,
} from "../../../state/app/context";
import { selectCommandBarOpen } from "../../../state/selectors-ui";
import { usePortfolioAccountState } from "../portfolio-list/header";
import { getSharedRegistry } from "../../registry";
import { resolveTickerOpenTarget } from "../../../tickers/open-target";
import { calculatePortfolioSummaryTotals } from "../portfolio-list/metrics";
import {
  buildTrackedCurrencies,
  getCollectionTickersFromConfig,
} from "../portfolio-list/pane/data";
import {
  DEFAULT_KELLY_DRAFTS,
  KELLY_MODES,
  applyKellyCommonAssumptions,
  buildKellyCurvePoints,
  buildSensitivityGrid,
  calculateExpectedLogGrowthAtFraction,
  calculateKellySizing,
  cloneKellyDrafts,
  getKellyCurveMaxFraction,
  type KellySizerDraft,
  type KellySizerModeDrafts,
  type KellySizingMode,
} from "./model";
import { KELLY_PANE_ID } from "./constants";
import {
  InlineFieldView,
  buildKellyCurveXAxisLabels,
  isPlainShortcut,
  truncateText,
} from "./view";
import {
  buildCommonFields,
  buildModeFields,
  type InlineField,
} from "./fields";
import type { StaticChartXMarker } from "../../../components/chart/static/chart/surface";
import {
  KellyCurveSection,
  KellyResultMetrics,
  KellySensitivitySection,
} from "./sections";
import { getPortfolioPositionValue, resolveActivePortfolioId } from "./portfolio";
import { useKellyCommonAssumptions } from "./state";

export function KellySizerPane({ focused, width, height }: PaneProps) {
  const paneInstance = usePaneInstance();
  const dispatch = useAppDispatch();
  const config = useAppSelector((state) => state.config);
  const activeCollectionId = useAppSelector((state) => getFocusedCollectionId(state));
  const focusedSymbol = useAppSelector((state) => getFocusedTickerSymbol(state));
  const [symbolOverride, setSymbolOverride] = usePaneStateValue<string | null>("symbol", null);
  const requestedSymbol = symbolOverride || paneInstance?.params?.symbol || focusedSymbol;
  const ticker = useAppSelector((state) => (requestedSymbol ? state.tickers.get(requestedSymbol) ?? null : null));
  const cachedFinancials = useAppSelector((state) => (requestedSymbol ? state.financials.get(requestedSymbol) ?? null : null));
  const liveFinancials = useTickerFinancials(requestedSymbol ?? null, ticker);
  const financials = liveFinancials ?? cachedFinancials;
  const tickersBySymbol = useAppSelector((state) => state.tickers);
  const cachedPortfolioFinancials = useAppSelector((state) => state.financials);
  const cachedExchangeRates = useAppSelector((state) => state.exchangeRates);
  const brokerAccounts = useAppSelector((state) => state.brokerAccounts);
  const commandBarOpen = useAppSelector(selectCommandBarOpen);

  const [mode, setMode] = usePaneStateValue<KellySizingMode>("mode", "binary");
  const [drafts, setDrafts] = usePaneStateValue<KellySizerModeDrafts>("drafts", cloneKellyDrafts());
  const [showSensitivity, setShowSensitivity] = usePaneStateValue<boolean>("showSensitivity", false);
  const [selectedPortfolioId, setSelectedPortfolioId] = usePaneStateValue<string | null>("portfolioId", null);
  const [bankrollOverride, setBankrollOverride] = usePaneStateValue<number | null>("bankrollOverride", null);
  const [currentValueOverride, setCurrentValueOverride] = usePaneStateValue<number | null>("currentValueOverride", null);
  const [selectedFieldIndex, setSelectedFieldIndex] = useState(0);
  const [activeInputId, setActiveInputId] = useState<string | null>(null);
  const tickerInputRef = useRef<InputRenderable | null>(null);
  const [tickerSearchActive, setTickerSearchActive] = useState(false);
  const [tickerSearchQuery, setTickerSearchQuery] = useState(requestedSymbol ?? "");
  const [tickerSearchFocusToken, setTickerSearchFocusToken] = useState(0);
  const [tickerSearchStatus, setTickerSearchStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!tickerSearchActive) {
      setTickerSearchQuery(requestedSymbol ?? "");
    }
  }, [requestedSymbol, tickerSearchActive]);

  const activateInput = useCallback((inputId: string | null, fieldIndex?: number) => {
    if (typeof fieldIndex === "number") setSelectedFieldIndex(fieldIndex);
    setActiveInputId(inputId);
  }, []);

  const focusTickerSearch = useCallback(() => {
    setTickerSearchActive(true);
    setTickerSearchFocusToken((value) => value + 1);
    activateInput(null);
  }, [activateInput]);

  const resolveTickerQuery = useCallback(async (query: string) => {
    const normalizedQuery = query.trim().toUpperCase();
    setTickerSearchQuery(normalizedQuery);
    if (!normalizedQuery || normalizedQuery === requestedSymbol) {
      setTickerSearchStatus(null);
      return;
    }

    const registry = getSharedRegistry();
    if (!registry) {
      setTickerSearchStatus("lookup unavailable");
      return;
    }

    setTickerSearchStatus("checking...");
    let target: Awaited<ReturnType<typeof resolveTickerOpenTarget>>;
    try {
      target = await resolveTickerOpenTarget({
        query: normalizedQuery,
        tickers: tickersBySymbol,
        dataProvider: registry.marketData,
        tickerRepository: registry.tickerRepository,
      });
    } catch (error) {
      // Without this the status is stuck on "checking..." and the rejection is unhandled.
      setTickerSearchStatus(error instanceof Error ? error.message : "lookup failed");
      return;
    }

    if (!target) {
      setTickerSearchStatus("not found");
      return;
    }

    dispatch({ type: "UPDATE_TICKER", ticker: target.ticker });
    if (target.created) {
      registry.events.emit("ticker:added", { symbol: target.symbol, ticker: target.ticker });
    }
    setSymbolOverride(target.symbol);
    setBankrollOverride(null);
    setCurrentValueOverride(null);
    setTickerSearchQuery(target.symbol);
    setTickerSearchStatus(null);
  }, [
    dispatch,
    requestedSymbol,
    setBankrollOverride,
    setCurrentValueOverride,
    setSymbolOverride,
    tickersBySymbol,
  ]);

  const activePortfolioId = resolveActivePortfolioId({
    requestedPortfolioId: selectedPortfolioId ?? paneInstance?.params?.portfolioId ?? null,
    activeCollectionId,
    symbol: requestedSymbol ?? null,
    ticker,
    config,
  });
  const activePortfolio = useMemo(
    () => config.portfolios.find((portfolio) => portfolio.id === activePortfolioId) ?? null,
    [activePortfolioId, config.portfolios],
  );
  const portfolioTickers = useMemo(
    () => activePortfolioId ? getCollectionTickersFromConfig(config, tickersBySymbol, activePortfolioId) : [],
    [activePortfolioId, config, tickersBySymbol],
  );
  const livePortfolioFinancials = useTickerFinancialsMap(portfolioTickers);
  const portfolioFinancials = useMemo(() => {
    const merged = new Map(cachedPortfolioFinancials);
    for (const [symbol, value] of livePortfolioFinancials) merged.set(symbol, value);
    if (requestedSymbol && financials) merged.set(requestedSymbol, financials);
    return merged;
  }, [cachedPortfolioFinancials, financials, livePortfolioFinancials, requestedSymbol]);
  const { accountState } = usePortfolioAccountState(activePortfolio, { brokerAccounts, config });
  const trackedCurrencies = useMemo(
    () => buildTrackedCurrencies(portfolioTickers, portfolioFinancials, accountState, config.baseCurrency),
    [accountState, config.baseCurrency, portfolioFinancials, portfolioTickers],
  );
  const fetchedExchangeRates = useFxRatesMap(trackedCurrencies);
  const exchangeRates = selectEffectiveExchangeRates(fetchedExchangeRates, cachedExchangeRates);
  const portfolioSummary = useMemo(
    () => calculatePortfolioSummaryTotals(
      portfolioTickers,
      portfolioFinancials,
      config.baseCurrency,
      exchangeRates,
      true,
      activePortfolioId,
    ),
    [activePortfolioId, config.baseCurrency, exchangeRates, portfolioFinancials, portfolioTickers],
  );
  const sourceBankroll = accountState?.account.netLiquidation
    ?? portfolioSummary.totalMktValue
    ?? 0;
  const sourceCurrentValue = getPortfolioPositionValue({
    ticker,
    financials,
    portfolioId: activePortfolioId,
    baseCurrency: config.baseCurrency,
    exchangeRates,
  });
  const bankroll = bankrollOverride ?? sourceBankroll;
  const currentValue = currentValueOverride ?? sourceCurrentValue;
  const price = financials?.quote?.price ?? null;
  const rawActiveDraft = drafts[mode] ?? DEFAULT_KELLY_DRAFTS[mode];
  const { commonAssumptions, updateCommon } = useKellyCommonAssumptions(rawActiveDraft);
  const activeDraft = useMemo(
    () => applyKellyCommonAssumptions(rawActiveDraft, commonAssumptions),
    [commonAssumptions, rawActiveDraft],
  );

  const updateDraft = useCallback((patch: Partial<KellySizerDraft>) => {
    setDrafts((current) => ({
      ...cloneKellyDrafts(current),
      [mode]: {
        ...(current[mode] ?? DEFAULT_KELLY_DRAFTS[mode]),
        ...patch,
      } as KellySizerDraft,
    }));
  }, [mode, setDrafts]);

  const fields = useMemo(
    () => buildModeFields({ mode, draft: activeDraft, updateDraft }),
    [activeDraft, mode, updateDraft],
  );
  const commonFields = useMemo(
    () => buildCommonFields({ common: commonAssumptions, updateCommon }),
    [commonAssumptions, updateCommon],
  );
  const contextFields = useMemo<InlineField[]>(() => [
    {
      id: "context:bankroll",
      label: "Bankroll",
      value: bankroll,
      suffix: config.baseCurrency,
      onValue: (value) => setBankrollOverride(Math.max(0, value)),
      onClear: () => setBankrollOverride(null),
    },
    {
      id: "context:current",
      label: "Current",
      value: currentValue,
      suffix: config.baseCurrency,
      onValue: (value) => setCurrentValueOverride(Math.max(0, value)),
      onClear: () => setCurrentValueOverride(null),
    },
  ], [bankroll, config.baseCurrency, currentValue, setBankrollOverride, setCurrentValueOverride]);
  const editableFields = useMemo(() => [...commonFields, ...fields], [commonFields, fields]);
  const safeSelectedFieldIndex = Math.min(selectedFieldIndex, Math.max(0, editableFields.length - 1));
  const result = useMemo(
    () => calculateKellySizing({
      mode,
      draft: activeDraft,
      bankroll,
      currentValue,
      price,
    }),
    [activeDraft, bankroll, currentValue, mode, price],
  );
  const sensitivity = useMemo(() => buildSensitivityGrid(mode, activeDraft), [activeDraft, mode]);
  const curveMaxFraction = useMemo(
    () => getKellyCurveMaxFraction(mode, activeDraft, [
      result.currentFraction,
      result.clippedFraction,
      result.fullKellyFraction,
    ]),
    [activeDraft, mode, result.clippedFraction, result.currentFraction, result.fullKellyFraction],
  );
  const curvePoints = useMemo(
    () => buildKellyCurvePoints(mode, activeDraft, curveMaxFraction),
    [activeDraft, curveMaxFraction, mode],
  );
  const curveXAxisLabels = useMemo(() => buildKellyCurveXAxisLabels(curveMaxFraction), [curveMaxFraction]);
  const currentGrowth = useMemo(
    () => calculateExpectedLogGrowthAtFraction(mode, activeDraft, result.currentFraction),
    [activeDraft, mode, result.currentFraction],
  );
  const targetGrowth = useMemo(
    () => calculateExpectedLogGrowthAtFraction(mode, activeDraft, result.clippedFraction),
    [activeDraft, mode, result.clippedFraction],
  );
  const curveMarkers = useMemo<StaticChartXMarker[]>(() => {
    if (!Number.isFinite(curveMaxFraction) || curveMaxFraction <= 0) return [];
    const targetLabel = result.clipReasons[0]?.replace(/^max /, "") ?? "target";
    const markers: StaticChartXMarker[] = [
      {
        id: "current",
        xRatio: result.currentFraction / curveMaxFraction,
        label: "current",
        color: colors.textDim,
        lineChar: "┊",
      },
      {
        id: "target",
        xRatio: result.clippedFraction / curveMaxFraction,
        label: targetLabel === "target" ? "target" : `${targetLabel} cap`,
        color: colors.positive,
        lineChar: "┃",
      },
      {
        id: "full",
        xRatio: result.fullKellyFraction / curveMaxFraction,
        label: "full",
        color: colors.textMuted,
        lineChar: "│",
      },
    ];
    // Anything past the window edge would be drawn on top of the axis, so drop it.
    return markers.filter((marker) => Number.isFinite(marker.xRatio) && marker.xRatio >= 0 && marker.xRatio <= 1);
  }, [
    curveMaxFraction,
    result.clipReasons,
    result.clippedFraction,
    result.currentFraction,
    result.fullKellyFraction,
  ]);
  const summaryLine = requestedSymbol
    ? `${requestedSymbol}${activePortfolio ? ` · ${activePortfolio.name}` : ""}`
    : "No ticker selected";

  const toggleSensitivity = useCallback(() => {
    setShowSensitivity((current) => !current);
  }, [setShowSensitivity]);

  useShortcut((event) => {
    if (!focused) return;
    if (commandBarOpen || event.defaultPrevented || event.propagationStopped) return;
    if (event.ctrl || event.meta || event.super || event.alt || event.targetEditable) return;

    if (isPlainShortcut(event, "s")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      toggleSensitivity();
      return;
    }
    if (isPlainShortcut(event, "/")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      focusTickerSearch();
      return;
    }
    if (isPlainShortcut(event, "e")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      activateInput(editableFields[safeSelectedFieldIndex]?.id ?? null);
    }
  }, { enabled: focused });

  usePaneFooter(KELLY_PANE_ID, () => ({
    info: result.warnings.length > 0
      ? [{ id: "warning", parts: [{ text: result.warnings[0]!, tone: "warning" as const }] }]
      : result.clipReasons.length > 0
        ? [{ id: "clip", parts: [{ text: `clip ${result.clipReasons.join(", ")}`, tone: "muted" as const }] }]
        : [],
    hints: [
      { id: "search", key: "/", label: "search", onPress: focusTickerSearch },
      { id: "sensitivity", key: "s", label: showSensitivity ? "ensitivity off" : "ensitivity", onPress: toggleSensitivity },
    ],
  }), [focusTickerSearch, result.clipReasons, result.warnings, showSensitivity, toggleSensitivity]);

  const portfolioTabs = useMemo(
    () => config.portfolios.map((portfolio) => ({ label: portfolio.name, value: portfolio.id })),
    [config.portfolios],
  );
  const fieldColumns = width >= 92 ? 3 : 2;
  const commonColumns = width >= 78 ? 3 : 2;
  const commonRows = Math.max(1, Math.ceil(commonFields.length / commonColumns));
  const fieldsRows = Math.max(1, Math.ceil(fields.length / fieldColumns));
  // Floors low enough that a narrow pane shrinks instead of clipping, ceilings so a
  // wide pane keeps the label, value, and unit together.
  const commonFieldWidth = Math.max(14, Math.min(30, Math.floor((width - 2) / commonColumns)));
  const fieldWidth = Math.max(14, Math.min(30, Math.floor((width - 2) / fieldColumns)));
  const contextFieldWidth = Math.max(16, Math.min(32, Math.floor((width - 2) / 2)));
  const metricsRows = 6;
  const curveDecisionRows = 1;
  const chartHeight = showSensitivity ? 0 : Math.max(7, Math.min(10, height - commonRows - fieldsRows - metricsRows - curveDecisionRows - 8));
  const showChart = !showSensitivity && chartHeight >= 6 && curvePoints.length > 0;
  const leftMetricsWidth = Math.max(18, Math.floor((width - 2) * 0.52));
  const rightMetricsWidth = Math.max(16, width - 2 - leftMetricsWidth);

  if (!requestedSymbol || !ticker) {
    return (
      <Box flexDirection="column" width={width} height={height} paddingX={1} paddingY={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>Position Sizer</Text>
        <Box height={1} />
        <Text fg={colors.textMuted}>Select a ticker or open with KELLY &lt;ticker&gt;.</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
    >
      <Box height={1} paddingX={1} flexDirection="row">
        <Box flexGrow={1} overflow="hidden">
          {tickerSearchActive ? (
            <InputSearchBar
              value={tickerSearchQuery}
              focused={focused}
              active={tickerSearchActive}
              width={Math.min(36, Math.max(12, width - 18))}
              focusToken={tickerSearchFocusToken}
              inputRef={tickerInputRef}
              placeholder="ticker"
              debounceMs={500}
              normalizeValue={(value) => value.trim().toUpperCase()}
              onFocus={() => setTickerSearchActive(true)}
              onBlur={() => setTickerSearchActive(false)}
              onQueryChange={(query) => {
                void resolveTickerQuery(query);
              }}
            />
          ) : (
            <Box height={1} flexDirection="row" onMouseDown={focusTickerSearch}>
              <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
                {truncateText(summaryLine, Math.max(8, width - 2))}
              </Text>
              {tickerSearchStatus ? (
                <Text fg={colors.textMuted}>
                  {truncateText(`  ${tickerSearchStatus}`, Math.max(0, width - summaryLine.length - 18))}
                </Text>
              ) : null}
            </Box>
          )}
        </Box>
        {price != null && (
          <Text fg={colors.textDim}>
            {formatCurrency(price, financials?.quote?.currency ?? ticker.metadata.currency ?? config.baseCurrency)}
          </Text>
        )}
      </Box>

      {portfolioTabs.length > 1 && (
        <Box height={1} flexDirection="row">
          <Box flexShrink={1} overflow="hidden">
            <Tabs
              tabs={portfolioTabs}
              activeValue={activePortfolioId}
              onSelect={(portfolioId) => {
                setSelectedPortfolioId(portfolioId);
                setBankrollOverride(null);
                setCurrentValueOverride(null);
              }}
              compact
              focused={focused && !activeInputId}
              keyboardNavigation={false}
            />
          </Box>
        </Box>
      )}

      <Box height={1} flexDirection="row" paddingX={1}>
        {contextFields.map((field) => (
          <InlineFieldView
            key={field.id}
            field={field}
            active={activeInputId === field.id}
            focused={focused}
            width={contextFieldWidth}
            onFocus={() => activateInput(field.id)}
          />
        ))}
        {bankrollOverride != null || currentValueOverride != null ? (
          <Text fg={colors.textMuted}> override</Text>
        ) : null}
      </Box>

      <Box height={1} paddingX={1}>
        <Tabs
          tabs={KELLY_MODES.map((entry) => ({ label: entry.label, value: entry.id }))}
          activeValue={mode}
          onSelect={(nextMode) => {
            setMode(nextMode as KellySizingMode);
            setSelectedFieldIndex(0);
            activateInput(null);
          }}
          compact
          focused={focused && !activeInputId}
        />
      </Box>

      <Box flexDirection="column" paddingX={1} height={commonRows}>
        {Array.from({ length: commonRows }, (_, rowIndex) => (
          <Box key={rowIndex} height={1} flexDirection="row">
            {commonFields.slice(rowIndex * commonColumns, rowIndex * commonColumns + commonColumns).map((field, offset) => {
              const index = rowIndex * commonColumns + offset;
              return (
                <InlineFieldView
                  key={field.id}
                  field={field}
                  active={activeInputId === field.id}
                  focused={focused}
                  width={commonFieldWidth}
                  onFocus={() => activateInput(field.id, index)}
                />
              );
            })}
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" paddingX={1} height={fieldsRows}>
        {Array.from({ length: fieldsRows }, (_, rowIndex) => (
          <Box key={rowIndex} height={1} flexDirection="row">
            {fields.slice(rowIndex * fieldColumns, rowIndex * fieldColumns + fieldColumns).map((field, offset) => {
              const index = rowIndex * fieldColumns + offset;
              return (
                <InlineFieldView
                  key={field.id}
                  field={field}
                  active={activeInputId === field.id}
                  focused={focused}
                  width={fieldWidth}
                  onFocus={() => activateInput(field.id, commonFields.length + index)}
                />
              );
            })}
          </Box>
        ))}
      </Box>

      {bankroll > 0 ? null : (
        <Box height={1} paddingX={1} overflow="hidden">
          <Text fg={colors.warning}>
            No bankroll yet, so every size below reads 0%. Click Bankroll above to set one.
          </Text>
        </Box>
      )}

      <KellyResultMetrics
        result={result}
        activeDraft={activeDraft}
        baseCurrency={config.baseCurrency}
        leftWidth={leftMetricsWidth}
        rightWidth={rightMetricsWidth}
      />

      {showChart && (
        <KellyCurveSection
          width={width}
          height={chartHeight}
          points={curvePoints}
          xAxisLabels={curveXAxisLabels}
          curveMaxFraction={curveMaxFraction}
          markers={curveMarkers}
          result={result}
          currentGrowth={currentGrowth}
          targetGrowth={targetGrowth}
          baseCurrency={config.baseCurrency}
        />
      )}

      {showSensitivity && (
        <KellySensitivitySection width={width} sensitivity={sensitivity} />
      )}
    </Box>
  );
}
