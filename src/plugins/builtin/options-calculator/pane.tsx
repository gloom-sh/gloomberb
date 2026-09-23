import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyValueRow, SegmentedControl, TextField, usePaneFooter, usePaneNoticeFooter } from "../../../components";
import { useAsyncResource, useInputCapture } from "../../../public/react";
import { useShortcut } from "../../../react/input";
import { usePaneInstance, usePaneStateValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, TextAttributes, useUiHost } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import type { InlineField } from "../kelly-sizer/fields";
import { InlineFieldView, truncateText } from "../kelly-sizer/view";
import { OPTIONS_CALCULATOR_PANE_ID, describeDraftProblem, draftFromParams, reconcileOptionCalcDraft, solveImpliedVolatility, updateOptionCalcDraft, valueOption, type OptionCalcDraft, type OptionSide } from "./model";
import { valueBinomialOption, solveBinomialImpliedVolatility, effectiveBinomialSteps } from "./binomial";
import { draftFromCalculatorInputs, parseCashDividends } from "./inputs";
import { loadCalculatorSurfaceVol } from "./surface";
import { OptionQuoteContext, optionQuoteContextHeight } from "../options/quote-context";
import { useCalculatorEvidence, CALCULATOR_IGNORED_DIVIDENDS_NOTICE, type CalculatorScreenshotSnapshot } from "./evidence";

const SIDE_OPTIONS = [
  { label: "Call", value: "call" },
  { label: "Put", value: "put" },
];

function formatSigned(value: number | undefined, decimals: number): string {
  if (value == null) return "--";
  return `${value > 0 ? "+" : ""}${formatNumber(value, decimals)}`;
}

