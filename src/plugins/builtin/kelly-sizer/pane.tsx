import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useUiCapabilities, type InputRenderable } from "../../../ui";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import {
  EmptyState,
  FieldGrid,
  QueryBar,
  StatGrid,
  Tabs,
  fieldGridColumns,
  fieldGridRows,
  statGridRows,
  usePaneFooter,
  usePaneHeaderTabs,
  type GridField,
  type QueryBarFilter,
} from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import { useFxRatesMap } from "../../../market-data/hooks";
import { useLiveTickerFinancials, useLiveTickerFinancialsMap } from "../../../state/hooks/live-ticker-financials";
import { buildPortfolioFinancialsMap } from "../../../market-data/portfolio-financials";
import { convertCurrency, formatCurrency } from "../../../utils/format";
import { selectEffectiveExchangeRates } from "../../../utils/exchange-rate-map";
import {
  useAppDispatch,
  getFocusedCollectionId,
  getFocusedTickerSymbol,
  useAppSelector,
  usePaneInstance,
  usePaneStateValue,
  usePaneAppConfig,
} from "../../../state/app/context";
import { selectCommandBarOpen } from "../../../state/selectors-ui";
import { usePortfolioAccountState } from "../portfolio-list/summary/live-accounts";
import { getSharedRegistry } from "../../registry";
import { resolveTickerOpenTarget } from "../../../tickers/open-target";
import { calculatePortfolioSummaryTotals } from "../portfolio-list/metrics";
import { resolvePortfolioNetLiquidation } from "../portfolio-list/account-metrics";
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
  type PredictionMarketKellyAssumptions,
} from "./model";
import { KELLY_PANE_ID } from "./constants";
import {
  buildKellyCurveXAxisLabels,
  isPlainShortcut,
} from "./view";
import {
  buildCommonFields,
  buildModeFields,
} from "./fields";
import type { StaticChartXMarker } from "../../../components/chart/static";
import {
  KellyCurveSection,
  KellySensitivitySection,
  buildKellyResultItems,
} from "./sections";
import { getPortfolioPositionValue, resolveActivePortfolioId } from "./portfolio";
import { useKellyCommonAssumptions } from "./state";

