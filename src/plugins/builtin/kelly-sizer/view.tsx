import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, Text, TextAttributes, type InputRenderable } from "../../../ui";
import type { KeyEventLike } from "../../../react/input";
import { colors } from "../../../theme/colors";
import { NumberField } from "../../../components/ui";
import { formatCurrency, formatNumber, formatPercentRaw } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import type { SensitivityGrid } from "./model";
import type { InlineField } from "./fields";
export type { InlineField } from "./fields";

export function truncateText(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (value.length <= maxWidth) return value;
  if (maxWidth <= 1) return value.slice(0, maxWidth);
  return `${value.slice(0, maxWidth - 1)}…`;
}

export function formatPct(value: number, decimals = 1): string {
  return `${formatNumber(value * 100, decimals)}%`;
}

export function formatSignedPct(value: number): string {
  return formatPercentRaw(value * 100);
}

export function isPlainShortcut(event: KeyEventLike, ...names: string[]): boolean {
  if (isPlainKey(event, ...names)) return true;
  const key = event.key?.toLowerCase();
  return !event.ctrl && !event.meta && !event.super && !event.alt && names.includes(key);
}

function parsePromptNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatInputNumber(value: number, percent = false): string {
  const scaled = percent ? value * 100 : value;
  const decimals = percent
    ? Math.abs(scaled) >= 10 ? 1 : 2
    : Math.abs(scaled) >= 100 ? 0 : 2;
  return formatNumber(scaled, decimals).replace(/,/g, "");
}

