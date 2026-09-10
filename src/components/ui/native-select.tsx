/// <reference lib="dom" />

import { useThemeColors, useThemeTokens } from "../../theme/theme-context";

import { type CSSProperties } from "react";

import { WEB_CELL_HEIGHT } from "../../theme/font-scale";
import { Box } from "../../ui";

export type NativeSelectElement = HTMLSelectElement & { showPicker?: () => void };

interface NativeSelectOption {
  label: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface NativeSelectProps {
  label?: string;
  value: string;
  disabled?: boolean;
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
  if (!element || element.disabled) return;
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
  label,
  value,
  options,
  width,
  height,
  variant = "field",
  includeUnsetOption = false,
  disabled = false,
  selectRef,
  onFocus,
  onChange,
}: NativeSelectProps) {
  const colors = useThemeColors();
  const tokens = useThemeTokens();
  const inline = variant === "inline";
  const hasCurrentValue = options.some((option) => option.value === value);
  const resolvedWidth = width ?? (inline ? "auto" : 184);
  const resolvedHeight = height ?? (inline ? WEB_CELL_HEIGHT : 28);
  const style: CSSProperties = {
    width: resolvedWidth,
    height: resolvedHeight,
    color: disabled ? colors.textMuted : colors.text,
    backgroundColor: inline ? "transparent" : tokens.surface.raised,
    border: inline ? "none" : `1px solid ${colors.border}`,
    borderRadius: inline ? 0 : 6,
    padding: inline ? 0 : "0 8px",
    boxShadow: inline ? "none" : "var(--gloom-shadow-popover, none)",
    cursor: disabled ? "default" : "pointer",
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
        aria-label={label}
        ref={selectRef}
        value={value}
        disabled={disabled}
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
