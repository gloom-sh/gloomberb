import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FieldGrid, KeyValueRow, QueryBar, usePaneFooter, usePaneNoticeFooter, type GridField } from "../../../components";
import { useAsyncResource, useInputCapture } from "../../../public/react";
import { useShortcut } from "../../../react/input";
import { useAppSelector, usePaneInstance, usePaneStateValue } from "../../../state/app/context";
import { selectCommandBarOpen } from "../../../state/selectors-ui";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { OPTIONS_CALCULATOR_PANE_ID, daysToExpiryFrom, describeDraftProblem, draftFromParams, reconcileOptionCalcDraft, solveImpliedVolatility, updateOptionCalcDraft, valueOption, type OptionCalcDraft, type OptionSide } from "./model";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import { buildOptionQuoteKey, freshOptionQuote, OPTIONS_QUOTE_EXCHANGE } from "../options/live-quotes";
import { useLiveStreamingSetting } from "../shared/live-streaming";
import { optionMid } from "../shared/volatility";
import { useThrottledValue } from "../shared/volatility/live-session";
import { valueBinomialOption, solveBinomialImpliedVolatility, effectiveBinomialSteps } from "./binomial";
import { draftFromCalculatorInputs, parseCashDividends } from "./inputs";
import { loadCalculatorSurfaceVol } from "./surface";
import { OptionQuoteContext, optionQuoteContextHeight } from "../options/quote-context";
import { useCalculatorEvidence, CALCULATOR_IGNORED_DIVIDENDS_NOTICE, type CalculatorScreenshotSnapshot } from "./evidence";

const SIDE_OPTIONS = [
  { label: "Call", value: "call" },
  { label: "Put", value: "put" },
];
const MODEL_OPTIONS = [
  { label: "European BS", short: "Euro BS", value: "european" },
  { label: "American CRR", short: "Amer CRR", value: "american" },
];
const IV_SOURCE_OPTIONS = [
  { label: "Input", value: "input" },
  { label: "Surface", value: "surface" },
];

function formatSigned(value: number | undefined, decimals: number): string {
  if (value == null) return "--";
  return `${value > 0 ? "+" : ""}${formatNumber(value, decimals)}`;
}