export function KellySizerPane({ focused, width, height }: PaneProps) {
  const paneInstance = usePaneInstance();
  const dispatch = useAppDispatch();
  const config = usePaneAppConfig();
  const activeCollectionId = useAppSelector((state) => getFocusedCollectionId(state));
  const focusedSymbol = useAppSelector((state) => getFocusedTickerSymbol(state));
  const [symbolOverride, setSymbolOverride] = usePaneStateValue<string | null>("symbol", null);
  const requestedSymbol = symbolOverride || paneInstance?.params?.symbol || focusedSymbol;
  const ticker = useAppSelector((state) => (requestedSymbol ? state.tickers.get(requestedSymbol) ?? null : null));
  const cachedFinancials = useAppSelector((state) => (requestedSymbol ? state.financials.get(requestedSymbol) ?? null : null));
  // Sizes are derived from the price; about one update a second keeps them
  // current without redrawing the curve and grid on every tick.
  const liveFinancials = useLiveTickerFinancials(requestedSymbol ?? null, ticker, { surface: "detail", visible: false, weight: 50 });
  const financials = liveFinancials ?? cachedFinancials;
  const tickersBySymbol = useAppSelector((state) => state.tickers);
  const cachedPortfolioFinancials = useAppSelector((state) => state.financials);
  const cachedExchangeRates = useAppSelector((state) => state.exchangeRates);
  const brokerAccounts = useAppSelector((state) => state.brokerAccounts);
  const commandBarOpen = useAppSelector(selectCommandBarOpen);
  const { nativePaneChrome } = useUiCapabilities();

  const [mode, setMode] = usePaneStateValue<KellySizingMode>("mode", "binary");
  // A narrow terminal bar has no room for the view switch beside the ticker,
  // price and account (plus the Side and Portfolio filters when shown), so
  // there `s` stays a footer hint.
  const viewInBar = nativePaneChrome || width >= 100
    + (mode === "prediction-market" ? 16 : 0)
    + (config.portfolios.length > 1 ? 12 : 0);
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
  const instrumentOptions = useMemo(() => ({ portfolioId: activePortfolioId }), [activePortfolioId]);
  // The bankroll is a sum, so the other positions stream in the background.
  const livePortfolioFinancials = useLiveTickerFinancialsMap(portfolioTickers, {
    surface: "portfolio",
    visible: false,
    weight: 20,
    instrumentOptions,
  });
  const portfolioFinancials = useMemo(
    () => buildPortfolioFinancialsMap(portfolioTickers, cachedPortfolioFinancials, livePortfolioFinancials, instrumentOptions),
    [portfolioTickers, cachedPortfolioFinancials, livePortfolioFinancials, instrumentOptions],
  );
  const hasPortfolioPosition = activePortfolioId && ticker?.metadata.positions.some(
    (position) => position.portfolio === activePortfolioId && position.shares !== 0,
  );
  const positionFinancials = hasPortfolioPosition
    ? portfolioFinancials.get(requestedSymbol!) ?? null
    : financials;
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
  // The broker's Net Liq in the base currency, moving with live quotes as in the portfolio header and PORT.
  const netLiquidation = resolvePortfolioNetLiquidation(
    portfolioSummary,
    accountState?.account,
    (value) => convertCurrency(value, accountState?.account.currency ?? "", config.baseCurrency, exchangeRates),
    accountState?.snapshotBasis,
  );
  const sourceBankroll = netLiquidation != null && Number.isFinite(netLiquidation)
    ? netLiquidation
    : portfolioSummary.totalMktValue ?? 0;
  const sourceCurrentValue = getPortfolioPositionValue({
    ticker,
    financials: positionFinancials,
    portfolioId: activePortfolioId,
    baseCurrency: config.baseCurrency,
    exchangeRates,
  });
  const bankroll = bankrollOverride ?? sourceBankroll;
  const currentValue = currentValueOverride ?? sourceCurrentValue;
  const price = positionFinancials?.quote?.price ?? null;
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
  const contextFields = useMemo<GridField[]>(() => [
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
    info: bankroll <= 0 && ticker
      // Every size reads 0% until there is a bankroll; say so where status lives.
      ? [{ id: "bankroll", parts: [{ text: "no bankroll", tone: "warning" as const }] }]
      : result.warnings.length > 0
        ? [{ id: "warning", parts: [{ text: result.warnings[0]!, tone: "warning" as const }] }]
        : result.clipReasons.length > 0
          ? [{ id: "clip", parts: [{ text: `clip ${result.clipReasons.join(", ")}`, tone: "muted" as const }] }]
          : [],
    hints: [
      { id: "search", key: "/", label: "search", onPress: focusTickerSearch },
      ...(viewInBar ? [] : [{ id: "sensitivity", key: "s", label: showSensitivity ? "ensitivity off" : "ensitivity", onPress: toggleSensitivity }]),
    ],
  }), [bankroll, focusTickerSearch, result.clipReasons, result.warnings, showSensitivity, ticker, toggleSensitivity, viewInBar]);

  const portfolioTabs = useMemo(
    () => config.portfolios.map((portfolio) => ({ label: portfolio.name, value: portfolio.id })),
    [config.portfolios],
  );
  const modeTabs = useMemo(() => KELLY_MODES.map((entry) => ({ label: entry.label, value: entry.id })), []);
  const selectMode = (nextMode: string) => {
    setMode(nextMode as KellySizingMode);
    setSelectedFieldIndex(0);
    activateInput(null);
  };
  const tabsInHeader = usePaneHeaderTabs({
    tabs: modeTabs,
    activeValue: mode,
    onSelect: selectMode,
    focused: focused && !activeInputId,
  });
  const tabRows = tabsInHeader ? 0 : 1;
  const gridFields = [...contextFields, ...editableFields];
  const gridColumns = fieldGridColumns(width);
  const gridRows = fieldGridRows(gridFields, gridColumns);
  const resultItems = buildKellyResultItems({
    result,
    baseCurrency: config.baseCurrency,
    currentGrowth,
    targetGrowth,
    width,
    columns: gridColumns,
  });
  const resultRows = statGridRows(resultItems, width, gridColumns);
  // Query bar, the mode strip when it is not in the title bar, inputs, results.
  const bodyRows = Math.max(0, height - 1 - tabRows - gridRows - resultRows);
  const chartHeight = showSensitivity ? 0 : bodyRows;
  const showChart = !showSensitivity && chartHeight >= 6 && curvePoints.length > 0;
  const quoteCurrency = positionFinancials?.quote?.currency ?? ticker?.metadata.currency ?? config.baseCurrency;
  // The search shows the ticker and the Portfolio filter the account, so the
  // context is the price first, then the account only when there is no filter.
  const meta = [
    price != null ? formatCurrency(price, quoteCurrency) : null,
    portfolioTabs.length > 1 ? null : activePortfolio?.name ?? null,
    bankrollOverride != null || currentValueOverride != null ? "override" : null,
    tickerSearchStatus,
  ].filter(Boolean).join(" · ");
  const filters: QueryBarFilter[] = [];
  if (portfolioTabs.length > 1) {
    filters.push({
      id: "portfolio",
      label: "Portfolio",
      value: activePortfolioId ?? "",
      options: portfolioTabs,
      onChange: (portfolioId: string) => {
        setSelectedPortfolioId(portfolioId);
        setBankrollOverride(null);
        setCurrentValueOverride(null);
      },
    });
  }
  if (mode === "prediction-market") {
    // The contract side picks which payoff is sized, so it is a mode switch
    // beside the query rather than an input cell.
    const market = activeDraft as PredictionMarketKellyAssumptions;
    filters.push({
      id: "side",
      label: "Side",
      inline: true,
      value: market.side,
      options: [{ value: "yes", label: "YES" }, { value: "no", label: "NO" }],
      onChange: (side: string) => updateDraft({ side: side === "no" ? "no" : "yes" } as Partial<KellySizerDraft>),
    });
  }

  if (!requestedSymbol || !ticker) {
    return (
      <Box flexDirection="column" width={width} height={height} paddingX={1} paddingY={1}>
        <EmptyState title="No ticker selected." hint="Select a ticker or open with KELLY <ticker>." />
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
    >
      <QueryBar
        width={width}
        search={{
          value: tickerSearchQuery,
          onChange: (query) => {
            void resolveTickerQuery(query);
          },
          placeholder: "ticker",
          focused,
          active: tickerSearchActive,
          onActiveChange: (active) => {
            setTickerSearchActive(active);
            if (active) activateInput(null);
          },
          focusToken: tickerSearchFocusToken,
          inputRef: tickerInputRef,
          debounceMs: 500,
          normalizeValue: (value) => value.trim().toUpperCase(),
        }}
        filters={filters}
        view={viewInBar ? {
          value: showSensitivity ? "sensitivity" : "curve",
          options: [
            { value: "curve", label: "Curve" },
            { value: "sensitivity", label: "Sensitivity" },
          ],
          onChange: (value: string) => setShowSensitivity(value === "sensitivity"),
        } : undefined}
        meta={meta}
      />

      {!tabsInHeader && (
        <Box height={1} paddingX={1}>
          <Tabs
            tabs={modeTabs}
            activeValue={mode}
            onSelect={selectMode}
            compact
            focused={focused && !activeInputId}
          />
        </Box>
      )}

      <FieldGrid
        fields={gridFields}
        activeId={activeInputId}
        width={width}
        focused={focused}
        onActivate={(id) => {
          const index = editableFields.findIndex((field) => field.id === id);
          activateInput(id, index >= 0 ? index : undefined);
        }}
        onDeactivate={() => activateInput(null)}
      />

      <StatGrid items={resultItems} width={width} columns={gridColumns} />

      {showChart && (
        <KellyCurveSection
          width={width}
          height={chartHeight}
          points={curvePoints}
          xAxisLabels={curveXAxisLabels}
          curveMaxFraction={curveMaxFraction}
          markers={curveMarkers}
        />
      )}

      {showSensitivity && (
        <KellySensitivitySection
          width={width}
          height={bodyRows}
          focused={focused && !activeInputId}
          sensitivity={sensitivity}
        />
      )}
    </Box>
  );
}
