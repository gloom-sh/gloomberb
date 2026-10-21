/** @jsxImportSource react */
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { Box, Input, Text, Textarea, editableTextContextMenuItems, useRendererHost, useUiCapabilities } from "../../../ui";
import { TextAttributes, type InputRenderable } from "../../../ui";
import { useShortcut } from "../../../react/input";
import { blendHex, type ThemeColors } from "../../../theme/colors";
import { contrastRatio } from "../../../theme/color-utils";
import { useThemeColors } from "../../../theme/theme-context";
import { isDetailBackNavigationKey } from "../../../utils/back-navigation";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../theme/font-scale";
import type { ButtonProps } from "../../../components/ui/button";
import type { CheckboxProps } from "../../../components/ui/checkbox";
import type { TextFieldProps } from "../../../components/ui/fields";
import type { DialogFrameProps } from "../../../components/ui/frame";
import type { MessageComposerProps } from "../../../components/ui/message-composer";
import type { PageStackViewProps } from "../../../components/ui/page-stack-view";
import { STACK_DETAIL_ROLE, StackHeaderContext, type StackHeaderSlot } from "./stack-header";
import { releasePointerFocus } from "../host/focus-scope";
import { selectionStyle } from "../host/style";
import { WebIcon, WebIconButton } from "./icons";
import { WebKeyHints, WebKeycap, ariaKeyShortcut } from "./dialog-actions";
import { NestedPaneTabs } from "../../../components/layout/pane/header-tabs";
import type { SegmentedControlProps } from "../../../components/ui/toggle";
import {
  CONTROL_RADIUS,
  buttonPalette,
  controlBorderColor,
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
  tone,
  disabled = false,
  pending = false,
  active = false,
  shortcut,
  width,
  height,
  compact = false,
  flush = false,
  stopPropagation = false,
  title,
}: ButtonProps) {
  const colors = useThemeColors();
  const palette = buttonPalette({ variant, active, disabled, tone }, colors);
  const filled = active || variant === "primary" || variant === "danger";

  return (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts={ariaKeyShortcut(shortcut)}
      title={title}
      aria-expanded={expanded}
      aria-busy={pending || undefined}
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
        releasePointerFocus(event.currentTarget, event.detail);
      }}
      onKeyDown={(event) => {
        if (disabled || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) onPress?.();
      }}
      data-gloom-role="desktop-button"
      data-gloom-variant={variant}
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
        // A clear button leaves its fill to styles.css, so the pointer can give it the hover fill.
        backgroundColor: palette.bg === "transparent" ? undefined : palette.bg,
        color: palette.fg,
        font: "inherit",
        fontWeight: filled ? "var(--gloom-weight-bold)" : "var(--gloom-weight-regular)",
        border: flush ? "none" : `1px solid ${palette.border}`,
        borderRadius: "var(--gloom-radius-md)",
        padding: flush ? 0 : compact ? "0 var(--gloom-space-xs)" : "0 var(--gloom-space-sm)",
        cursor: disabled ? "default" : "pointer",
      } as CSSProperties}
    >
      {children ?? displayLabel ?? label}
      {shortcut && (
        <WebKeycap
          keyName={shortcut}
          style={{ marginLeft: "var(--gloom-space-sm)", marginRight: flush || compact ? 0 : "calc(-1 * var(--gloom-space-xs))" }}
        />
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

/**
 * The one checkbox square on the desktop: the kit Checkbox, query-bar toggles
 * and multi-select menu items all draw it through this style.
 */
function checkboxBoxStyle(
  colors: ThemeColors,
  { checked, active = false, size = 14 }: { checked: boolean; active?: boolean; size?: number },
): CSSProperties {
  const accentColor = checkboxAccentColor(colors);
  return {
    appearance: "none",
    WebkitAppearance: "none",
    display: "inline-block",
    width: size,
    height: size,
    margin: 0,
    backgroundColor: checked ? accentColor : "var(--gloom-surface-sunken)",
    backgroundImage: checked ? checkboxCheckImage() : undefined,
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    backgroundSize: `${size - 2}px ${size - 2}px`,
    border: `1px solid ${checked ? accentColor : controlBorderColor(active, false, colors)}`,
    borderRadius: "var(--gloom-radius-sm)",
    boxSizing: "border-box",
    flexShrink: 0,
    verticalAlign: "middle",
  };
}

/** A checkbox square for a control that owns its own click (a menu row, a bar toggle). */
export function CheckboxBox({ checked, size = 12 }: { checked: boolean; size?: number }) {
  const colors = useThemeColors();
  return <span aria-hidden="true" data-gloom-role="checkbox-box" style={checkboxBoxStyle(colors, { checked, size })} />;
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
          gap: "var(--gloom-space-sm)",
          width: "100%",
          minWidth: 0,
          cursor: disabled ? "default" : "pointer",
          color: textColor,
          fontWeight: active ? "var(--gloom-weight-bold)" : "var(--gloom-weight-regular)",
          lineHeight: "20px",
          ...selectionStyle(false),
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
          onClick={(event) => releasePointerFocus(event.currentTarget, event.detail)}
          onKeyDown={(event) => {
            // Space activates the native input. Keep it out of pane shortcuts
            // without cancelling the browser's checked-state transition.
            if (event.key === " ") event.stopPropagation();
          }}
          style={{
            ...checkboxBoxStyle(colors, { checked, active }),
            cursor: disabled ? "default" : "pointer",
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

/** Outer height of a `size="comfortable"` field, border included. */
const COMFORTABLE_FIELD_HEIGHT = 26;

export function WebTextField({
  label,
  accessibleLabel,
  value,
  placeholder,
  maxLength,
  focused,
  disabled = false,
  width,
  inputRef,
  onChange,
  onSubmit,
  onBlur,
  hint,
  type = "text",
  autoComplete,
  variant = "default",
  size = "default",
  backgroundColor,
  textColor,
  placeholderColor,
  onMouseDown,
  onKeyDown,
}: TextFieldProps) {
  const colors = useThemeColors();
  const resolvedBackgroundColor = backgroundColor ?? "var(--gloom-surface-sunken)";
  const resolvedTextColor = textColor ?? colors.text;
  const resolvedPlaceholderColor = placeholderColor ?? colors.textDim;
  const localInputRef = useRef<InputRenderable>(null);
  const resolvedInputRef = inputRef ?? localInputRef;
  const renderer = useRendererHost();
  const { nativeContextMenu } = useUiCapabilities();
  const plain = variant === "plain";
  const well = variant === "well";
  const comfortable = size === "comfortable";

  return (
    <Box flexDirection="column" gap={plain || comfortable ? 0 : 1} style={comfortable ? { gap: 6 } : undefined}>
      {label && (
        <Box height={comfortable ? undefined : 1} style={comfortable ? { height: 16 } : undefined}>
          <Text
            fg={focused ? colors.textBright : resolvedPlaceholderColor}
            style={{ fontWeight: "var(--gloom-weight-bold)", ...(comfortable ? { lineHeight: "16px" } : {}) }}
          >
            {label}
          </Text>
        </Box>
      )}
      <Box
        height={comfortable ? undefined : 1}
        width={width}
        flexDirection="row"
        alignItems="center"
        backgroundColor={plain ? "transparent" : resolvedBackgroundColor}
        onMouseDown={() => {
          if (disabled) return;
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
          height: comfortable ? COMFORTABLE_FIELD_HEIGHT : undefined,
          border: plain || well ? "none" : `1px solid ${controlBorderColor(focused, false, colors)}`,
          borderRadius: plain ? 0 : well ? "var(--gloom-radius-sm)" : CONTROL_RADIUS,
          // A well has no border: focus is the accent along its foot.
          boxShadow: well && focused ? "inset 0 -2px var(--gloom-accent)" : undefined,
          overflow: "hidden",
        }}
      >
        <Input
          aria-label={accessibleLabel ?? label}
          disabled={disabled}
          ref={resolvedInputRef as RefObject<InputRenderable | null>}
          width="100%"
          value={value}
          type={type}
          autoComplete={autoComplete}
          placeholder={placeholder}
          {...(maxLength === undefined ? {} : { maxLength })}
          focused={focused}
          textColor={resolvedTextColor}
          focusedTextColor={resolvedTextColor}
          placeholderColor={resolvedPlaceholderColor}
          backgroundColor={plain ? "transparent" : resolvedBackgroundColor}
          focusedBackgroundColor={plain ? "transparent" : resolvedBackgroundColor}
          cursorColor={colors.textBright}
          style={{
            // A framed field keeps its text one cell off the frame; a plain one
            // sits flush in the row or band that holds it.
            paddingLeft: plain ? 0 : "var(--cell-w)",
            paddingRight: plain ? 0 : "var(--cell-w)",
            borderRadius: plain ? 0 : CONTROL_RADIUS,
            // The field is taller than a cell, so the input takes the inner
            // height and centers its text on the box's own line.
            ...(comfortable ? { height: COMFORTABLE_FIELD_HEIGHT - 2, lineHeight: `${COMFORTABLE_FIELD_HEIGHT - 2}px` } : {}),
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
          <Text fg={colors.textMuted}>
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
  accessory,
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
      {/* The field takes what the accessory leaves. */}
      <Box flexGrow={1} height={height} style={{ minWidth: 0 }}>
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
      {accessory != null && (
        <Box
          flexDirection="row"
          data-gloom-role="desktop-message-composer-accessory"
          style={{ flex: "none", alignItems: "flex-start", padding: "4px 6px 0 0" }}
        >
          {accessory}
        </Box>
      )}
    </Box>
  );
}

export function WebSegmentedControl({
  accessibleLabel,
  options,
  value,
  onChange,
  focused,
  width,
  wrap = false,
  size = "default",
}: SegmentedControlProps) {
  const colors = useThemeColors();
  const enabled = options.filter((option) => !option.disabled);
  const large = size === "large";
  const selectAdjacent = (direction: -1 | 1) => {
    const index = enabled.findIndex((option) => option.value === value);
    const next = enabled[index < 0 ? 0 : (index + direction + enabled.length) % enabled.length];
    if (next) onChange?.(next.value);
  };

  // A segmented choice is a tab strip (the tab rule in styles.css): text, the
  // chosen one bright and bold on the accent underline. One row tall, so it
  // never bleeds over the pane title or the table header around it. A large
  // one, such as an order's side, is two rows of blocks that share the width,
  // the chosen one filled in its tone.
  return (
    <Box
      flexDirection="row"
      flexWrap={wrap ? "wrap" : "nowrap"}
      width={width}
      height={wrap ? undefined : large ? 2 : 1}
      alignItems="stretch"
      role="radiogroup"
      aria-label={accessibleLabel}
      data-gloom-role="segmented-control"
      data-size={large ? "large" : undefined}
      data-focused={focused ? "true" : undefined}
      style={large ? {
        borderRadius: "var(--gloom-radius-md)",
        overflow: "hidden",
        boxShadow: focused ? "0 0 0 2px var(--gloom-accent)" : undefined,
      } : undefined}
    >
      {options.map((option) => {
        const active = option.value === value;
        const tone = option.tone ? colors[option.tone] : undefined;
        return (
          <Box
            key={option.value}
            flexDirection="row"
            alignItems="center"
            justifyContent="center"
            flexGrow={large ? 1 : undefined}
            onMouseDown={() => {
              if (!option.disabled) onChange?.(option.value);
            }}
            // A clicked option would otherwise keep taking the arrows and Enter
            // after the keyboard has moved on to another pane.
            onClick={(event: { currentTarget: unknown; detail: number }) => releasePointerFocus(event.currentTarget, event.detail)}
            data-gloom-interactive={option.disabled ? undefined : "true"}
            data-gloom-role={large ? "segment-block" : "tab-button"}
            data-active={active ? "true" : undefined}
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
            style={large ? {
              height: "100%",
              cursor: option.disabled ? "default" : "pointer",
              outline: "none",
              fontSize: "var(--gloom-type-heading)",
              fontWeight: "var(--gloom-weight-bold)",
              background: option.disabled ? "var(--gloom-panel)" : active ? tone ?? colors.selected : "var(--gloom-panel)",
              color: option.disabled ? colors.textMuted : active ? tone ? colors.bg : colors.selectedText : tone ?? colors.textDim,
            } : {
              height: wrap ? undefined : "100%",
              cursor: option.disabled ? "default" : "pointer",
              ...(tone ? { "--tab-fg": tone, "--tab-active-fg": tone } as CSSProperties : {}),
              ...(option.disabled ? { color: colors.textMuted } : {}),
            }}
          >
            {option.label}
          </Box>
        );
      })}
    </Box>
  );
}

export function WebDialogFrame({
  title,
  subtitle,
  children,
  footer,
  desktopFooter,
  showTitleDivider = false,
  onClose,
  shrinkable = false,
}: DialogFrameProps) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="column" minHeight={shrinkable ? 0 : undefined} style={{ padding: "var(--gloom-space-lg)" }}>
      <Box
        flexDirection="row"
        alignItems="flex-start"
        style={{
          borderBottom: showTitleDivider ? "1px solid var(--gloom-hairline)" : "none",
          paddingBottom: showTitleDivider ? "var(--gloom-space-sm)" : 0,
          marginBottom: showTitleDivider ? "var(--gloom-space-md)" : "var(--gloom-space-lg)",
          gap: "var(--gloom-space-lg)",
        }}
      >
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          <Text fg={colors.text} attributes={TextAttributes.BOLD} wrapText style={{ fontWeight: 700 }}>
            {title}
          </Text>
          {subtitle ? (
            <Text fg={colors.textMuted} wrapText style={{ marginTop: "var(--gloom-space-xs)" }}>
              {subtitle}
            </Text>
          ) : null}
        </Box>
        {onClose ? (
          <WebIconButton icon="close" label="Close" onPress={onClose} />
        ) : null}
      </Box>
      {children}
      {/* No rule and no key list: the buttons carry their keys, so what is
          left is a few quiet keycaps or a note at the end of the content. */}
      {desktopFooter !== undefined ? (
        desktopFooter ? (
          <WebKeyHints keys={desktopFooter.keys} note={desktopFooter.note} style={{ flexShrink: 0, marginTop: "var(--gloom-space-md)", justifyContent: "flex-end" }} />
        ) : null
      ) : footer ? (
        <Box flexShrink={0} style={{ marginTop: "var(--gloom-space-md)" }}>
          <Text fg={colors.textMuted} wrapText>
            {footer}
          </Text>
        </Box>
      ) : null}
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
  useShortcut((event) => {
    if (!focused || !detailOpen || !isDetailBackNavigationKey(event)) return;
    event.stopPropagation?.();
    event.preventDefault?.();
    onBack();
  });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const attachedRef = useRef(0);
  const [headerAttached, setHeaderAttached] = useState(false);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  // A hint has no place in a query bar, so a detail with one keeps its band.
  const slot = useMemo<StackHeaderSlot | null>(() => backHint ? null : {
    backLabel,
    title: detailTitle,
    onBack: () => onBackRef.current(),
    containerRef,
    attach: () => {
      attachedRef.current += 1;
      setHeaderAttached(true);
      return () => {
        attachedRef.current -= 1;
        if (attachedRef.current === 0) setHeaderAttached(false);
      };
    },
  }, [backHint, backLabel, detailTitle]);

  if (!detailOpen) {
    return (
      <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} minHeight={0} overflow="hidden">
        {rootContent}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} minHeight={0} overflow="hidden">
      {!headerAttached && (
        <div className="gloom-stack-bar" data-gloom-role="page-stack-header" data-gloom-top-surface="">
          <button
            type="button"
            className="gloom-stack-back"
            data-gloom-interactive="true"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              onBack();
            }}
          >
            <WebIcon name="back" size={11} />
            <span className="gloom-qb-text">{backLabel}</span>
          </button>
          {detailTitle ? <div className="gloom-stack-title">{detailTitle}</div> : <div style={{ flex: 1 }} />}
          {backHint ? <span className="gloom-stack-hint">{backHint}</span> : null}
        </div>
      )}
      <div
        ref={containerRef}
        className="gloom-stack-detail"
        data-gloom-role={STACK_DETAIL_ROLE}
        style={{ display: "flex", flexDirection: "column", flex: "1 1 0", minWidth: 0, minHeight: 0, overflow: "hidden" }}
      >
        <StackHeaderContext.Provider value={slot}>
          <NestedPaneTabs>{detailContent}</NestedPaneTabs>
        </StackHeaderContext.Provider>
      </div>
    </Box>
  );
}
