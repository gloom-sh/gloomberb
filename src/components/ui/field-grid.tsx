import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, Text, useUiCapabilities, type InputRenderable } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { formatNumber } from "../../utils/format";
import { isPlainKey } from "../../utils/keyboard";
import { useShortcut } from "../../react/input";
import { Button } from "./button";
import { NumberField, TextField } from "./fields";

/**
 * One cell of a FieldGrid: an input a calculator or sizer reads its answer
 * from. Numbers edit `value` (a fraction when `percent`); text edits
 * `valueText` live; a field with only `onPress` is an action cell.
 */
export interface GridField {
  id: string;
  label: string;
  kind?: "number" | "text";
  value?: number;
  /** Number fields: display override. Text fields: the edited value. */
  valueText?: string;
  placeholder?: string;
  percent?: boolean;
  suffix?: string;
  allowNegative?: boolean;
  /** Takes the whole row, e.g. a schedule or list typed as text. */
  wide?: boolean;
  onValue?: (value: number) => void;
  onText?: (value: string) => void;
  onClear?: () => void;
  onPress?: () => void;
  tone?: "neutral" | "positive" | "negative";
}

export interface FieldGridProps {
  fields: GridField[];
  /** The field being edited. */
  activeId: string | null;
  onActivate: (id: string) => void;
  /** Leaves editing, e.g. after Enter in a text field. */
  onDeactivate?: () => void;
  width: number;
  focused: boolean;
  /** Fixed column count; by default 3 at 78 cells, 2 at 42, else 1. */
  columns?: number;
  /** Cells per field, capped so a value sits near its label in a wide pane. */
  maxFieldWidth?: number;
}

export function fieldGridColumns(width: number): number {
  return width >= 78 ? 3 : width >= 42 ? 2 : 1;
}

/** Rows a FieldGrid takes, so panes can size what sits below it. */
export function fieldGridRows(fields: GridField[], columns: number): number {
  let rows = 0;
  let used = columns;
  for (const field of fields) {
    if (field.wide) {
      rows += 1;
      used = columns;
      continue;
    }
    if (used >= columns) {
      rows += 1;
      used = 0;
    }
    used += 1;
  }
  return rows;
}

function layoutRows(fields: GridField[], columns: number): GridField[][] {
  const rows: GridField[][] = [];
  for (const field of fields) {
    const last = rows[rows.length - 1];
    if (field.wide) {
      rows.push([field]);
    } else if (!last || last.length >= columns || last[0]?.wide) {
      rows.push([field]);
    } else {
      last.push(field);
    }
  }
  return rows;
}

/**
 * The inputs of a calculator, sizer or form-like pane as one aligned sheet:
 * label, value and unit per cell. The terminal draws cells as text on the pane
 * background; the desktop draws a band of hairline-split cells that matches
 * the query bar above it. Tab order and which field is active stay with the
 * pane.
 */
export function FieldGrid({
  fields,
  activeId,
  onActivate,
  onDeactivate,
  width,
  focused,
  columns: columnsProp,
  maxFieldWidth = 26,
}: FieldGridProps) {
  const { nativePaneChrome } = useUiCapabilities();
  const columns = Math.max(1, columnsProp ?? fieldGridColumns(width));
  const fieldWidth = Math.max(12, Math.min(maxFieldWidth, Math.floor((width - 2) / columns)));
  const rows = layoutRows(fields, columns);
  // Desktop: every label column is as wide as the longest label, so values line
  // up down each column.
  const labelChars = Math.min(14, Math.max(4, ...fields.map((field) => field.label.length)));
  return (
    <Box
      flexDirection="column"
      paddingX={nativePaneChrome ? 0 : 1}
      height={rows.length}
      flexShrink={0}
      data-gloom-role="field-grid"
      style={nativePaneChrome ? { "--field-label-w": `${labelChars}ch`, "--field-columns": String(columns) } : undefined}
    >
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex} height={1} flexDirection="row" data-gloom-role="field-grid-row">
          {row.map((field) => (
            <GridFieldView
              key={field.id}
              labelWidth={Math.min(labelChars + 1, Math.max(7, Math.floor(fieldWidth * 0.5)))}
              field={field}
              active={activeId === field.id}
              focused={focused}
              width={field.wide ? Math.max(fieldWidth, width - 2) : fieldWidth}
              onFocus={() => onActivate(field.id)}
              onDone={onDeactivate}
            />
          ))}
        </Box>
      ))}
    </Box>
  );
}

