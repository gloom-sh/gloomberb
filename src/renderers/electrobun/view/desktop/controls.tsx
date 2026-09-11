/** @jsxImportSource react */
import { useRef, type KeyboardEvent, type RefObject } from "react";
import { Box, Input, Text, Textarea, editableTextContextMenuItems, useRendererHost, useUiCapabilities } from "../../../../ui";
import { TextAttributes, type InputRenderable } from "../../../../ui";
import { useShortcut } from "../../../../react/input";
import { blendHex, type ThemeColors } from "../../../../theme/colors";
import { contrastRatio } from "../../../../theme/color-utils";
import { useThemeColors } from "../../../../theme/theme-context";
import { isDetailBackNavigationKey } from "../../../../utils/back-navigation";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../../theme/font-scale";
import type { ButtonProps } from "../../../../components/ui/button";
import type { CheckboxProps } from "../../../../components/ui/checkbox";
import type { TextFieldProps } from "../../../../components/ui/fields";
import type { DialogFrameProps } from "../../../../components/ui/frame";
import type { MessageComposerProps } from "../../../../components/ui/message-composer";
import type { PageStackViewProps } from "../../../../components/ui/page-stack-view";
import type { SegmentedControlProps } from "../../../../components/ui/toggle";
import {
  CONTROL_RADIUS,
  buttonPalette,
  controlBorderColor,
  controlShadow,
  panelBorder,
  panelFill,
} from "./control-styles";

export { WebListView } from "./list-view";

export function WebButton({
  label,
  displayLabel,
  children,
  expanded,
  onPress,
  variant = "secondary",
  disabled = false,
  active = false,
  shortcut,
  width,
  height,
  compact = false,
  stopPropagation = false,
}: ButtonProps) {
  const colors = useThemeColors();
  const palette = buttonPalette({ variant, active, disabled }, colors);

  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      disabled={disabled}
      onMouseDown={(event) => {
        if (stopPropagation) event.stopPropagation();
      }}
      onMouseUp={(event) => {
        if (stopPropagation) event.stopPropagation();
      }}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation();
        if (!disabled) onPress?.();
      }}
      onKeyDown={(event) => {
        if (disabled || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) onPress?.();
      }}
      data-gloom-role="desktop-button"
      data-gloom-interactive={disabled ? undefined : "true"}
      style={{
        display: "inline-flex",
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        width: width === undefined ? undefined : width * WEB_CELL_WIDTH,
        height: typeof height === "string" ? height : (height ?? 1) * WEB_CELL_HEIGHT,
        minWidth: 0,
        boxSizing: "border-box",
        backgroundColor: palette.bg,
        color: palette.fg,
        font: "inherit",
        fontWeight: active || variant === "primary" ? 700 : 600,
        border: `1px solid ${palette.border}`,
        borderRadius: CONTROL_RADIUS,
        padding: compact ? "0 2px" : "0 8px",
        boxShadow: controlShadow(active, colors),
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children ?? displayLabel ?? label}
      {shortcut && (
        <span
          style={{ color: disabled ? colors.textMuted : colors.textDim, marginLeft: 8, fontSize: "0.92em" }}
        >
          {shortcut}
        </span>
      )}
    </button>
  );
}

function checkboxAccentColor(colors: ThemeColors): string {
  const base = colors.borderFocused;
  const nativeCheckmark = "#ffffff";
  const candidates = [
    blendHex(base, colors.selected, 0.55),
    blendHex(base, colors.selected, 0.65),
    blendHex(base, "#000000", 0.45),
    blendHex(base, "#000000", 0.52),
    base,
  ];
  return candidates.find((candidate) => (
    contrastRatio(candidate, nativeCheckmark) >= 4.5
    && contrastRatio(candidate, colors.panel) >= 2.2
  )) ?? candidates[1]!;
}

