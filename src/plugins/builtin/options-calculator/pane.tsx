import { useCallback, useMemo, useState } from "react";
import { SegmentedControl, usePaneFooter } from "../../../components";
import { usePaneInstance, usePaneStateValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes, useUiHost } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { useShortcut } from "../../../react/input";
import type { InlineField } from "../kelly-sizer/fields";
import { InlineFieldView, MetricLine, truncateText } from "../kelly-sizer/view";
import {
  OPTIONS_CALCULATOR_PANE_ID,
  describeDraftProblem,
  draftFromParams,
  solveImpliedVolatility,
  valueOption,
  type OptionCalcDraft,
  type OptionSide,
} from "./model";

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
  const [draft, setDraft] = usePaneStateValue<OptionCalcDraft>("draft", draftFromParams(paneInstance?.params));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);

  const updateDraft = useCallback((patch: Partial<OptionCalcDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, [setDraft]);

  const fields = useMemo<InlineField[]>(() => [
    { id: "spot", label: "Spot", value: draft.spot, onValue: (value) => updateDraft({ spot: value }) },
    { id: "strike", label: "Strike", value: draft.strike, onValue: (value) => updateDraft({ strike: value }) },
    {
      id: "days",
      label: "Days",
      value: draft.daysToExpiry,
      // Whole days read better than the shared 2-decimal number format.
      valueText: String(Math.round(draft.daysToExpiry)),
      suffix: "d",
      onValue: (value) => updateDraft({ daysToExpiry: Math.max(0, value) }),
    },
    { id: "volatility", label: "Vol", value: draft.volatility, percent: true, onValue: (value) => updateDraft({ volatility: Math.max(0, value) }) },
    { id: "rate", label: "Rate", value: draft.rate, percent: true, allowNegative: true, onValue: (value) => updateDraft({ rate: value }) },
    { id: "dividendYield", label: "Div yld", value: draft.dividendYield, percent: true, onValue: (value) => updateDraft({ dividendYield: value }) },
    {
      id: "marketPrice",
      label: "Market",
      value: draft.marketPrice,
      // Clearing the field is how a standalone user says "no market price".
      onValue: (value) => updateDraft({ marketPrice: Math.max(0, value) }),
      onClear: () => updateDraft({ marketPrice: 0 }),
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
  }, { allowEditable: true, enabled: focused });

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
  const pairMetrics = width >= 50;
  const metricWidth = pairMetrics ? Math.floor((width - 2) / 2) : Math.max(1, width - 2);
  const trailingMetricWidth = pairMetrics ? Math.max(1, width - 2 - metricWidth) : metricWidth;
  const showGreeks = height >= 1 + rows + 1 + (pairMetrics ? 1 : 2) + (pairMetrics ? 3 : 5) + 1;

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

      <Box flexDirection={pairMetrics ? "row" : "column"} paddingX={1}>
        <MetricLine
          label="Fair value"
          value={formatNumber(valuation.price, 4)}
          detail={draft.side === "call" ? "call" : "put"}
          color={colors.textBright}
          width={metricWidth}
        />
        <MetricLine
          label="Implied IV"
          value={implied.volatility != null ? `${formatNumber(implied.volatility * 100, 2)}%` : "—"}
          detail={implied.volatility != null ? "from market" : undefined}
          color={implied.volatility != null ? colors.positive : colors.textDim}
          width={trailingMetricWidth}
        />
      </Box>

      {showGreeks ? (
        <Box flexDirection="column" paddingX={1}>
          <Box flexDirection={pairMetrics ? "row" : "column"}>
            <MetricLine label="Delta" value={formatSigned(valuation.delta, 4)} width={metricWidth} />
            <MetricLine label="Gamma" value={formatNumber(valuation.gamma, 4)} width={trailingMetricWidth} />
          </Box>
          <Box flexDirection={pairMetrics ? "row" : "column"}>
            <MetricLine label="Theta" value={formatSigned(valuation.thetaPerDay, 4)} detail="per day" width={metricWidth} />
            <MetricLine label="Vega" value={formatNumber(valuation.vegaPerPoint, 4)} detail="per vol pt" width={trailingMetricWidth} />
          </Box>
          <MetricLine label="Rho" value={formatSigned(valuation.rhoPerPoint, 4)} detail="per rate pt" width={metricWidth} />
        </Box>
      ) : null}

      <Box flexGrow={1} />

      <Box height={1} paddingX={1} overflow="hidden">
        <Text fg={colors.textMuted}>
          {truncateText(
            "European exercise only: no early exercise or discrete dividends.",
            Math.max(1, width - 2),
          )}
        </Text>
      </Box>
    </Box>
  );
}