export function InlineFieldView({
  field,
  active,
  width,
  focused,
  onFocus,
}: {
  field: InlineField;
  active: boolean;
  width: number;
  focused: boolean;
  onFocus: () => void;
}) {
  const labelWidth = Math.min(12, Math.max(7, Math.floor(width * 0.38)));
  const suffixWidth = field.suffix ? field.suffix.length + 1 : field.percent ? 2 : 0;
  // Capped so the unit sits next to the number instead of being pushed to the far
  // edge of a wide pane.
  const valueWidth = Math.max(5, Math.min(12, width - labelWidth - suffixWidth - 2));
  const inputNodeRef = useRef<InputRenderable | null>(null);
  const displayValue = field.valueText ?? formatInputNumber(field.value ?? 0, field.percent);
  const fieldRef = useRef(field);
  const displayValueRef = useRef(displayValue);
  const [text, setText] = useState(displayValue);
  const latestTextRef = useRef(displayValue);
  const committedTextRef = useRef(displayValue);
  const wasActiveRef = useRef(active);
  const dirtyRef = useRef(false);
  fieldRef.current = field;
  displayValueRef.current = displayValue;
  const focusInput = useCallback(() => {
    const input = inputNodeRef.current;
    try {
      input?.focus?.();
      input?.setCursorOffset?.(0);
    } catch {
      // Renderer teardown can race queued focus attempts.
    }
  }, []);
  const fg = active
    ? colors.selectedText
    : field.tone === "positive"
      ? colors.positive
      : field.tone === "negative"
        ? colors.negative
        : colors.text;

  const commitText = useCallback((nextText: string): string | null => {
    const currentField = fieldRef.current;
    if (nextText.trim() === "") {
      currentField.onClear?.();
      return null;
    }
    const parsed = parsePromptNumber(nextText);
    if (parsed == null) return null;
    const nextValue = currentField.percent ? parsed / 100 : parsed;
    currentField.onValue?.(nextValue);
    return formatInputNumber(nextValue, currentField.percent);
  }, []);

  const commitEditText = useCallback((nextText: string, fallbackText = displayValue) => {
    latestTextRef.current = nextText;
    const committedText = commitText(nextText);
    committedTextRef.current = committedText ?? fallbackText;
    setText(committedTextRef.current);
    dirtyRef.current = false;
  }, [commitText, displayValue]);

  const getLiveInputText = useCallback(() => {
    const input = inputNodeRef.current;
    if (!input) return latestTextRef.current;
    try {
      return input.editBuffer.getText();
    } catch {
      return latestTextRef.current;
    }
  }, []);

  const commitLiveInputText = useCallback(() => {
    const liveText = getLiveInputText();
    const nextText = typeof liveText === "string" ? liveText : latestTextRef.current;
    if (!dirtyRef.current && (nextText.trim() === "" || nextText === committedTextRef.current)) return;
    latestTextRef.current = nextText;
    const committedText = commitText(nextText);
    committedTextRef.current = committedText ?? displayValueRef.current;
    dirtyRef.current = false;
  }, [commitText, getLiveInputText]);

  useLayoutEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (!wasActive && active) {
      dirtyRef.current = false;
      latestTextRef.current = "";
      committedTextRef.current = displayValue;
      setText("");
      return;
    }
    if (wasActive && !active) {
      const nextText = dirtyRef.current ? latestTextRef.current : text;
      if (dirtyRef.current) {
        commitEditText(nextText);
      } else {
        committedTextRef.current = displayValue;
        setText(displayValue);
      }
      return;
    }
    if (!active) {
      latestTextRef.current = displayValue;
      committedTextRef.current = displayValue;
      setText(displayValue);
    }
  }, [active, commitEditText, displayValue, text]);

  useEffect(() => {
    if (!active) return;
    let animationFrame: number | null = null;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    focusInput();
    queueMicrotask(focusInput);
    animationFrame = globalThis.requestAnimationFrame?.(focusInput) ?? null;
    timeouts.push(setTimeout(focusInput, 0), setTimeout(focusInput, 32));
    return () => {
      if (animationFrame !== null) globalThis.cancelAnimationFrame?.(animationFrame);
      for (const timeout of timeouts) clearTimeout(timeout);
    };
  }, [active, focusInput]);

  useLayoutEffect(() => {
    if (!active) return;
    return () => {
      commitLiveInputText();
    };
  }, [active, commitLiveInputText]);

  const handleSubmit = (nextText: string) => {
    commitEditText(nextText, nextText);
  };

  const handleBlur = (nextText: string) => {
    if (!dirtyRef.current && (nextText.trim() === "" || nextText === committedTextRef.current)) return;
    commitEditText(nextText, nextText);
  };

  if (field.onPress && !field.onValue) {
    return (
      <Box
        width={width}
        height={1}
        flexDirection="row"
        backgroundColor={active ? colors.selected : colors.panel}
        data-gloom-field-id={field.id}
        onMouseDown={() => {
          onFocus();
          field.onPress?.();
        }}
      >
        <Text fg={active ? colors.selectedText : colors.textDim}>
          {truncateText(field.label, labelWidth).padEnd(labelWidth)}
        </Text>
        <Text fg={fg} attributes={active ? TextAttributes.BOLD : 0}>
          {truncateText(field.valueText ?? "", Math.max(1, width - labelWidth))}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      width={width}
      height={1}
      flexDirection="row"
      backgroundColor={active ? colors.selected : colors.panel}
      data-gloom-field-id={field.id}
      onMouseDown={() => {
        onFocus();
        focusInput();
      }}
    >
      <Text fg={active ? colors.selectedText : colors.textDim}>
        {truncateText(field.label, labelWidth).padEnd(labelWidth)}
      </Text>
      {active ? (
        <NumberField
          inputRef={inputNodeRef}
          focused={active}
          value={text}
          placeholder={displayValue}
          allowNegative={field.allowNegative}
          allowDecimal
          width={valueWidth}
          variant="plain"
          backgroundColor={colors.selected}
          textColor={fg}
          placeholderColor={colors.textMuted}
          onMouseDown={onFocus}
          onChange={(nextText) => {
            dirtyRef.current = true;
            latestTextRef.current = nextText;
            setText(nextText);
          }}
          onSubmit={handleSubmit}
          onBlur={handleBlur}
        />
      ) : (
        <Box
          width={valueWidth}
          height={1}
          backgroundColor={colors.bg}
          onMouseDown={() => {
            onFocus();
            focusInput();
          }}
        >
          <Text fg={fg}>{truncateText(displayValue, valueWidth)}</Text>
        </Box>
      )}
      {suffixWidth > 0 && (
        <Text fg={active ? colors.selectedText : colors.textDim}>
          {field.suffix ?? (field.percent ? "%" : "")}
        </Text>
      )}
    </Box>
  );
}

