import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "../../../ui";
import { usePaneSettingValue, usePaneTicker } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { isPlainKey } from "../../../utils/keyboard";
import { formatCompact } from "../../../utils/format";
import { formatExpDate, resolveOptionsTarget } from "../../../utils/options";
import { useOptionsQuery, useResolvedEntryValue, useTickerFinancials } from "../../../market-data/hooks";
import {
  DataTableView,
  EmptyState,
  Spinner,
  Tabs,
  type DataTableKeyEvent,
  type DataTableVisibleRange,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { useLiveQuoteEntries, useQuoteUpdates } from "../../../state/hooks/quote-streaming";
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

type SummaryMetric = { label: string; value: string };

function formatRatio(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(2);
}

function SummaryRow({ metrics }: { metrics: SummaryMetric[] }) {
  return (
    <Box flexDirection="row" height={1} gap={3} overflow="hidden">
      {metrics.map((metric) => (
        <Box key={metric.label} flexDirection="row" flexShrink={0}>
          <Text fg={colors.textDim}>{`${metric.label} `}</Text>
          <Text fg={colors.textBright}>{metric.value}</Text>
        </Box>
      ))}
    </Box>
  );
}

function OptionsSummaryStrip({ summary, secondary }: {
  summary: OptionsSummary | null;
  secondary: boolean;
}) {
  const volatility: SummaryMetric[] = [
    { label: "ATM IV", value: formatIv(summary?.atmImpliedVolatility ?? undefined) },
    { label: "HV30", value: formatIv(summary?.historicalVolatility30d ?? undefined) },
    { label: "IV/HV", value: formatRatio(summary?.impliedHistoricalRatio) },
  ];
  return (
    <Box flexDirection="column" height={secondary ? 2 : 1}>
      <SummaryRow metrics={volatility} />
      {secondary && (
        <SummaryRow metrics={[
          { label: "EXP VOL", value: formatCompact(summary?.expirationVolume ?? undefined) },
          { label: "P/C VOL", value: formatRatio(summary?.putCallVolumeRatio) },
          { label: "P/C OI", value: formatRatio(summary?.putCallOpenInterestRatio) },
        ]} />
      )}
    </Box>
  );
}

export function OptionsView({ width, height, focused, onCapture = () => {} }: OptionsViewProps) {
  const { ticker, financials } = usePaneTicker();
  const { createPaneFromTemplate } = usePluginAppActions();
  const liveStreaming = useLiveStreamingSetting();
  const [seededExpiration] = usePaneSettingValue<number | undefined>("expiration", undefined);
  const [expirySelection, setExpirySelection] = useState<{ targetKey: string; expiration: number } | null>(null);
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
  const [chainRefreshMinutes] = usePaneSettingValue<string>("chainRefreshMinutes", "");
  const [storedOptionFieldIds] = usePaneSettingValue<OptionFieldId[]>("optionColumnIds", DEFAULT_OPTION_FIELD_IDS);
  const optionFieldIds = useMemo(() => resolveOptionFieldIds(storedOptionFieldIds), [storedOptionFieldIds]);
  const initialChainEntry = useOptionsQuery(baseRequest);
  const initialChain = useResolvedEntryValue(initialChainEntry);
  const initialExpiration = initialChain?.expirationDates.reduce((best, expiration) => (
    parsed && Math.abs(expiration - parsed.expTs) < Math.abs(best - parsed.expTs) ? expiration : best
  ), initialChain.expirationDates[0]!);
  const selectedExpiration = expirySelection?.targetKey === selectionTargetKey
    ? expirySelection.expiration : seededExpiration ?? initialExpiration;
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
    setExpirySelection({ targetKey: selectionTargetKey, expiration });
  }, [selectionTargetKey]);
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
    if (expirySelection?.targetKey === selectionTargetKey || selectedExpiration == null) return;
    // The holding/default chooses the date only on entering a new context.
    selectExpiration(selectedExpiration);
  }, [expirySelection?.targetKey, selectExpiration, selectedExpiration, selectionTargetKey]);

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
      ? calculateOptionsSummary(strikeChain, spot, underlying?.priceHistory ?? [])
      : null,
    [spot, strikeChain, underlying?.priceHistory],
  );
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

  const footerHints = useMemo(
    () => (calcParams ? [{ id: "calc", key: "c", label: "alc", onPress: openCalculator }] : undefined),
    [calcParams, openCalculator],
  );

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
      summary?.historicalVolatilityUnavailableReason].filter(Boolean).join(" · ") || null,
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
    if (isPlainKey(event, "c") && calcParams) {
      event.preventDefault();
      event.stopPropagation();
      openCalculator();
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

    if (isPlainKey(event, "c") && calcParams) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openCalculator();
      return true;
    }

    return false;
  }, [
    calcParams,
    enterInteractive,
    exitInteractive,
    interactive,
    openCalculator,
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
  const summaryRowCount = height >= 10 ? 2 : height >= 7 ? 1 : 0;
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
        <OptionsSummaryStrip summary={summary} secondary={summaryRowCount > 1} />
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