function checkboxCheckImage(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><path d="M3 7.3 5.8 10 11.2 3.7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function WebCheckbox({
  label,
  displayLabel,
  checked,
  onChange,
  disabled = false,
  active = false,
  description,
  width,
}: CheckboxProps) {
  const colors = useThemeColors();
  const textColor = disabled
    ? colors.textMuted
    : active
    ? colors.textBright
    : colors.text;
  const visibleLabel = displayLabel ?? label;
  const accentColor = checkboxAccentColor(colors);
  const borderColor = checked ? accentColor : controlBorderColor(active, false, colors);
  return (
    <Box
      flexDirection="column"
      width={width}
      data-gloom-role="desktop-checkbox"
      data-gloom-interactive={disabled ? undefined : "true"}
      style={{ opacity: disabled ? 0.55 : 1 }}
    >
      <label
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          minWidth: 0,
          cursor: disabled ? "default" : "pointer",
          color: textColor,
          fontWeight: active ? 700 : 500,
          lineHeight: "20px",
          userSelect: "none",
          position: "relative",
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => {
            if (!disabled) onChange?.(event.currentTarget.checked);
          }}
          onKeyDown={(event) => {
            // Space activates the native input. Keep it out of pane shortcuts
            // without cancelling the browser's checked-state transition.
            if (event.key === " ") event.stopPropagation();
          }}
          style={{
            appearance: "none",
            WebkitAppearance: "none",
            width: 14,
            height: 14,
            margin: 0,
            backgroundColor: checked ? accentColor : panelFill(colors),
            backgroundImage: checked ? checkboxCheckImage() : undefined,
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            backgroundSize: "12px 12px",
            border: `1px solid ${borderColor}`,
            borderRadius: 4,
            boxShadow: active
              ? `0 0 0 2px ${blendHex(colors.bg, colors.borderFocused, 0.28)}, inset 0 1px 0 rgba(255,255,255,0.16)`
              : "inset 0 1px 0 rgba(255,255,255,0.10)",
            boxSizing: "border-box",
            flexShrink: 0,
            cursor: disabled ? "default" : "pointer",
            verticalAlign: "middle",
          }}
        />
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {visibleLabel}
        </span>
      </label>
      {description ? (
        <Text
          fg={colors.textMuted}
          wrapText
          width={width}
          style={{ paddingLeft: 22, lineHeight: "18px" }}
        >
          {description}
        </Text>
      ) : null}
    </Box>
  );
}