export function MetricLine({
  label,
  value,
  detail,
  color,
  width,
}: {
  label: string;
  value: string;
  detail?: string;
  color?: string;
  width: number;
}) {
  const labelWidth = Math.min(12, Math.max(8, Math.floor(width * 0.32)));
  const valueWidth = Math.min(Math.max(8, width - labelWidth), Math.max(8, Math.floor(width * 0.42)));
  const detailWidth = Math.max(0, width - labelWidth - valueWidth);
  return (
    <Box height={1} width={width} flexDirection="row" overflow="hidden">
      <Box width={labelWidth} flexShrink={0}>
        <Text fg={colors.textDim}>{label}</Text>
      </Box>
      <Box width={valueWidth} flexShrink={0}>
        <Text fg={color ?? colors.text} attributes={TextAttributes.BOLD}>
          {truncateText(value, valueWidth)}
        </Text>
      </Box>
      {detail && detailWidth > 0 && (
        <Text fg={colors.textDim}>{truncateText(detail, detailWidth)}</Text>
      )}
    </Box>
  );
}

export function SensitivityGridView({
  width,
  grid,
}: {
  width: number;
  grid: SensitivityGrid;
}) {
  const labelWidth = 9;
  const cellWidth = Math.max(8, Math.floor((width - labelWidth) / Math.max(1, grid.columns.length)));
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box height={1} flexDirection="row">
        <Box width={labelWidth}>
          <Text fg={colors.textDim}>{truncateText(grid.rowLabel, labelWidth)}</Text>
        </Box>
        {grid.columns.map((column) => (
          <Box key={column} width={cellWidth}>
            <Text fg={colors.textDim}>{truncateText(column, cellWidth - 1).padStart(cellWidth - 1)}</Text>
          </Box>
        ))}
      </Box>
      {grid.rows.map((row, rowIndex) => (
        <Box key={row} height={1} flexDirection="row">
          <Box width={labelWidth}>
            <Text fg={colors.textDim}>{truncateText(row, labelWidth)}</Text>
          </Box>
          {grid.cells[rowIndex]?.map((cell, cellIndex) => (
            <Box key={`${row}:${cellIndex}`} width={cellWidth}>
              <Text fg={colors.text}>{truncateText(cell.text, cellWidth - 1).padStart(cellWidth - 1)}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export function buildKellyCurveXAxisLabels(maxFraction: number): string[] {
  if (!Number.isFinite(maxFraction) || maxFraction <= 0) return [];
  return [0, 0.25, 0.5, 0.75, 1].map((ratio) => formatPct(maxFraction * ratio, 0));
}

export function KellyCurveDecisionView({
  width,
  currentFraction,
  targetFraction,
  fullKellyFraction,
  currentGrowth,
  targetGrowth,
  addTrimValue,
  currency,
  clipReasons,
}: {
  width: number;
  currentFraction: number;
  targetFraction: number;
  fullKellyFraction: number;
  currentGrowth: number;
  targetGrowth: number;
  addTrimValue: number;
  currency: string;
  clipReasons: string[];
}) {
  const moveLabel = addTrimValue >= 0 ? "add" : "trim";
  const capLabel = clipReasons.length > 0 ? `cap ${clipReasons.join(", ")}` : "cap none";
  const text = [
    `${formatPct(currentFraction, 1)} -> ${formatPct(targetFraction, 1)}`,
    `${moveLabel} ${formatCurrency(Math.abs(addTrimValue), currency)}`,
    `growth ${formatSignedPct(currentGrowth)} -> ${formatSignedPct(targetGrowth)}`,
    `full ${formatPct(fullKellyFraction, 0)}`,
    capLabel,
  ].join("  ");
  return (
    <Box height={1} paddingX={1}>
      <Text fg={colors.textDim}>{truncateText(text, Math.max(1, width - 2))}</Text>
    </Box>
  );
}