function parseNumber(value: string): number | null {
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

function truncate(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (value.length <= maxWidth) return value;
  if (maxWidth <= 1) return value.slice(0, maxWidth);
  return `${value.slice(0, maxWidth - 1)}…`;
}

/** One cell. Exported for panes that place a single field outside a grid row. */
export function GridFieldView({
  field,
  active,
  width,
  focused,
  onFocus,
  onDone,
  labelWidth: labelWidthProp,
}: {
  field: GridField;
  active: boolean;
  width: number;
  focused: boolean;
  onFocus: () => void;
  onDone?: () => void;
  /** Terminal label column; a grid passes one width so values line up. */
  labelWidth?: number;
}) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const text = field.kind === "text";
  const labelWidth = labelWidthProp ?? Math.min(12, Math.max(7, Math.floor(width * 0.38)));
  const suffixText = field.suffix ?? (field.percent ? "%" : "");
  const suffixWidth = suffixText ? suffixText.length + 1 : 0;
  // Capped so the unit sits next to the number instead of being pushed to the
  // far edge of a wide pane. Text fields take the rest of their cell.
  const valueWidth = text
    ? Math.max(5, width - labelWidth - suffixWidth - 1)
    : Math.max(5, Math.min(12, width - labelWidth - suffixWidth - 2));
  const inputNodeRef = useRef<InputRenderable | null>(null);
  const displayValue = text
    ? field.valueText ?? ""
    : field.valueText ?? formatInputNumber(field.value ?? 0, field.percent);
  const fieldRef = useRef(field);
  const displayValueRef = useRef(displayValue);
  const [draft, setDraft] = useState(displayValue);
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
      if (!text) input?.setCursorOffset?.(0);
    } catch {
      // Renderer teardown can race queued focus attempts.
    }
  }, [text]);
  const toneColor = field.tone === "positive"
    ? colors.positive
    : field.tone === "negative"
      ? colors.negative
      : colors.text;
  const fg = active && !nativePaneChrome ? colors.selectedText : toneColor;

  const commitText = useCallback((nextText: string): string | null => {
    const currentField = fieldRef.current;
    if (nextText.trim() === "") {
      currentField.onClear?.();
      return null;
    }
    const parsed = parseNumber(nextText);
    if (parsed == null) return null;
    currentField.onValue?.(currentField.percent ? parsed / 100 : parsed);
    // Keep the submitted number visible while editing. Display rounding must
    // not make the active input disagree with the value used by the model.
    return String(parsed);
  }, []);

  const commitEditText = useCallback((nextText: string, fallbackText = displayValue) => {
    latestTextRef.current = nextText;
    const committedText = commitText(nextText);
    committedTextRef.current = committedText ?? fallbackText;
    setDraft(committedTextRef.current);
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
    if (text) return;
    const liveText = getLiveInputText();
    const nextText = typeof liveText === "string" ? liveText : latestTextRef.current;
    if (!dirtyRef.current && (nextText.trim() === "" || nextText === committedTextRef.current)) return;
    latestTextRef.current = nextText;
    const committedText = commitText(nextText);
    committedTextRef.current = committedText ?? displayValueRef.current;
    dirtyRef.current = false;
  }, [commitText, getLiveInputText, text]);

  useLayoutEffect(() => {
    if (text) {
      setDraft(displayValue);
      return;
    }
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (!wasActive && active) {
      dirtyRef.current = false;
      latestTextRef.current = "";
      committedTextRef.current = displayValue;
      setDraft("");
      return;
    }
    if (wasActive && !active) {
      const nextText = dirtyRef.current ? latestTextRef.current : draft;
      if (dirtyRef.current) {
        commitEditText(nextText);
      } else {
        committedTextRef.current = displayValue;
        setDraft(displayValue);
      }
      return;
    }
    if (!active) {
      latestTextRef.current = displayValue;
      committedTextRef.current = displayValue;
      setDraft(displayValue);
    }
  }, [active, commitEditText, displayValue, draft, text]);

  // Only the focused pane's field takes the keyboard. The input follows
  // `focused` itself when the pane comes back, keeping its caret.
  const paneFocusedRef = useRef(focused);
  paneFocusedRef.current = focused;
  useEffect(() => {
    if (!active || !paneFocusedRef.current) return;
    let animationFrame: number | null = null;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const focusWhilePaneFocused = () => {
      if (paneFocusedRef.current) focusInput();
    };
    focusInput();
    queueMicrotask(focusWhilePaneFocused);
    animationFrame = globalThis.requestAnimationFrame?.(focusWhilePaneFocused) ?? null;
    timeouts.push(setTimeout(focusWhilePaneFocused, 0), setTimeout(focusWhilePaneFocused, 32));
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

  // An action cell the pane has made active presses on Enter or Space, as it
  // would on a click.
  const actionCell = !!field.onPress && !field.onValue && !field.onText;
  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped || event.targetEditable) return;
    if (!isPlainKey(event, "return", "enter", "space")) return;
    event.preventDefault();
    event.stopPropagation();
    fieldRef.current.onPress?.();
  }, { enabled: actionCell && active && focused });

  const labelNode = (
    <Text fg={active && !nativePaneChrome ? colors.selectedText : colors.textDim} data-gloom-role="field-grid-label">
      {nativePaneChrome ? field.label : truncate(field.label, labelWidth - 1).padEnd(labelWidth)}
    </Text>
  );
  const cellProps = {
    width,
    height: 1,
    flexDirection: "row" as const,
    "data-gloom-role": "field-grid-cell",
    "data-active": active ? "true" : undefined,
    "data-wide": field.wide ? "true" : undefined,
    "data-gloom-field-id": field.id,
  };

  if (actionCell) {
    return (
      <Box {...cellProps} data-kind="action">
        <Button
          label={field.label}
          displayLabel={nativePaneChrome
            ? `${field.label}  ${field.valueText ?? ""}`
            : `${truncate(field.label, labelWidth).padEnd(labelWidth)}${truncate(field.valueText ?? "", Math.max(1, width - labelWidth))}`}
          width={width}
          variant={nativePaneChrome ? "plain" : undefined}
          active={active}
          compact
          flush={nativePaneChrome}
          onPress={() => {
            onFocus();
            field.onPress?.();
          }}
        />
      </Box>
    );
  }

  const input = text ? (
    <TextField
      inputRef={inputNodeRef}
      focused={active && focused}
      value={draft}
      placeholder={field.placeholder}
      width={valueWidth}
      variant="plain"
      backgroundColor={nativePaneChrome ? "transparent" : colors.selected}
      textColor={fg}
      placeholderColor={colors.textMuted}
      onMouseDown={onFocus}
      onChange={(next) => {
        setDraft(next);
        field.onText?.(next);
      }}
      onSubmit={() => onDone?.()}
    />
  ) : (
    <NumberField
      inputRef={inputNodeRef}
      focused={active && focused}
      value={draft}
      placeholder={displayValue}
      allowNegative={field.allowNegative}
      allowDecimal
      width={valueWidth}
      variant="plain"
      backgroundColor={nativePaneChrome ? "transparent" : colors.selected}
      textColor={fg}
      placeholderColor={colors.textMuted}
      onMouseDown={onFocus}
      onChange={(nextText) => {
        dirtyRef.current = true;
        latestTextRef.current = nextText;
        setDraft(nextText);
      }}
      onSubmit={(nextText) => commitEditText(nextText, nextText)}
      onBlur={(nextText) => {
        if (!dirtyRef.current && (nextText.trim() === "" || nextText === committedTextRef.current)) return;
        commitEditText(nextText, nextText);
      }}
    />
  );

  return (
    <Box
      {...cellProps}
      data-kind={text ? "text" : "number"}
      backgroundColor={nativePaneChrome ? undefined : active ? colors.selected : colors.panel}
      onMouseDown={() => {
        onFocus();
        focusInput();
      }}
    >
      {labelNode}
      <Box width={valueWidth} data-gloom-role="field-grid-value" flexDirection="row">
        {active || text ? input : (
          <Button
            label={`Edit ${field.label}`}
            displayLabel={truncate(displayValue, valueWidth)}
            width={valueWidth}
            variant="plain"
            compact
            flush={nativePaneChrome}
            onPress={() => {
              onFocus();
              focusInput();
            }}
          />
        )}
      </Box>
      {suffixWidth > 0 && (
        <Text fg={active && !nativePaneChrome ? colors.selectedText : colors.textDim} data-gloom-role="field-grid-unit">
          {suffixText}
        </Text>
      )}
    </Box>
  );
}