export function OptionsCalculatorPane({ focused, width, height }: PaneProps) {
  const paneInstance = usePaneInstance();
  const screenshotSnapshot = paneInstance?.settings?.calculatorSnapshot as CalculatorScreenshotSnapshot | undefined;
  const seedResult = useMemo(() => {
    if (screenshotSnapshot?.draft) return { draft: screenshotSnapshot.draft,
      dividendText: (screenshotSnapshot.draft.dividends ?? []).map(({ days, amount }) => `${days}:${amount}`).join(";"), error: null };
    const params = paneInstance?.params ?? {};
    const { dividends, ...inputs } = { model: params.model, steps: params.steps,
      volSource: params.volSource, dividends: params.dividends, ...paneInstance?.settings };
    // Keep the raw schedule editable even when invalid. Only the American
    // calculation consumes it, including when first opened from settings.
    const dividendText = dividends == null ? "" : String(dividends);
    try { return { draft: draftFromCalculatorInputs(inputs, draftFromParams(params)), dividendText, error: null }; }
    catch (error) { return { draft: draftFromParams(params), dividendText, error: error instanceof Error ? error.message : String(error) }; }
  }, [paneInstance?.params, paneInstance?.settings, screenshotSnapshot]);
  const seed = seedResult.draft;
  const [seedError, setSeedError] = useState(seedResult.error);
  const [storedDraft, setDraft] = usePaneStateValue<OptionCalcDraft>("draft", seed);
  const draft = useMemo(() => reconcileOptionCalcDraft(storedDraft, seed), [storedDraft, seed]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const commandBarOpen = useAppSelector(selectCommandBarOpen);
  const american = draft.pricingModel === "american";
  const surfaceSource = draft.volSource === "surface";
  const [dividendText, setDividendText] = usePaneStateValue("dividendText", seedResult.dividendText);
  const [symbolText, setSymbolText] = useState(draft.symbol);
  const dividendInput = useMemo(() => {
    try { return { dividends: parseCashDividends(dividendText, draft.daysToExpiry), error: null }; }
    catch (error) { return { dividends: [], error: error instanceof Error ? error.message : String(error) }; }
  }, [dividendText, draft.daysToExpiry]);
  useInputCapture(focused && (activeFieldId === "symbol" || activeFieldId === "dividends"));
  const surfaceKey = JSON.stringify([draft.symbol, draft.strike, draft.daysToExpiry]);
  const controller = useRef<AbortController | null>(null);
  const loadSurface = useCallback(async (force: boolean) => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    return { key: surfaceKey, result: await loadCalculatorSurfaceVol({ symbol: draft.symbol, spot: draft.spot,
      strike: draft.strike, daysToExpiry: draft.daysToExpiry, signal: abort.signal, forceRefresh: force }) };
  }, [surfaceKey]);
  const surfaceResource = useAsyncResource(surfaceSource && !!draft.symbol && !screenshotSnapshot ? loadSurface : null);
  useEffect(() => () => controller.current?.abort(), [loadSurface, surfaceSource]);
  const surface = screenshotSnapshot ? screenshotSnapshot.surface
    : surfaceResource.data?.key === surfaceKey ? surfaceResource.data.result : null;
  // A calculator opened on a chain contract follows that contract and its
  // underlying until the user edits the price, the contract or the spot:
  // any edit is theirs and ends the link for that input.
  const liveStreaming = useLiveStreamingSetting();
  const reference = draft.marketReference;
  const priceLinked = !screenshotSnapshot && !!draft.marketPriceSource && !!reference && !!draft.symbol;
  const spotLinked = priceLinked && draft.spot === seed.spot;
  // One stable subscription while the price is linked: dropping the
  // underlying when only the spot is edited would restart the contract's
  // freshness window and briefly fall back to the saved observation.
  const liveTargets = useMemo<QuoteSubscriptionTarget[]>(() => !priceLinked ? [] : [
    { symbol: draft.symbol, exchange: "", route: "provider", surface: "options", visible: true, selected: true, weight: 90 },
    { symbol: reference!.contractSymbol, exchange: OPTIONS_QUOTE_EXCHANGE, surface: "options", visible: true, selected: true, weight: 90 },
  ], [priceLinked, draft.symbol, reference?.contractSymbol]);
  const { entries: liveEntries, freshnessNow, subscriptionStartedAt } = useLiveQuoteEntries(liveTargets, { liveStreaming });
  // American trees solve IV by repeated valuation, so their live inputs move at most twice a second.
  const liveInputs = useThrottledValue(useMemo(() => {
    if (!priceLinked || !reference) return null;
    const spotQuote = spotLinked ? resolveEntryData(liveEntries.get(buildQuoteKey({ symbol: draft.symbol, exchange: "" }))) : null;
    const spot = spotQuote && !spotQuote.stale && spotQuote.price > 0 && Number.isFinite(spotQuote.price) ? spotQuote.price : null;
    const quote = freshOptionQuote(liveEntries.get(buildOptionQuoteKey(reference.contractSymbol)),
      { now: Math.max(freshnessNow, Date.now()), subscriptionStartedAt });
    // The link needs a fresh contract quote: a live spot against the saved
    // option price would solve a wrong IV and present the snapshot as live.
    // A known stale spot likewise keeps the whole calculator on the snapshot.
    if (!quote || (spotQuote != null && spot == null)) return null;
    const mid = quote.bid != null && quote.ask != null ? optionMid({ bid: quote.bid, ask: quote.ask }) : null;
    const trade = quote.lastTradePrice != null && quote.lastTradePrice > 0 && quote.lastTradeTime != null
      && quote.lastTradeTime >= reference.lastTradeDate * 1000 ? { price: quote.lastTradePrice, time: quote.lastTradeTime } : null;
    const price = draft.marketPriceSource === "mid" ? mid : trade?.price ?? null;
    return { spot, price, delayed: (spotQuote != null && spotQuote.dataSource !== "live") || quote.dataSource !== "live",
      reference: { ...reference, bid: quote.bid ?? reference.bid, ask: quote.ask ?? reference.ask,
        lastPrice: trade?.price ?? reference.lastPrice, lastTradeDate: trade ? trade.time / 1000 : reference.lastTradeDate,
        lastUpdated: quote.lastUpdated } };
  }, [priceLinked, spotLinked, reference, liveEntries, draft.symbol, draft.marketPriceSource, freshnessNow, subscriptionStartedAt]),
  draft.pricingModel === "american" ? 500 : 0, `${draft.symbol}|${reference?.contractSymbol ?? ""}`);
  const linkedDraft = useMemo(() => !liveInputs ? draft : { ...draft,
    spot: liveInputs.spot ?? draft.spot,
    marketPrice: liveInputs.price ?? draft.marketPrice,
    // The contract's remaining time runs with the clock while its price is live.
    daysToExpiry: liveInputs.price != null && reference ? daysToExpiryFrom(reference.expiration, Date.now()) : draft.daysToExpiry,
    marketReference: liveInputs.reference }, [draft, liveInputs, reference]);
  const effectiveDraft = useMemo(() => ({ ...linkedDraft, dividends: dividendInput.dividends,
    volatility: surfaceSource && surface?.volatility != null ? surface.volatility : linkedDraft.volatility }), [linkedDraft, dividendInput.dividends, surfaceSource, surface?.volatility]);

  const updateDraft = useCallback((patch: Partial<OptionCalcDraft>) => {
    setSeedError(null);
    setDraft((current) => updateOptionCalcDraft(reconcileOptionCalcDraft(current, seed), patch));
  }, [seed, setDraft]);

  const fields = useMemo<GridField[]>(() => [
    { id: "spot", label: "Spot", value: linkedDraft.spot, valueText: String(linkedDraft.spot), onValue: (value) => updateDraft({ spot: value }) },
    { id: "strike", label: "Strike", value: draft.strike, valueText: String(draft.strike), onValue: (value) => updateDraft({ strike: value }) },
    {
      id: "days",
      label: "Days",
      value: linkedDraft.daysToExpiry,
      // Keep intraday expiry visible; rounding six hours to "0 d" makes a
      // live contract appear expired while its time value is still priced.
      valueText: Number.isInteger(linkedDraft.daysToExpiry)
        ? String(linkedDraft.daysToExpiry)
        : linkedDraft.daysToExpiry > 0 && linkedDraft.daysToExpiry < 0.0001
          ? "<0.0001"
          : String(Number(linkedDraft.daysToExpiry.toFixed(4))),
      suffix: "d",
      onValue: (value) => updateDraft({ daysToExpiry: Math.max(0, value) }),
    },
    { id: "volatility", label: surfaceSource ? "Fit IV" : "Vol", value: effectiveDraft.volatility, valueText: surfaceSource && surface?.volatility == null ? "--" : undefined, percent: true, onValue: (value) => updateDraft({ volatility: Math.max(0, value), volSource: "input" }) },
    { id: "rate", label: "Rate", value: draft.rate, percent: true, allowNegative: true, onValue: (value) => updateDraft({ rate: value }) },
    { id: "dividendYield", label: "Div yld", value: draft.dividendYield, percent: true, onValue: (value) => updateDraft({ dividendYield: value }) },
    {
      id: "marketPrice",
      label: draft.marketPriceSource === "mid" ? "Mid" : draft.marketPriceSource === "last" ? "Last" : draft.marketPrice > 0 ? "Input" : "Market",
      value: linkedDraft.marketPrice,
      valueText: String(Number(linkedDraft.marketPrice.toPrecision(12))),
      // Clearing the field is how a standalone user says "no market price".
      onValue: (value) => updateDraft({ marketPrice: Math.max(0, value), marketPriceSource: undefined }),
      onClear: () => updateDraft({ marketPrice: 0, marketPriceSource: undefined }),
    },
    ...(american ? [{ id: "steps", label: "Steps", value: draft.steps ?? 400, valueText: String(draft.steps ?? 400),
      onValue: (value: number) => updateDraft({ steps: value }) }] : []),
  ], [draft, linkedDraft, updateDraft, american, surfaceSource, effectiveDraft.volatility, surface?.volatility]);

  const calculation = useMemo(() => {
    const unavailable = seedError ?? (american ? dividendInput.error : null)
      ?? (surfaceSource && !draft.symbol ? "Choose an underlying ticker for surface IV." : null)
      ?? (surfaceSource && !surfaceResource.loading && surface?.volatility == null ? surface?.error ?? surfaceResource.error ?? "Surface IV unavailable." : null);
    if (unavailable || surfaceSource && surface?.volatility == null) {
      return { valuation: null, implied: { volatility: null, note: null }, problem: unavailable };
    }
    try {
      const options = { exercise: "american" as const, steps: draft.steps ?? 400, dividends: dividendInput.dividends };
      return { valuation: american ? valueBinomialOption(effectiveDraft, options) : valueOption(effectiveDraft),
        effectiveSteps: american ? effectiveBinomialSteps(effectiveDraft, options) : null,
        implied: american ? solveBinomialImpliedVolatility(effectiveDraft, effectiveDraft.marketPrice, options)
          : solveImpliedVolatility(effectiveDraft, effectiveDraft.marketPrice), problem: describeDraftProblem(effectiveDraft) };
    } catch (error) {
      return { valuation: null, implied: { volatility: null, note: null }, problem: error instanceof Error ? error.message : String(error) };
    }
  }, [effectiveDraft, american, draft.steps, dividendInput, surfaceSource, surface,
    surfaceResource.loading, surfaceResource.error, seedError]);
  const { valuation, implied, problem, effectiveSteps } = calculation;
  const notices = useMemo(() => [...(surfaceSource ? surface?.warnings ?? [] : []),
    ...(!american && dividendInput.dividends.length ? [CALCULATOR_IGNORED_DIVIDENDS_NOTICE] : [])],
  [surfaceSource, surface?.warnings, american, dividendInput.dividends]);
  useCalculatorEvidence({ draft: effectiveDraft, valuation, implied, surface: surfaceSource ? surface : null,
    effectiveSteps, loading: surfaceSource && surfaceResource.loading, error: problem, notices });
  const setModel = (model: string) => { updateDraft({ pricingModel: model as "european" | "american" }); setActiveFieldId(null); };
  const setVolSource = (source: string) => {
    updateDraft({ volSource: source as "input" | "surface" });
    if (source === "surface" && !draft.symbol) setActiveFieldId("symbol");
  };
  const commitSymbol = (symbol: string) => { updateDraft({ symbol: symbol.trim().toUpperCase() }); setActiveFieldId(null); };
  // Leaving the underlying cell by any route (click, Tab, Esc) applies it.
  const previousActiveField = useRef(activeFieldId);
  useEffect(() => {
    const previous = previousActiveField.current;
    previousActiveField.current = activeFieldId;
    if (previous === "symbol" && activeFieldId !== "symbol") {
      const next = symbolText.trim().toUpperCase();
      if (next !== draft.symbol) updateDraft({ symbol: next });
    }
  }, [activeFieldId, draft.symbol, symbolText, updateDraft]);


  const setSide = useCallback((side: OptionSide) => updateDraft({ side }), [updateDraft]);
  const selectedField = fields[Math.min(selectedIndex, fields.length - 1)] ?? null;
  const editSelectedField = useCallback(() => setActiveFieldId(selectedField?.id ?? null), [selectedField?.id]);
  const editSymbol = useCallback(() => { setSymbolText(draft.symbol); setActiveFieldId("symbol"); }, [draft.symbol]);

  // Tab walks the fields only while one is being edited, and past either end
  // it leaves them, so the next Tab moves to the next pane as everywhere else.
  // Enter or `e` starts editing, Enter in a cell commits and keeps the exact
  // number in view, and Esc stops.
  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped) return;
    const consume = () => { event.preventDefault(); event.stopPropagation(); };
    const plainTab = event.name === "tab"
      && !event.ctrl && !event.meta && !event.super && !event.alt;
    if (activeFieldId === "dividends" || activeFieldId === "symbol") {
      // Enter reaches the text field itself, which submits and leaves.
      if (plainTab || isPlainKey(event, "escape", "esc")) {
        consume();
        if (activeFieldId === "symbol") commitSymbol(symbolText); else setActiveFieldId(null);
      }
      return;
    }
    const ringIndex = activeFieldId ? fields.findIndex((field) => field.id === activeFieldId) : -1;
    if (ringIndex >= 0) {
      if (plainTab) {
        consume();
        const nextIndex = ringIndex + (event.shift ? -1 : 1);
        if (nextIndex < 0 || nextIndex >= fields.length) {
          setActiveFieldId(null);
          return;
        }
        setSelectedIndex(nextIndex);
        setActiveFieldId(fields[nextIndex]!.id);
      } else if (isPlainKey(event, "escape", "esc")) {
        // Leaving the cell commits what was typed.
        consume();
        setActiveFieldId(null);
      }
      return;
    }
    if (event.targetEditable) return;
    if (isPlainKey(event, "left", "right")) {
      consume();
      setSide(event.name === "left" ? "call" : "put");
    } else if (isPlainKey(event, "enter", "return", "e")) {
      consume();
      editSelectedField();
    } else if (isPlainKey(event, "m")) {
      consume();
      setModel(american ? "european" : "american");
    } else if (isPlainKey(event, "v")) {
      consume();
      setVolSource(surfaceSource ? "input" : "surface");
    } else if (isPlainKey(event, "t")) {
      consume();
      editSymbol();
    } else if (american && isPlainKey(event, "d")) {
      consume();
      setActiveFieldId("dividends");
    } else if (surfaceSource && isPlainKey(event, "r")) {
      consume();
      void surfaceResource.reload();
    }
  }, {
    allowEditable: true,
    enabled: focused && !commandBarOpen,
    phase: "before",
    scope: "options-calculator:fields",
  });

  usePaneFooter(OPTIONS_CALCULATOR_PANE_ID, () => ({
    info: [
      ...(problem ? [{ id: "input", parts: [{ text: problem, tone: "warning" as const }] }] : []),
      ...(implied.note ? [{ id: "iv", parts: [{ text: implied.note, tone: "warning" as const }] }] : []),
      ...(surfaceSource && surfaceResource.loading ? [{ id: "loading", parts: [{ text: "loading surface", tone: "muted" as const }] }] : []),
      ...(surfaceSource && surface?.asOf ? [{ id: "surface-asof", parts: [{ text: `surface · ${surface.asOf}`, tone: "muted" as const }] }] : []),
      ...(effectiveSteps && effectiveSteps !== (draft.steps ?? 400) ? [{ id: "refined", parts: [{ text: `tree refined to ${effectiveSteps} steps`, tone: "muted" as const }] }] : []),
      ...(liveInputs ? [{ id: "market", parts: [{ text: liveInputs.delayed ? "delayed market" : "real-time market", tone: "muted" as const }] }] : []),
    ],
    hints: activeFieldId ? [] : [
      // Names the cell Enter or `e` edits, which the grid does not mark.
      ...(selectedField ? [{ id: "edit", key: "e", label: `dit ${selectedField.label}`, onPress: editSelectedField }] : []),
      { id: "model", key: "m", label: "odel", onPress: () => setModel(american ? "european" : "american") },
      { id: "vol-source", key: "v", label: "ol source", onPress: () => setVolSource(surfaceSource ? "input" : "surface") },
      // Not `u`: that installs an app update.
      { id: "underlying", key: "t", label: "icker", title: "Edit Underlying", onPress: editSymbol },
      ...(american ? [{ id: "dividends", key: "d", label: "ividends", onPress: () => setActiveFieldId("dividends") }] : []),
      ...(surfaceSource ? [{ id: "refresh", key: "r", label: "efresh", onPress: () => { void surfaceResource.reload(); } }] : []),
    ],
  }), [implied.note, problem, american, surfaceSource, surfaceResource.loading, surface, activeFieldId, draft.symbol, draft.steps, effectiveSteps, liveInputs?.delayed, !!liveInputs, selectedField?.id, selectedField?.label, editSelectedField, editSymbol]);

  const gridFields: GridField[] = [
    { id: "symbol", kind: "text", label: "Underlying", valueText: symbolText, placeholder: "ticker",
      onText: (value) => setSymbolText(value.toUpperCase()) },
    ...fields,
    ...(american ? [{ id: "dividends", kind: "text" as const, label: "Dividends", wide: true, valueText: dividendText,
      placeholder: "day:amount; e.g. 30:0.25;90:0.25", onText: setDividendText }] : []),
  ];
  // Each paired metric needs room for its label, value and complete unit.
  const pairMetrics = width >= 82;
  // Leave a column for the native scrollbar beside the result body's padding.
  const resultWidth = Math.max(1, width - 3);
  const metricWidth = pairMetrics ? Math.floor(resultWidth / 2) : resultWidth;
  const trailingMetricWidth = pairMetrics ? Math.max(1, resultWidth - metricWidth) : metricWidth;
  const referenceHeight = optionQuoteContextHeight(linkedDraft.marketReference, resultWidth, Number.POSITIVE_INFINITY, !liveInputs);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <SurfaceNotices notices={notices} focused={focused} />
      <QueryBar
        width={width}
        filters={[
          { id: "side", label: "Type", inline: true, value: draft.side, options: SIDE_OPTIONS, onChange: (value: string) => setSide(value as OptionSide) },
          { id: "model", label: "Model", inline: true, value: american ? "american" : "european", options: MODEL_OPTIONS, onChange: setModel },
          { id: "iv", label: "IV", inline: true, value: surfaceSource ? "surface" : "input", options: IV_SOURCE_OPTIONS, onChange: setVolSource },
        ]}
      />
      <FieldGrid
        fields={gridFields}
        activeId={activeFieldId}
        width={width}
        focused={focused}
        onActivate={(id) => {
          const index = fields.findIndex((field) => field.id === id);
          if (index >= 0) setSelectedIndex(index);
          if (id === "symbol" && activeFieldId !== "symbol") setSymbolText(draft.symbol);
          setActiveFieldId(id);
        }}
        onDeactivate={() => activeFieldId === "symbol" ? commitSymbol(symbolText) : setActiveFieldId(null)}
      />
      <Box height={1} />

      <ScrollBox id="options-calculator-results" flexGrow={1} flexBasis={0} minHeight={0} scrollY focusable={false}>
        {linkedDraft.marketReference && <Box paddingX={1} height={referenceHeight} flexShrink={0}>
          <OptionQuoteContext reference={linkedDraft.marketReference} width={resultWidth} height={referenceHeight} snapshot={!liveInputs} scrollable={false} />
        </Box>}

        <Box flexDirection={pairMetrics ? "row" : "column"} paddingX={1}>
          <KeyValueRow
            label="Model"
            value={valuation ? formatNumber(valuation.price, 4) : "--"}
            detail="per unit"
            color={colors.textBright}
            width={metricWidth}
          />
          <KeyValueRow
            label="Implied IV"
            value={implied.volatility != null ? `${formatNumber(implied.volatility * 100, 2)}%` : "--"}
            detail={implied.volatility != null ? draft.marketPriceSource === "mid" ? "from mid"
              : draft.marketPriceSource === "last" ? "from last" : "from input" : undefined}
            color={implied.volatility != null ? colors.positive : colors.textDim}
            width={trailingMetricWidth}
          />
        </Box>

        <Box flexDirection="column" paddingX={1}>
          <Box flexDirection={pairMetrics ? "row" : "column"}>
            <KeyValueRow label="Delta" value={formatSigned(valuation?.delta, 4)} width={metricWidth} />
            <KeyValueRow label="Gamma" value={valuation ? formatNumber(valuation.gamma, 4) : "--"} width={trailingMetricWidth} />
          </Box>
          <Box flexDirection={pairMetrics ? "row" : "column"}>
            <KeyValueRow label="Theta" value={formatSigned(valuation?.thetaPerDay, 4)} detail="per day" width={metricWidth} />
            <KeyValueRow label="Vega" value={valuation ? formatNumber(valuation.vegaPerPoint, 4) : "--"} detail="per vol pt" width={trailingMetricWidth} />
          </Box>
          <KeyValueRow label="Rho" value={formatSigned(valuation?.rhoPerPoint, 4)} detail="per rate pt" width={metricWidth} />
        </Box>
      </ScrollBox>
    </Box>
  );
}

function SurfaceNotices({ notices, focused }: { notices: string[]; focused: boolean }) {
  usePaneNoticeFooter({ registrationId: "ovme-surface-notices", notices, focused });
  return null;
}
