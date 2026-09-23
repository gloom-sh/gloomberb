import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "../../../ui";
import { usePaneSettingValue, usePaneTicker, useUpdatePaneSettings } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { isPlainKey } from "../../../utils/keyboard";
import { formatCompact } from "../../../utils/format";
import { formatExpDate, resolveOptionsTarget } from "../../../utils/options";
import { canonicalTickerKey } from "../../../utils/exchanges";
import { useChartQueries, useOptionsQuery, useResolvedEntryValue, useTickerFinancials } from "../../../market-data/hooks";
import {
  DataTableView,
  EmptyState,
  KeyValueRow,
  usePaneFooter,
  usePaneNoticeFooter,
  Spinner,
  Tabs,
  type DataTableKeyEvent,
  type DataTableVisibleRange,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { useLiveQuoteEntries, useQuoteUpdates } from "../../../state/hooks/quote-streaming";
import { buildChartKey } from "../../../market-data/selectors";
import type { ChartRequest } from "../../../market-data/request-types";
import { quoteSubscriptionTargetFromTicker } from "../../../market-data/request-types";
import { usePluginAppActions } from "../../runtime";
import {
  OPTIONS_CALCULATOR_TEMPLATE_ID,
  type OptionSide,
} from "../options-calculator/model";
import { buildChainCalcParams, resolveCalcSide } from "./calc-seed";
import { useOptionsCatalogue } from "./expiry-catalogue";
import { calculateOptionGreeks, calculateOptionsSummary, type OptionsSummary } from "./analytics";
import {
  DEFAULT_OPTION_FIELD_IDS,
  buildStrikeList,
  createOptionColumns,
  findNearestStrikeIndex,
  formatIv,
  formatStrikeLabel,
  optionColumnColor,
  renderOptionCell,
  resolveDefaultStrikeTarget,
  resolveOptionFieldIds,
} from "./table";
import type { OptionColumn, OptionFieldId, OptionTableRow, OptionsViewProps } from "./types";
import {
  buildOptionQuoteTargets,
  overlayOptionRowQuotes,
  resolveOptionQuoteCoverage,
  resolveChainRefreshIntervalMs,
} from "./live-quotes";
import { useOptionsAccessFooter } from "./footer";
import { useLiveStreamingSetting } from "../shared/live-streaming";
import { signedPositionDirection } from "../portfolio-list/position-metrics";
import { optionMarketReference } from "./market-reference";
import { useOptionsEnrichment } from "./enrichment";
import type { OptionsEnrichmentSnapshot } from "./enrichment-model";
import { optionMid } from "../shared/volatility";
import type { IvStats } from "../iv-history/client";
import { formatIvRank, useIvRank } from "../iv-history/rank";

type SummaryMetric = { label: string; value: string };

function formatRatio(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "--" : value.toFixed(2);
}

function SummaryRow({ metrics }: { metrics: SummaryMetric[] }) {
  return <Box flexDirection="row" height={1} gap={3} overflow="hidden">
    {metrics.map((metric) => <KeyValueRow key={metric.label} label={metric.label}
      labelWidth={metric.label.length + 1} value={metric.value} color={colors.textBright} />)}
  </Box>;
}

function OptionsSummaryStrip({ summary, enrichment, width, rowCount, currency, ivRank }: {
  summary: OptionsSummary | null;
  ivRank?: { stats: IvStats | null } | null;
  enrichment: OptionsEnrichmentSnapshot | null;
  width: number;
  rowCount: number;
  currency: string;
}) {
  const volatility: SummaryMetric[] = [
    { label: "ATM IV", value: formatIv(summary?.atmImpliedVolatility ?? undefined) },
    { label: "HV30", value: formatIv(summary?.historicalVolatility30d ?? undefined) },
    { label: "IV/HV", value: formatRatio(summary?.impliedHistoricalRatio) },
    ...(ivRank ? [{ label: "IVR", value: formatIvRank(ivRank.stats) }] : []),
  ];
  const move = (amount: number | null | undefined, percent: number | null | undefined) =>
    amount == null || percent == null ? "--" : `${amount.toFixed(2)} ${currency} (${percent.toFixed(2)}%)`;
  const points = (value: number | null | undefined) => value == null ? "--" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}`;
  const moves: SummaryMetric[] = [
    { label: "Straddle", value: move(enrichment?.expectedMove.straddle, enrichment?.expectedMove.straddlePercent) },
    { label: "1σ fit", value: move(enrichment?.expectedMove.sigma, enrichment?.expectedMove.sigmaPercent) },
  ];
  const skew: SummaryMetric = { label: "25d P-C", value: `${points(enrichment?.skew25)} pp` };
  const slopeAnnualized = enrichment?.termSlopeAnnualized === true;
  const slopeDates = enrichment?.neighbourExpiration == null ? ""
    : slopeAnnualized ? ` to ${formatExpDate(enrichment.neighbourExpiration)}`
      : ` ${new Date(enrichment.expiration * 1000).getUTCFullYear() === new Date(enrichment.neighbourExpiration * 1000).getUTCFullYear()
        ? formatExpDate(enrichment.expiration).replace(/ '\d{2}$/, "") : formatExpDate(enrichment.expiration)} to ${formatExpDate(enrichment.neighbourExpiration)}`;
  const slope: SummaryMetric = { label: "Slope", value: `${points(enrichment?.termSlope)} ${slopeAnnualized ? "pp/y" : "pts"}${slopeDates}` };
  const flow: SummaryMetric[] = [
    { label: "EXP VOL", value: formatCompact(summary?.expirationVolume ?? undefined) },
    { label: "P/C VOL", value: formatRatio(summary?.putCallVolumeRatio) },
    { label: "P/C OI", value: formatRatio(summary?.putCallOpenInterestRatio) },
  ];
  const rows = width >= 110 ? [[...volatility, skew], [...moves, slope], flow]
    : width >= 65 ? [volatility, moves, [skew, slope], flow]
      : [volatility, [moves[0]!], [moves[1]!], [skew], [slope], flow];
  return <Box flexDirection="column" height={rowCount}>
    {rows.slice(0, rowCount).map((metrics, index) => <SummaryRow key={index} metrics={metrics} />)}
  </Box>;
}

export function OptionsView({ width, height, focused, onCapture = () => {}, ivRank: showIvRank = false }: OptionsViewProps) {
  const { ticker, financials } = usePaneTicker();
  const { createPaneFromTemplate } = usePluginAppActions();
  const liveStreaming = useLiveStreamingSetting();
  const [seededExpiration] = usePaneSettingValue<number | undefined>("expiration", undefined);
  const [expirationTargetKey] = usePaneSettingValue<string | null>("expirationTargetKey", null);
  const updatePaneSettings = useUpdatePaneSettings();
  const [calcSide, setCalcSide] = useState<OptionSide | null>(null);
  const [strikeIdx, setStrikeIdx] = useState(0);
  const [contractSelection, setContractSelection] = useState<{
    context: string; strike: number; side: OptionSide; contractSymbol: string;
  } | null>(null);
  const [autoScrollVersion, setAutoScrollVersion] = useState(0);
  const [scrollToIndexAlign, setScrollToIndexAlign] = useState<"nearest" | "center">("nearest");
  const [visibleStrikeViewport, setVisibleStrikeViewport] = useState<{
    key: string;
    range: DataTableVisibleRange;
  } | null>(null);
  const [interactive, setInteractive] = useState(false);
  const userSelectedStrikeRef = useRef(false);
  const onCaptureRef = useRef(onCapture);
  const target = resolveOptionsTarget(ticker);
  const isOpt = target?.isOptionTicker ?? false;
  const parsed = target?.parsedOption ?? null;
  const effectiveTicker = target?.effectiveTicker ?? "";
  const ivRank = useIvRank(showIvRank ? effectiveTicker : null);
  const effectiveExchange = target?.effectiveExchange ?? "";
  const selectionTargetKey = `${ticker?.metadata.ticker ?? ""}|${target?.cacheKey ?? ""}`;
  const underlyingQuoteTarget = isOpt
    ? effectiveTicker ? { symbol: effectiveTicker, exchange: effectiveExchange, route: "provider" as const } : null
    : quoteSubscriptionTargetFromTicker(ticker, effectiveTicker, "provider");
  // A standalone chain has no parent research pane to subscribe to its stock.
  // Its spot, ATM selection and Greeks must update independently of other panes.
  useQuoteUpdates(underlyingQuoteTarget ? [{
    ...underlyingQuoteTarget, surface: "options", visible: true, selected: true, weight: 100,
  }] : [], { liveStreaming });
  const underlyingFinancials = useTickerFinancials(isOpt ? effectiveTicker : null, null);
  const underlying = isOpt ? underlyingFinancials : financials;
  const underlyingStale = underlying?.quote?.stale === true;
  const spot = underlyingStale ? undefined : underlying?.quote?.price;
  const dividendYield = underlying?.fundamentals?.dividendYield;
  const instrument = target?.instrument ?? null;
  const baseRequest = target
    ? {
      instrument: {
        symbol: effectiveTicker,
        exchange: effectiveExchange,
        brokerId: instrument?.brokerId,
        brokerInstanceId: instrument?.brokerInstanceId,
        instrument,
      },
    }
    : null;
  const dailyHistoryRequest: ChartRequest | null = baseRequest
    ? { instrument: baseRequest.instrument, bufferRange: "1Y", granularity: "resolution", resolution: "1d" } : null;
  const historyEntries = useChartQueries(dailyHistoryRequest ? [dailyHistoryRequest] : []);
  const dailyHistoryEntry = dailyHistoryRequest ? historyEntries.get(buildChartKey(dailyHistoryRequest)) ?? null : null;
  const dailyHistory = useResolvedEntryValue(dailyHistoryEntry);
  const [chainRefreshMinutes] = usePaneSettingValue<string>("chainRefreshMinutes", "");
  const [storedOptionFieldIds] = usePaneSettingValue<OptionFieldId[]>("optionColumnIds", DEFAULT_OPTION_FIELD_IDS);
  const optionFieldIds = useMemo(() => resolveOptionFieldIds(storedOptionFieldIds), [storedOptionFieldIds]);
  const initialChainEntry = useOptionsQuery(baseRequest);
  const initialChain = useResolvedEntryValue(initialChainEntry);
  const initialExpiration = initialChain?.expirationDates.reduce((best, expiration) => (
    parsed && Math.abs(expiration - parsed.expTs) < Math.abs(best - parsed.expTs) ? expiration : best
  ), initialChain.expirationDates[0]!);
  const selectedExpiration = expirationTargetKey == null || expirationTargetKey === selectionTargetKey
    ? seededExpiration ?? initialExpiration : initialExpiration;
  const viewportKey = `${effectiveTicker}:${selectedExpiration ?? "initial"}`;
  const strikeSelectionKey = `${selectionTargetKey}|${selectedExpiration ?? "initial"}`;
  const selectedContract = contractSelection?.context === strikeSelectionKey ? contractSelection : null;
  const expirationChainEntry = useOptionsQuery(
    baseRequest && selectedExpiration != null
      ? { ...baseRequest, expirationDate: selectedExpiration }
      : null,
    { refreshIntervalMs: resolveChainRefreshIntervalMs(chainRefreshMinutes) },
  );
  const expirationChain = useResolvedEntryValue(expirationChainEntry);
  // Either query can refresh the expiry catalogue. The selected date remains
  // an identity even when an earlier date disappears or the catalogue reorders.
  const { chain, expirationDates: availableExpirations } = useOptionsCatalogue(
    selectionTargetKey, initialChainEntry, expirationChainEntry,
  );
  const selectedExpirationMissing = selectedExpiration != null && chain != null
    && !availableExpirations.includes(selectedExpiration);
  const matchesSelectedExpiration = (candidate: typeof initialChain) => candidate != null
    && selectedExpiration != null
    && [...candidate.calls, ...candidate.puts].every((contract) => contract.expiration === selectedExpiration);
  const mismatchedExpiration = expirationChain != null && !matchesSelectedExpiration(expirationChain);
  const expirationUnavailable = selectedExpirationMissing || mismatchedExpiration;
  // A provider fallback or an old default-expiry response must not seed the
  // table, export, Greeks or calculator for a different selected contract date.
  const strikeChain = expirationUnavailable ? null : expirationChain
    ?? (matchesSelectedExpiration(initialChain) ? initialChain : null);
  const strikesLoading = strikeChain === null && !expirationUnavailable;
  const expirationDates = useMemo(() => {
    return selectedExpirationMissing
      ? [...availableExpirations, selectedExpiration!].sort((left, right) => left - right) : availableExpirations;
  }, [availableExpirations, selectedExpiration, selectedExpirationMissing]);
  // Keep the date strip stable while a mouse press focuses this pane. A new
  // tab list asks the web host to reveal the active tab and can move the date
  // being clicked before mouse-up, cancelling selection of an offscreen expiry.
  const expirationTabs = useMemo(() => expirationDates.map((ts) => ({
    label: formatExpDate(ts),
    value: String(ts),
  })), [expirationDates]);
  const loading = (initialChainEntry?.phase === "loading" || initialChainEntry?.phase === "refreshing") && !chain
    || (expirationChainEntry?.phase === "loading" || expirationChainEntry?.phase === "refreshing");
  // Refresh failures keep a ready entry with last-good data and an error.
  // Surface that warning even when the cached chain is still usable.
  const error = (expirationUnavailable ? "Selected expiration unavailable." : null)
    ?? initialChainEntry?.error?.message ?? expirationChainEntry?.error?.message
    ?? (initialChainEntry?.phase === "error" || expirationChainEntry?.phase === "error"
      ? "Failed to load options" : null);

  useEffect(() => {
    onCaptureRef.current = onCapture;
  }, [onCapture]);

  const enterInteractive = useCallback(() => {
    if (!interactive) {
      setInteractive(true);
      onCaptureRef.current(true);
    }
  }, [interactive]);

  const exitInteractive = useCallback(() => {
    if (interactive) {
      setInteractive(false);
      onCaptureRef.current(false);
    }
  }, [interactive]);

  const selectExpiration = useCallback((expiration: number) => {
    updatePaneSettings({ expiration, expirationTargetKey: selectionTargetKey });
  }, [selectionTargetKey, updatePaneSettings]);
  const selectAdjacentExpiration = useCallback((offset: -1 | 1) => {
    if (expirationDates.length === 0) return;
    const index = expirationDates.indexOf(selectedExpiration!);
    selectExpiration(expirationDates[Math.max(0, Math.min(index + offset, expirationDates.length - 1))]!);
  }, [expirationDates, selectExpiration, selectedExpiration]);

  useEffect(() => {
    userSelectedStrikeRef.current = false;
    setScrollToIndexAlign("nearest");
    setInteractive(false);
    onCaptureRef.current(false);
    setStrikeIdx(0);
    setCalcSide(null);
    setContractSelection(null);
  }, [selectionTargetKey]);

  useEffect(() => {
    if (!target || !initialChain || expirationTargetKey === selectionTargetKey || selectedExpiration == null) return;
    // Persist local choices in the same field as incoming handoffs, scoped to
    // this holding and instrument. A new target starts at its own held date.
    selectExpiration(selectedExpiration);
  }, [expirationTargetKey, initialChain, selectExpiration, selectedExpiration, selectionTargetKey, target?.cacheKey]);

  useEffect(() => {
    userSelectedStrikeRef.current = false;
  }, [selectedExpiration]);

  const strikes = useMemo(() => strikeChain ? buildStrikeList(strikeChain) : [], [strikeChain]);
  const selectedStrikeIdx = selectedContract ? strikes.indexOf(selectedContract.strike) : strikeIdx;
  const callsByStrike = useMemo(
    () => new Map(strikeChain?.calls.map((c) => [c.strike, c]) ?? []),
    [strikeChain],
  );
  const putsByStrike = useMemo(
    () => new Map(strikeChain?.puts.map((p) => [p.strike, p]) ?? []),
    [strikeChain],
  );
  const snapshotRows = useMemo<OptionTableRow[]>(() => {
    const now = Date.now();
    return strikes.map((strike) => {
      const call = callsByStrike.get(strike);
      const put = putsByStrike.get(strike);
      return {
        strike,
        call,
        put,
        callGreeks: calculateOptionGreeks(call, "call", spot, dividendYield, now),
        putGreeks: calculateOptionGreeks(put, "put", spot, dividendYield, now),
        isPositionStrike: !!parsed && strike === parsed.strike,
      };
    });
  }, [callsByStrike, dividendYield, parsed, putsByStrike, spot, strikes]);
  const summary = useMemo(
    () => strikeChain
      ? calculateOptionsSummary(strikeChain, spot, dailyHistory ?? [])
      : null,
    [spot, strikeChain, dailyHistory],
  );
  const enrichmentState = useOptionsEnrichment({
    instrument: baseRequest?.instrument ?? null, expiration: selectedExpiration,
    selectedEntry: strikeChain === expirationChain ? expirationChainEntry
      : strikeChain === initialChain ? initialChainEntry : null,
    catalogue: availableExpirations, spot, spotAsOf: underlying?.quote?.lastUpdated,
  });
  const enrichment = expirationUnavailable ? null : enrichmentState.snapshot;
  usePaneNoticeFooter({ registrationId: "options-enrichment-warnings", focused,
    notices: [...(enrichment?.warnings ?? []), enrichmentState.error, enrichment?.error]
      .filter((value): value is string => !!value) });
  usePaneFooter("options-enrichment", () => ({ info: [
    ...(enrichmentState.loading ? [{ id: "enrichment-loading", parts: [{ text: "loading analytics", tone: "muted" as const }] }] : []),
    ...(enrichment?.asOf ? [{ id: "enrichment-asof",
      title: [`Selected: ${enrichment.asOf} (${enrichment.source ?? "options"})`,
        `Adjacent: ${enrichment.neighbourAsOf ?? "unavailable"} (${enrichment.neighbourSource ?? "options"})`,
        `Treasury: ${enrichment.rateAsOf.join(", ") || "unavailable"}`,
        `Underlying mark: ${enrichment.spot} as of ${enrichment.spotAsOf ?? "unavailable"}`].join("\n"),
      parts: [{ text: `Analytics ${enrichment.asOf.slice(0, 16).replace("T", " ")} UTC`, tone: "muted" as const }] }] : []),
  ] }), [enrichmentState.loading, enrichment]);
  const visibleStrikeRange = visibleStrikeViewport?.key === viewportKey
    ? visibleStrikeViewport.range
    : null;
  const handleVisibleStrikeRangeChange = useCallback((range: DataTableVisibleRange) => {
    setVisibleStrikeViewport((current) => (
      current?.key === viewportKey
      && current.range.start === range.start
      && current.range.end === range.end
        ? current
        : { key: viewportKey, range }
    ));
  }, [viewportKey]);
  const optionQuoteTargets = useMemo(
    () => buildOptionQuoteTargets(snapshotRows, {
      fallbackHeight: height,
      selectedIndex: selectedStrikeIdx,
      visibleRange: visibleStrikeRange,
    }),
    [height, snapshotRows, selectedStrikeIdx, visibleStrikeRange],
  );
  const {
    entries: optionQuoteEntries,
    freshnessNow,
    subscriptionStartedAt,
  } = useLiveQuoteEntries(optionQuoteTargets, {
    freshnessScopeKey: viewportKey,
    liveStreaming,
  });
  const optionQuoteFreshness = useMemo(
    () => ({
      now: freshnessNow,
      subscriptionStartedAt,
    }),
    [freshnessNow, subscriptionStartedAt],
  );
  const rows = useMemo(
    () => overlayOptionRowQuotes(snapshotRows, optionQuoteEntries, optionQuoteFreshness),
    [optionQuoteEntries, optionQuoteFreshness, snapshotRows],
  );
  const optionQuoteCoverage = useMemo(
    () => resolveOptionQuoteCoverage(
      optionQuoteTargets,
      optionQuoteEntries,
      optionQuoteFreshness,
    ),
    [optionQuoteEntries, optionQuoteFreshness, optionQuoteTargets],
  );
  const optionColumns = useMemo<OptionColumn[]>(() => createOptionColumns(optionFieldIds).map((column) => ({
    ...column,
    headerColor: optionColumnColor(column, colors.panel),
  })), [optionFieldIds]);

  const selectedRow = rows[selectedStrikeIdx] ?? null;
  const selectedContractAvailable = !selectedContract || (selectedContract.side === "call"
    ? selectedRow?.call : selectedRow?.put)?.contractSymbol === selectedContract.contractSymbol;
  const selectedSide = selectedContract
    ? selectedContractAvailable ? selectedContract.side : null
    : resolveCalcSide(calcSide, parsed?.side, selectedRow);
  const selectedReference = optionMarketReference(selectedSide === "put" ? selectedRow?.put
    : selectedSide === "call" ? selectedRow?.call : undefined);
  const calcParams = useMemo(() => buildChainCalcParams({
    symbol: effectiveTicker,
    row: selectedRow,
    side: selectedSide,
    // On an option ticker the pane quote is the contract's own price, so load
    // the underlying snapshot rather than silently using the option mark as spot.
    spot,
    dividendYield,
  }), [dividendYield, effectiveTicker, selectedSide, selectedRow, spot]);

  const openCalculator = useCallback(() => {
    if (!calcParams) return;
    createPaneFromTemplate(OPTIONS_CALCULATOR_TEMPLATE_ID, { values: calcParams });
  }, [calcParams, createPaneFromTemplate]);

  const scenarioContract = selectedSide === "put" ? selectedRow?.put : selectedSide === "call" ? selectedRow?.call : null;
  const scenarioMid = scenarioContract ? optionMid(scenarioContract) : null;
  const scenarioAvailable = !!calcParams && scenarioMid != null && !!scenarioContract
    && Number.isFinite(scenarioContract.impliedVolatility) && scenarioContract.impliedVolatility >= 0
    && !!scenarioContract.currency && scenarioContract.currency === underlying?.quote?.currency;
  const openScenario = useCallback(() => {
    const contract = scenarioContract;
    if (!contract || !scenarioAvailable || !selectedSide || scenarioMid == null) return;
    const leg = { id: crypto.randomUUID(), side: selectedSide, quantity: 1, strike: contract.strike,
      expiration: contract.expiration, price: scenarioMid, volatility: contract.impliedVolatility, multiplier: 100 };
    createPaneFromTemplate("options-scenario-pane", { symbol: canonicalTickerKey(effectiveTicker, effectiveExchange),
      values: { seedLeg: JSON.stringify(leg), spot: String(spot),
        currency: contract.currency,
        ...(dividendYield == null ? {} : { dividendYield: String(dividendYield * 100) }),
        asOf: new Date(underlying?.quote?.lastUpdated ?? Date.now()).toISOString() } });
  }, [scenarioContract, scenarioAvailable, scenarioMid, createPaneFromTemplate, dividendYield, effectiveTicker,
    effectiveExchange, selectedSide, spot, underlying?.quote?.lastUpdated]);

  const openSurface = useCallback(() => {
    if (!ticker || selectedExpiration == null) return;
    createPaneFromTemplate("vol-surface-pane", { symbol: ticker.metadata.ticker, ticker, instrument,
      listing: { name: ticker.metadata.name, exchange: ticker.metadata.exchange,
        currency: ticker.metadata.currency, type: ticker.metadata.assetCategory ?? "STK" },
      values: { expiration: String(selectedExpiration) } });
  }, [createPaneFromTemplate, ticker, instrument, selectedExpiration]);
  const footerHints = useMemo(() => [
    ...(calcParams ? [{ id: "calc", key: "c", label: "alc", onPress: openCalculator }] : []),
    ...(scenarioAvailable ? [{ id: "scenario", key: "a", label: "dd to OSA", onPress: openScenario }] : []),
    ...(ticker && selectedExpiration != null ? [{ id: "surface", key: "s", label: "urface", onPress: openSurface }] : []),
  ], [calcParams, openCalculator, scenarioAvailable, openScenario, ticker, selectedExpiration, openSurface]);

  const selectContract = useCallback((row: OptionTableRow, index: number, side?: OptionSide, preservePointer = false) => {
    userSelectedStrikeRef.current = true;
    setScrollToIndexAlign("nearest");
    setStrikeIdx(index);
    const chosenSide = resolveCalcSide(side ?? calcSide, parsed?.side, row);
    const contract = chosenSide === "put" ? row.put : chosenSide === "call" ? row.call : undefined;
    if (contract && chosenSide) {
      setContractSelection((current) => preservePointer && current?.context === strikeSelectionKey && current.strike === row.strike
        ? current : { context: strikeSelectionKey, strike: row.strike,
          side: chosenSide, contractSymbol: contract.contractSymbol });
    }
  }, [calcSide, parsed?.side, strikeSelectionKey]);

  const renderCell = useCallback((
    row: OptionTableRow,
    column: OptionColumn,
    index: number,
    rowState: { selected: boolean },
  ) => {
    const cell = renderOptionCell(row, column, index, rowState);
    if (!column.side) return cell;
    // Clicking a call or put cell is the mouse way to choose which contract
    // [c]alc opens, so it has to select the row itself as well.
    const side: OptionSide = column.side;
    return {
      ...cell,
      onMouseDown: () => {
        enterInteractive();
        selectContract(row, index, side);
        setCalcSide(side);
      },
    };
  }, [enterInteractive, selectContract]);

  useOptionsAccessFooter({
    chain,
    error: [error, underlyingStale ? "Underlying quote stale: Greeks and calculator unavailable" : null,
      selectedContract && strikeChain && !selectedContractAvailable
        ? `Selected ${formatStrikeLabel(selectedContract.strike)} ${selectedContract.side} unavailable` : null,
      summary?.historicalVolatilityUnavailableReason, dailyHistoryEntry?.error?.message].filter(Boolean).join(" · ") || null,
    focused,
    hints: footerHints,
    loading,
    quoteCoverage: optionQuoteCoverage,
    reference: selectedReference,
    spreadColumnVisible: optionFieldIds.includes("spread"),
  });

  useEffect(() => {
    setStrikeIdx((index) => {
      if (strikes.length === 0) return 0;
      return Math.min(index, strikes.length - 1);
    });
  }, [strikes.length]);

  useEffect(() => {
    if (strikes.length === 0 || userSelectedStrikeRef.current) return;
    const targetStrike = resolveDefaultStrikeTarget(parsed?.strike, spot);
    if (targetStrike == null) return;
    setScrollToIndexAlign("center");
    setStrikeIdx(findNearestStrikeIndex(strikes, targetStrike));
    setAutoScrollVersion((version) => version + 1);
  }, [selectedExpiration, parsed?.strike, spot, strikes]);

  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped || event.targetEditable) return;
    if (event.ctrl || event.meta || event.alt || event.shift) return;

    const isEnter = event.name === "enter" || event.name === "return";
    const isEscape = event.name === "escape" || event.name === "esc";
    if (isEnter && !interactive) {
      event.preventDefault();
      event.stopPropagation();
      enterInteractive();
      return;
    }
    if (isEscape && interactive) {
      event.preventDefault();
      event.stopPropagation();
      exitInteractive();
      return;
    }
    if (interactive && isPlainKey(event, "h", "left")) {
      event.preventDefault();
      event.stopPropagation();
      selectAdjacentExpiration(-1);
      return;
    }
    if (interactive && isPlainKey(event, "l", "right")) {
      event.preventDefault();
      event.stopPropagation();
      selectAdjacentExpiration(1);
      return;
    }
    if (isPlainKey(event, "s") && ticker && selectedExpiration != null) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openSurface();
      return true;
    }
    if (isPlainKey(event, "c") && calcParams) {
      event.preventDefault();
      event.stopPropagation();
      openCalculator();
    }
    if (isPlainKey(event, "a") && scenarioAvailable) {
      event.preventDefault(); event.stopPropagation(); openScenario();
    }
  }, { enabled: focused, phase: "before" });

  const handleTableKeyDown = useCallback((event: DataTableKeyEvent) => {
    const isEnter = event.name === "enter" || event.name === "return";

    if (isEnter && !interactive) {
      event.preventDefault?.();
      event.stopPropagation?.();
      enterInteractive();
      return true;
    }
    if (event.name === "escape" && interactive) {
      event.preventDefault?.();
      event.stopPropagation?.();
      exitInteractive();
      return true;
    }
    if (interactive && isPlainKey(event, "h", "left")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      selectAdjacentExpiration(-1);
      return true;
    }
    if (interactive && isPlainKey(event, "l", "right")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      selectAdjacentExpiration(1);
      return true;
    }

    if (isPlainKey(event, "s") && ticker && selectedExpiration != null) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openSurface();
      return true;
    }
    if (isPlainKey(event, "c") && calcParams) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openCalculator();
      return true;
    }
    if (isPlainKey(event, "a") && scenarioAvailable) {
      event.preventDefault?.(); event.stopPropagation?.(); openScenario(); return true;
    }

    return false;
  }, [
    calcParams,
    enterInteractive,
    exitInteractive,
    interactive,
    openCalculator,
    openScenario,
    scenarioAvailable,
    openSurface,
    ticker,
    selectedExpiration,
    selectAdjacentExpiration,
  ]);

  if (!ticker) {
    return <EmptyState title="No ticker selected." message="Select a ticker to view options." />;
  }
  if (loading && !chain) return <Spinner label="Loading options chain..." />;
  if (error && !chain) return <EmptyState title="Options chain unavailable." message={error} />;
  if (!chain || expirationDates.length === 0) {
    return <EmptyState title={`No options available for ${effectiveTicker}.`} />;
  }

  const positionContracts = isOpt && parsed
    ? ticker.metadata.positions.reduce((sum, p) => sum + Math.abs(p.shares) * signedPositionDirection(p), 0)
    : 0;
  const expirationTabsWidth = Math.max(width - 9 - (loading ? 2 : 0), 8);
  const desiredSummaryRows = width >= 110 ? 3 : width >= 65 ? 4 : 6;
  const summaryRowCount = Math.min(desiredSummaryRows, Math.max(0, height - 6));
  // No term here follows the selection or the load, so an empty cold-expiry
  // response cannot resize the table: growing it during loading would turn a
  // clamped scroll into apparent user navigation.
  const tableHeight = Math.max(1, height - 1 - summaryRowCount - (isOpt && parsed ? 1 : 0));
  // The strip scrolls; without a marker a clipped last date reads as the last expiry.
  const expirationStripOverflows = expirationDates
    .reduce((total, ts) => total + formatExpDate(ts).length + 2, 0) > expirationTabsWidth;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} onMouseDown={() => { if (!interactive) enterInteractive(); }}>
      {summaryRowCount > 0 && (
        <OptionsSummaryStrip summary={summary} enrichment={enrichment} width={width}
          rowCount={summaryRowCount} currency={underlying?.quote?.currency ?? ticker.metadata.currency ?? ""}
          ivRank={showIvRank ? { stats: ivRank } : null} />
      )}

      <Box flexDirection="row" height={1} gap={1}>
        <Text fg={colors.textDim}>Exp:</Text>
        <Box width={expirationTabsWidth} height={1} overflow="hidden">
          <Tabs
            tabs={expirationTabs}
            activeValue={String(selectedExpiration)}
            onSelect={(value) => {
              enterInteractive();
              selectExpiration(Number(value));
            }}
            compact
            variant="bare"
            focused={focused && interactive}
            keyboardNavigation={false}
            scrollId="options-expiration-tabs-scroll"
          />
        </Box>
        {expirationStripOverflows && <Text fg={colors.textDim}>{"\u203a"}</Text>}
        {loading && <Spinner />}
      </Box>

      {isOpt && parsed && (
        <Box height={1}>
          <Text fg={colors.textBright}>
            {`Position: ${positionContracts} ${parsed.side === "C" ? "call" : "put"} contract${Math.abs(positionContracts) !== 1 ? "s" : ""}${positionContracts < 0 ? " (SHORT)" : ""} @ $${parsed.strike}`}
          </Text>
        </Box>
      )}

      <DataTableView<OptionTableRow, OptionColumn>
        focused={focused}
        selection={{
          kind: "id",
          selectedId: selectedContract ? String(selectedContract.strike) : selectedRow ? String(selectedRow.strike) : null,
          getId: (row) => String(row.strike),
          onChange: (_id, row, index, reason) => {
            enterInteractive();
            // A side-cell handler owns its precise contract choice. A later
            // row pointer callback must not replace it with the prior side.
            selectContract(row, index, undefined, reason === "pointer");
          },
        }}
        onCursorChange={() => {
          userSelectedStrikeRef.current = true;
          setScrollToIndexAlign("nearest");
          enterInteractive();
        }}
        onRootKeyDown={handleTableKeyDown}
        headerScrollId="options-table-header-scroll"
        bodyScrollId="options-table-body-scroll"
        columns={optionColumns}
        items={rows}
        sortColumnId={null}
        sortDirection="asc"
        onHeaderClick={() => {}}
        onTableMouseDown={enterInteractive}
        onBodyScrollActivity={(source) => {
          if (source !== "programmatic") userSelectedStrikeRef.current = true;
        }}
        visibleRangeKey={viewportKey}
        onVisibleRangeChange={handleVisibleStrikeRangeChange}
        getItemKey={(row) => String(row.strike)}
        renderCell={renderCell}
        emptyStateTitle={error && !strikeChain ? "Selected expiration unavailable." : strikesLoading ? "Loading strikes..." : "No strikes available."}
        rootWidth={Math.max(1, width - 2)}
        rootHeight={tableHeight}
        columnGap={0}
        horizontalPadding={0}
        scrollToIndex={selectedStrikeIdx >= 0 ? selectedStrikeIdx : undefined}
        scrollToIndexAlign={scrollToIndexAlign}
        scrollToIndexVersion={autoScrollVersion}
      />
    </Box>
  );
}
