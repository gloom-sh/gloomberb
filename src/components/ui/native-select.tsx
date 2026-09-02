/// <reference lib="dom" />

import { type CSSProperties } from "react";
import { Box } from "../../ui";
import { blendHex, colors } from "../../theme/colors";
import { WEB_CELL_HEIGHT } from "../../theme/font-scale";

export type NativeSelectElement = HTMLSelectElement & { showPicker?: () => void };

interface NativeSelectOption {
  label: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface NativeSelectProps {
  value: string;
  options: NativeSelectOption[];
  width?: number | string;
  height?: number;
  /**
   * `field` is the settings-dialog control. `inline` drops the box so a dense
   * pane row reads as text while staying a real, keyboard-accessible select.
   */
  variant?: "field" | "inline";
  includeUnsetOption?: boolean;
  selectRef?: (element: NativeSelectElement | null) => void;
  onFocus?: () => void;
  onChange: (value: string) => void;
}

export function openNativeSelect(element: NativeSelectElement | null | undefined) {
  if (!element) return;
  element.focus();
  try {
    if (element.showPicker) {
      element.showPicker();
    } else {
      element.click();
    }
  } catch {
    element.click();
  }
}

export function NativeSelect({
  value,
  options,
  width,
  height,
  variant = "field",
  includeUnsetOption = false,
  selectRef,
  onFocus,
  onChange,
}: NativeSelectProps) {
  const inline = variant === "inline";
  const hasCurrentValue = options.some((option) => option.value === value);
  const resolvedWidth = width ?? (inline ? "auto" : 184);
  const resolvedHeight = height ?? (inline ? WEB_CELL_HEIGHT : 28);
  const style: CSSProperties = {
    width: resolvedWidth,
    height: resolvedHeight,
    color: colors.text,
    backgroundColor: inline ? "transparent" : blendHex(colors.panel, colors.textBright, 0.06),
    border: inline ? "none" : `1px solid ${colors.border}`,
    borderRadius: inline ? 0 : 6,
    padding: inline ? 0 : "0 8px",
    boxShadow: inline ? "none" : `inset 0 1px 0 ${blendHex(colors.bg, colors.textBright, 0.05)}`,
    cursor: "pointer",
    font: "inherit",
    letterSpacing: 0,
    outline: "none",
    appearance: "auto",
    WebkitAppearance: "menulist",
  };

  return (
    <Box
      height={`${resolvedHeight}px`}
      flexDirection="row"
      alignItems="center"
      onMouseDown={(event: any) => {
        event.stopPropagation?.();
      }}
      onMouseUp={(event: any) => {
        event.stopPropagation?.();
      }}
    >
      <select
        ref={selectRef}
        value={value}
        data-gloom-interactive="true"
        onFocus={onFocus}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (
            event.key === "ArrowUp"
            || event.key === "ArrowDown"
            || event.key === "ArrowLeft"
            || event.key === "ArrowRight"
            || event.key === "Enter"
            || event.key === " "
            || event.key === "Home"
            || event.key === "End"
            || event.key === "PageUp"
            || event.key === "PageDown"
          ) {
            event.stopPropagation();
          }
        }}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        style={style}
      >
        {includeUnsetOption && !hasCurrentValue && <option value="">Unset</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </Box>
  );
}