export function OptionsCalculatorPane({ focused, width, height }: PaneProps) {
  const ui = useUiHost();
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
  const effectiveDraft = useMemo(() => ({ ...draft, dividends: dividendInput.dividends,
    volatility: surfaceSource && surface?.volatility != null ? surface.volatility : draft.volatility }), [draft, dividendInput.dividends, surfaceSource, surface?.volatility]);

  const updateDraft = useCallback((patch: Partial<OptionCalcDraft>) => {
    setSeedError(null);
    setDraft((current) => updateOptionCalcDraft(reconcileOptionCalcDraft(current, seed), patch));
  }, [seed, setDraft]);

  const fields = useMemo<InlineField[]>(() => [
    { id: "spot", label: "Spot", value: draft.spot, valueText: String(draft.spot), onValue: (value) => updateDraft({ spot: value }) },
    { id: "strike", label: "Strike", value: draft.strike, valueText: String(draft.strike), onValue: (value) => updateDraft({ strike: value }) },
    {
      id: "days",
      label: "Days",
      value: draft.daysToExpiry,
      // Keep intraday expiry visible; rounding six hours to "0 d" makes a
      // live contract appear expired while its time value is still priced.
      valueText: Number.isInteger(draft.daysToExpiry)
        ? String(draft.daysToExpiry)
        : draft.daysToExpiry > 0 && draft.daysToExpiry < 0.0001
          ? "<0.0001"
          : String(Number(draft.daysToExpiry.toFixed(4))),
      suffix: "d",
      onValue: (value) => updateDraft({ daysToExpiry: Math.max(0, value) }),
    },
    { id: "volatility", label: surfaceSource ? "Fit IV" : "Vol", value: effectiveDraft.volatility, valueText: surfaceSource && surface?.volatility == null ? "--" : undefined, percent: true, onValue: (value) => updateDraft({ volatility: Math.max(0, value), volSource: "input" }) },
    { id: "rate", label: "Rate", value: draft.rate, percent: true, allowNegative: true, onValue: (value) => updateDraft({ rate: value }) },
    { id: "dividendYield", label: "Div yld", value: draft.dividendYield, percent: true, onValue: (value) => updateDraft({ dividendYield: value }) },
    {
      id: "marketPrice",
      label: draft.marketPriceSource === "mid" ? "Mid" : draft.marketPriceSource === "last" ? "Last" : draft.marketPrice > 0 ? "Input" : "Market",
      value: draft.marketPrice,
      valueText: String(Number(draft.marketPrice.toPrecision(12))),
      // Clearing the field is how a standalone user says "no market price".
      onValue: (value) => updateDraft({ marketPrice: Math.max(0, value), marketPriceSource: undefined }),
      onClear: () => updateDraft({ marketPrice: 0, marketPriceSource: undefined }),
    },
    ...(american ? [{ id: "steps", label: "Steps", value: draft.steps ?? 400, valueText: String(draft.steps ?? 400),
      onValue: (value: number) => updateDraft({ steps: value }) }] : []),
  ], [draft, updateDraft, american, surfaceSource, effectiveDraft.volatility, surface?.volatility]);

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
        implied: american ? solveBinomialImpliedVolatility(effectiveDraft, draft.marketPrice, options)
          : solveImpliedVolatility(effectiveDraft, draft.marketPrice), problem: describeDraftProblem(effectiveDraft) };
    } catch (error) {
      return { valuation: null, implied: { volatility: null, note: null }, problem: error instanceof Error ? error.message : String(error) };
    }
  }, [effectiveDraft, american, draft.steps, draft.marketPrice, dividendInput, surfaceSource, surface,
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


  const setSide = useCallback((side: OptionSide) => updateDraft({ side }), [updateDraft]);
  const moveFieldFocus = useCallback((offset: -1 | 1) => {
    const nextIndex = activeFieldId
      ? (selectedIndex + offset + fields.length) % fields.length
      : offset > 0 ? 0 : fields.length - 1;
    setSelectedIndex(nextIndex);
    setActiveFieldId(fields[nextIndex]?.id ?? null);
  }, [activeFieldId, fields, selectedIndex]);

  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped) return;
    const plainTab = event.name === "tab"
      && !event.ctrl && !event.meta && !event.super && !event.alt;
    if (plainTab && (activeFieldId === "dividends" || activeFieldId === "symbol")) {
      event.preventDefault(); event.stopPropagation();
      if (activeFieldId === "symbol") commitSymbol(symbolText); else setActiveFieldId(null);
      return;
    }
    if (plainTab) {
      event.preventDefault();
      event.stopPropagation();
      moveFieldFocus(event.shift ? -1 : 1);
      return;
    }
    if (event.targetEditable) {
      if (activeFieldId && isPlainKey(event, "escape", "esc")) {
        event.preventDefault();
        event.stopPropagation();
        setActiveFieldId(null);
      }
      return;
    }
    if (!activeFieldId && isPlainKey(event, "m", "v", "d", "u", "r")) {
      event.preventDefault(); event.stopPropagation();
      if (event.name === "m") setModel(american ? "european" : "american");
      if (event.name === "v") setVolSource(surfaceSource ? "input" : "surface");
      if (event.name === "d" && american) setActiveFieldId("dividends");
      if (event.name === "u") { setSymbolText(draft.symbol); setActiveFieldId("symbol"); }
      if (event.name === "r" && surfaceSource) void surfaceResource.reload();
      return;
    }
    if (ui.kind === "desktop-web" && isPlainKey(event, "left", "right")) {
      event.preventDefault();
      event.stopPropagation();
      setSide(event.name === "left" ? "call" : "put");
    } else if (isPlainKey(event, "enter", "return", "e")) {
      event.preventDefault();
      event.stopPropagation();
      setActiveFieldId(fields[selectedIndex]?.id ?? null);
    }
  }, {
    allowEditable: true,
    enabled: focused,
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
    ],
    hints: activeFieldId ? [] : [
      { id: "model", key: "m", label: "odel", onPress: () => setModel(american ? "european" : "american") },
      { id: "vol-source", key: "v", label: "ol source", onPress: () => setVolSource(surfaceSource ? "input" : "surface") },
      { id: "underlying", key: "u", label: "nderlying", onPress: () => { setSymbolText(draft.symbol); setActiveFieldId("symbol"); } },
      ...(american ? [{ id: "dividends", key: "d", label: "ividends", onPress: () => setActiveFieldId("dividends") }] : []),
      ...(surfaceSource ? [{ id: "refresh", key: "r", label: "efresh", onPress: () => { void surfaceResource.reload(); } }] : []),
    ],
  }), [implied.note, problem, american, surfaceSource, surfaceResource.loading, surface, activeFieldId, draft.symbol, draft.steps, effectiveSteps]);

  const columns = width >= 78 ? 3 : width >= 42 ? 2 : 1;
  const fieldWidth = Math.max(12, Math.min(26, Math.floor((width - 2) / columns)));
  const rows = Math.max(1, Math.ceil(fields.length / columns));
  // Each paired metric needs room for its label, value and complete unit.
  const pairMetrics = width >= 82;
  // Leave a column for the native scrollbar beside the result body's padding.
  const resultWidth = Math.max(1, width - 3);
  const metricWidth = pairMetrics ? Math.floor(resultWidth / 2) : resultWidth;
  const trailingMetricWidth = pairMetrics ? Math.max(1, resultWidth - metricWidth) : metricWidth;
  const referenceHeight = optionQuoteContextHeight(draft.marketReference, resultWidth, Number.POSITIVE_INFINITY, true);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <SurfaceNotices notices={notices} focused={focused} />
      <Box height={1} paddingX={1} flexDirection="row" gap={1}>
        <SegmentedControl
          options={SIDE_OPTIONS}
          value={draft.side}
          onChange={(value) => setSide(value as OptionSide)}
          focused={focused && !activeFieldId}
          shortcutScope="options-calculator:side"
        />
        {draft.symbol ? (
          <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
            {truncateText(draft.symbol, Math.max(0, width - 20))}
          </Text>
        ) : null}
      </Box>

      <Box paddingX={1} height={width >= 62 ? 1 : 2} flexDirection={width >= 62 ? "row" : "column"} gap={width >= 62 ? 3 : 0}>
        <SegmentedControl options={[{ label: "European BS", value: "european" }, { label: "American CRR", value: "american" }]}
          value={american ? "american" : "european"} onChange={setModel} focused={false} />
        <SegmentedControl options={[{ label: "Input IV", value: "input" }, { label: "Surface IV", value: "surface" }]}
          value={surfaceSource ? "surface" : "input"} onChange={setVolSource} focused={false} />
      </Box>
      {activeFieldId === "symbol" && <Box paddingX={1} height={ui.kind === "desktop-web" ? 3 : 2}>
        <TextField label="Underlying ticker" value={symbolText} width={24} focused={focused}
          onChange={setSymbolText} onSubmit={commitSymbol} />
      </Box>}
      <Box flexDirection="column" paddingX={1} height={rows}>
        {Array.from({ length: rows }, (_, rowIndex) => (
          <Box key={rowIndex} height={1} flexDirection="row">
            {fields.slice(rowIndex * columns, rowIndex * columns + columns).map((field, offset) => {
              const index = rowIndex * columns + offset;
              return (
                <InlineFieldView
                  key={field.id}
                  field={field}
                  active={activeFieldId === field.id}
                  focused={focused}
                  width={fieldWidth}
                  onFocus={() => {
                    setSelectedIndex(index);
                    setActiveFieldId(field.id);
                  }}
                />
              );
            })}
          </Box>
        ))}
      </Box>

      {american && <Box paddingX={1} height={ui.kind === "desktop-web" ? 3 : 2} flexShrink={0}>
        <TextField label="Cash dividends (day:amount)" value={dividendText} placeholder="30:0.25;90:0.25"
          width={Math.max(20, width - 3)} focused={focused && activeFieldId === "dividends"}
          onMouseDown={() => setActiveFieldId("dividends")} onChange={setDividendText} onSubmit={() => setActiveFieldId(null)} />
      </Box>}
      <Box height={1} />

      <ScrollBox id="options-calculator-results" flexGrow={1} flexBasis={0} minHeight={0} scrollY focusable={false}>
        {draft.marketReference && <Box paddingX={1} height={referenceHeight} flexShrink={0}>
          <OptionQuoteContext reference={draft.marketReference} width={resultWidth} height={referenceHeight} snapshot scrollable={false} />
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
