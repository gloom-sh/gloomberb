import { useCallback, useMemo, useState } from "react";
import { KeyValueRow, Prose, SegmentedControl, usePaneFooter } from "../../../components";
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
import { OptionQuoteContext, optionQuoteContextHeight } from "../options/quote-context";

const SIDE_OPTIONS = [
  { label: "Call", value: "call" },
  { label: "Put", value: "put" },
];

function formatSigned(value: number, decimals: number): string {
  return `${value > 0 ? "+" : ""}${formatNumber(value, decimals)}`;
}

export function OptionsCalculatorPane({ focused, width, height }: PaneProps) {
  const ui = useUiHost();
  const paneInstance = usePaneInstance();
  const seed = useMemo(() => draftFromParams(paneInstance?.params), [paneInstance?.params]);
  const [storedDraft, setDraft] = usePaneStateValue<OptionCalcDraft>("draft", seed);
  const draft = useMemo(() => reconcileOptionCalcDraft(storedDraft, seed), [storedDraft, seed]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);

  const updateDraft = useCallback((patch: Partial<OptionCalcDraft>) => {
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
    { id: "volatility", label: "Vol", value: draft.volatility, percent: true, onValue: (value) => updateDraft({ volatility: Math.max(0, value) }) },
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
  ], [draft, updateDraft]);

  const valuation = useMemo(() => valueOption(draft), [draft]);
  const implied = useMemo(
    () => solveImpliedVolatility(draft, draft.marketPrice),
    [draft],
  );
  const problem = describeDraftProblem(draft);

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
    info: problem
      ? [{ id: "input", parts: [{ text: problem, tone: "warning" as const }] }]
      : implied.note
        ? [{ id: "iv", parts: [{ text: implied.note, tone: "warning" as const }] }]
        : [],
  }), [implied.note, problem]);

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

      <Box height={1} />

      <ScrollBox id="options-calculator-results" flexGrow={1} flexBasis={0} minHeight={0} scrollY focusable={false}>
        {draft.marketReference && <Box paddingX={1} height={referenceHeight} flexShrink={0}>
          <OptionQuoteContext reference={draft.marketReference} width={resultWidth} height={referenceHeight} snapshot scrollable={false} />
        </Box>}

        <Box flexDirection={pairMetrics ? "row" : "column"} paddingX={1}>
          <KeyValueRow
            label="Model"
            value={formatNumber(valuation.price, 4)}
            detail="per unit"
            color={colors.textBright}
            width={metricWidth}
          />
          <KeyValueRow
            label="Implied IV"
            value={implied.volatility != null ? `${formatNumber(implied.volatility * 100, 2)}%` : "—"}
            detail={implied.volatility != null ? draft.marketPriceSource === "mid" ? "from mid"
              : draft.marketPriceSource === "last" ? "from last" : "from input" : undefined}
            color={implied.volatility != null ? colors.positive : colors.textDim}
            width={trailingMetricWidth}
          />
        </Box>

        <Box flexDirection="column" paddingX={1}>
          <Box flexDirection={pairMetrics ? "row" : "column"}>
            <KeyValueRow label="Delta" value={formatSigned(valuation.delta, 4)} width={metricWidth} />
            <KeyValueRow label="Gamma" value={formatNumber(valuation.gamma, 4)} width={trailingMetricWidth} />
          </Box>
          <Box flexDirection={pairMetrics ? "row" : "column"}>
            <KeyValueRow label="Theta" value={formatSigned(valuation.thetaPerDay, 4)} detail="per day" width={metricWidth} />
            <KeyValueRow label="Vega" value={formatNumber(valuation.vegaPerPoint, 4)} detail="per vol pt" width={trailingMetricWidth} />
          </Box>
          <KeyValueRow label="Rho" value={formatSigned(valuation.rhoPerPoint, 4)} detail="per rate pt" width={metricWidth} />
        </Box>
      </ScrollBox>

      <Box paddingX={1} flexShrink={0}>
        <Prose text="European exercise only: no early exercise or discrete dividends." width={Math.max(8, width - 2)} color={colors.textMuted} />
      </Box>
    </Box>
  );
}