export function WebTextField({
  label,
  value,
  placeholder,
  focused,
  width,
  inputRef,
  onChange,
  onSubmit,
  onBlur,
  hint,
  type = "text",
  autoComplete,
  variant = "default",
  backgroundColor,
  textColor,
  placeholderColor,
  onMouseDown,
  onKeyDown,
}: TextFieldProps) {
  const colors = useThemeColors();
  const resolvedBackgroundColor = backgroundColor ?? colors.bg;
  const resolvedTextColor = textColor ?? colors.text;
  const resolvedPlaceholderColor = placeholderColor ?? colors.textDim;
  const localInputRef = useRef<InputRenderable>(null);
  const resolvedInputRef = inputRef ?? localInputRef;
  const renderer = useRendererHost();
  const { nativeContextMenu } = useUiCapabilities();
  const plain = variant === "plain";

  return (
    <Box flexDirection="column" gap={plain ? 0 : 1}>
      {label && (
        <Box height={1}>
          <Text
            fg={focused ? colors.textBright : resolvedPlaceholderColor}
            style={{ fontWeight: 600 }}
          >
            {label}
          </Text>
        </Box>
      )}
      <Box
        height={1}
        width={width}
        alignItems="center"
        backgroundColor={plain ? "transparent" : resolvedBackgroundColor}
        onMouseDown={() => {
          onMouseDown?.();
          resolvedInputRef.current?.focus?.();
        }}
        onContextMenu={(event: any) => {
          if (!nativeContextMenu || !renderer.showContextMenu) return;
          event.preventDefault?.();
          event.stopPropagation?.();
          resolvedInputRef.current?.focus?.();
          void renderer.showContextMenu(editableTextContextMenuItems());
        }}
        data-gloom-role="desktop-text-field"
        style={{
          border: plain ? "none" : `1px solid ${controlBorderColor(focused, false, colors)}`,
          borderRadius: plain ? 0 : CONTROL_RADIUS,
          boxShadow: plain ? undefined : controlShadow(focused, colors),
          overflow: "hidden",
        }}
      >
        <Input
          ref={resolvedInputRef as RefObject<InputRenderable | null>}
          width="100%"
          value={value}
          type={type}
          autoComplete={autoComplete}
          placeholder={placeholder}
          focused={focused}
          textColor={resolvedTextColor}
          focusedTextColor={resolvedTextColor}
          placeholderColor={resolvedPlaceholderColor}
          backgroundColor={plain ? "transparent" : resolvedBackgroundColor}
          focusedBackgroundColor={plain ? "transparent" : resolvedBackgroundColor}
          cursorColor={colors.textBright}
          style={{
            paddingLeft: plain ? 0 : 10,
            paddingRight: plain ? 0 : 10,
            borderRadius: plain ? 0 : CONTROL_RADIUS,
          }}
          onInput={onChange}
          onKeyDown={onKeyDown}
          onChange={onChange}
          onSubmit={(nextValue?: string) => onSubmit?.(
            typeof nextValue === "string" ? nextValue : resolvedInputRef.current?.editBuffer.getText() ?? value ?? "",
          )}
          onBlur={(nextValue?: string) => onBlur?.(
            typeof nextValue === "string" ? nextValue : resolvedInputRef.current?.editBuffer.getText() ?? value ?? "",
          )}
        />
      </Box>
      {hint && (
        <Box height={1}>
          <Text fg={colors.textMuted} style={{ fontSize: "0.94em" }}>
            {hint}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function WebMessageComposer({
  inputRef,
  initialValue = "",
  focused = false,
  placeholder = "",
  width,
  height = 2,
  onFocusRequest,
  onInput,
  onCursorChange,
  onSubmit,
  keyBindings,
  wrapText = false,
}: MessageComposerProps) {
  const colors = useThemeColors();
  const borderColor = focused
    ? blendHex(colors.borderFocused, colors.textBright, 0.24)
    : colors.border;
  const requestFocus = () => {
    onFocusRequest?.();
    inputRef?.current?.focus?.();
  };
  const handleInput = (value: string) => {
    if (!focused) onFocusRequest?.();
    onInput?.(value);
  };

  return (
    <Box
      flexDirection="row"
      width={width}
      height={height}
      backgroundColor={panelFill(colors)}
      onMouseDown={requestFocus}
      data-gloom-role="desktop-message-composer"
      style={{
        borderTop: `1px solid ${borderColor}`,
        overflow: "hidden",
      }}
    >
      <Textarea
        ref={inputRef}
        initialValue={initialValue}
        width="100%"
        height={height}
        focused={focused}
        placeholder={placeholder}
        placeholderColor={colors.textMuted}
        textColor={colors.text}
        backgroundColor="transparent"
        focusedBackgroundColor="transparent"
        cursorColor={colors.textBright}
        style={{
          padding: "6px 12px",
          lineHeight: "20px",
          fontSize: "13px",
        }}
        onMouseDown={requestFocus}
        onFocus={requestFocus}
        onInput={handleInput}
        onCursorChange={onCursorChange}
        keyBindings={keyBindings}
        onSubmit={onSubmit}
        wrapText={wrapText}
      />
    </Box>
  );
}

export function WebSegmentedControl({
  options,
  value,
  onChange,
  focused,
  width,
  wrap = false,
}: SegmentedControlProps) {
  const colors = useThemeColors();
  const enabled = options.filter((option) => !option.disabled);
  const selectAdjacent = (direction: -1 | 1) => {
    const index = enabled.findIndex((option) => option.value === value);
    const next = enabled[index < 0 ? 0 : (index + direction + enabled.length) % enabled.length];
    if (next) onChange?.(next.value);
  };

  // Callers place the control on a single grid row, so its border and padding
  // have to live inside one cell: sized any taller it bled over the pane title
  // and the table header below it.
  return (
    <Box
      flexDirection="row"
      flexWrap={wrap ? "wrap" : "nowrap"}
      width={width}
      height={wrap ? undefined : 1}
      alignItems="center"
      backgroundColor={panelFill(colors)}
      role="radiogroup"
      style={{
        border: `1px solid ${focused ? colors.borderFocused : panelBorder(colors)}`,
        borderRadius: CONTROL_RADIUS,
        padding: 1,
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Box
            key={option.value}
            flexDirection="row"
            alignItems="center"
            justifyContent="center"
            backgroundColor={active ? colors.selected : "transparent"}
            onMouseDown={() => {
              if (!option.disabled) onChange?.(option.value);
            }}
            data-gloom-interactive={option.disabled ? undefined : "true"}
            role="radio"
            aria-checked={active}
            aria-disabled={option.disabled || undefined}
            tabIndex={option.disabled ? -1 : 0}
            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
              if (option.disabled) return;
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                event.stopPropagation();
                selectAdjacent(event.key === "ArrowLeft" ? -1 : 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onChange?.(option.value);
              }
            }}
            style={{
              alignSelf: wrap ? undefined : "stretch",
              borderRadius: CONTROL_RADIUS - 2,
              paddingInline: 8,
              cursor: option.disabled ? "default" : "pointer",
            }}
          >
            <Text
              fg={option.disabled ? colors.textMuted : active ? colors.selectedText : colors.textDim}
              attributes={active ? TextAttributes.BOLD : 0}
              style={{ lineHeight: "normal" }}
            >
              {option.label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function WebDialogFrame({
  title,
  children,
  footer,
  showTitleDivider = false,
}: DialogFrameProps) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="column" style={{ padding: 14 }}>
      <Box
        height={1}
        flexDirection="row"
        alignItems="center"
        style={{
          borderBottom: showTitleDivider ? `1px solid ${panelBorder(colors)}` : "none",
          paddingBottom: showTitleDivider ? 8 : 0,
          marginBottom: showTitleDivider ? 10 : 14,
        }}
      >
        <Text fg={colors.text} attributes={TextAttributes.BOLD} style={{ fontWeight: 700 }}>
          {title}
        </Text>
      </Box>
      {children}
      {footer && (
        <Box
          height={1}
          style={{
            borderTop: `1px solid ${panelBorder(colors)}`,
            paddingTop: 8,
            marginTop: 10,
          }}
        >
          <Text fg={colors.textMuted}>
            {footer}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function WebPageStackView({
  focused,
  detailOpen,
  onBack,
  rootContent,
  detailContent,
  detailTitle,
  backLabel = "Back",
  backHint,
}: PageStackViewProps) {
  const colors = useThemeColors();
  useShortcut((event) => {
    if (!focused || !detailOpen || !isDetailBackNavigationKey(event)) return;
    event.stopPropagation?.();
    event.preventDefault?.();
    onBack();
  });

  if (!detailOpen) {
    return (
      <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} minHeight={0} overflow="hidden">
        {rootContent}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} minHeight={0} overflow="hidden">
      <Box
        flexDirection="row"
        alignItems="flex-start"
        paddingX={1}
        gap={1}
        flexShrink={0}
        style={{
          paddingBlock: 8,
        }}
      >
        <Box
          height={1}
          flexDirection="row"
          alignItems="center"
          backgroundColor={panelFill(colors)}
          onMouseDown={(event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
            event.preventDefault?.();
            event.stopPropagation?.();
            onBack();
          }}
          data-gloom-interactive="true"
          style={{
            border: `1px solid ${panelBorder(colors)}`,
            borderRadius: CONTROL_RADIUS,
            paddingInline: 8,
            cursor: "pointer",
          }}
        >
          <Text fg={colors.textBright} style={{ fontWeight: 600 }}>
            {`← ${backLabel}`}
          </Text>
        </Box>
        {detailTitle ? (
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Text
              fg={colors.textBright}
              attributes={TextAttributes.BOLD}
              wrapText
              style={{
                display: "block",
                fontWeight: 700,
                overflow: "visible",
                overflowWrap: "break-word",
                whiteSpace: "normal",
              }}
            >
              {detailTitle}
            </Text>
          </Box>
        ) : (
          <Box flexGrow={1} />
        )}
        {backHint ? (
          <Text fg={colors.textMuted}>
            {backHint}
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} minHeight={0} overflow="hidden">
        {detailContent}
      </Box>
    </Box>
  );
}
