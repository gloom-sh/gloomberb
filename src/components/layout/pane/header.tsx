import { Box, Span, Text, TextAttributes, useNativeRenderer, useUiCapabilities } from "../../../ui";
import { useCallback, useRef, type ReactNode } from "react";
import { blendHex, colors } from "../../../theme/colors";
import { useGlyphs, useThemeTokens } from "../../../theme/theme-context";
import type { GlyphSet } from "../../../theme/glyphs";
import type { PaneTokens } from "../../../theme/tokens";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import { capturePointerDrag } from "../../../ui/pointer-drag";

const PANE_HEADER_HEIGHT = 1;
export const PANE_HEADER_ACTION = " ... ";
export const PANE_HEADER_CLOSE = " x ";

interface PaneHeaderProps {
  title: string;
  width: number;
  focused: boolean;
  windowModeSelected?: boolean;
  floating?: boolean;
  showActions?: boolean;
  quickSettings?: PaneHeaderQuickSetting[];
  onHeaderMouseMove?: (event: any) => void;
  onHeaderMouseDown?: (event: any) => void;
  onHeaderMouseDrag?: (event: any) => void;
  onHeaderMouseDragEnd?: (event: any) => void;
  onHeaderContextMenu?: (event: any) => void;
  onActionMouseDown?: (event: any) => void;
  onCloseMouseDown?: (event: any) => void;
}

export interface PaneHeaderQuickSetting {
  key: string;
  icon: "zap";
  label: string;
  description?: string;
  active: boolean;
  onMouseDown?: (event: any) => void;
}

function truncateTitle(title: string, maxWidth: number): string {
  return truncateToDisplayWidth(title, maxWidth);
}

/** The style decides whether titles shout; the caller only supplies the words. */
function styleTitle(title: string, pane: PaneTokens): string {
  return pane.chrome.upperCaseTitles ? title.toUpperCase() : title;
}

function DesktopPaneButton({
  icon,
  onMouseDown,
  color = colors.textDim,
  label,
  pressed,
}: {
  icon: ReactNode;
  onMouseDown?: (event: any) => void;
  color?: string;
  label?: string;
  pressed?: boolean;
}) {
  return (
    <Box
      height={1}
      alignItems="center"
      justifyContent="center"
      onMouseDown={onMouseDown}
      data-gloom-interactive={onMouseDown ? "true" : undefined}
      data-gloom-role="pane-icon-button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      style={{
        minWidth: 20,
        paddingInline: 4,
        backgroundColor: "transparent",
        cursor: onMouseDown ? "pointer" : "default",
      }}
    >
      <Span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 12,
          height: 12,
          color,
        }}
      >
        {icon}
      </Span>
    </Box>
  );
}

function TerminalPaneButton({
  text,
  fg,
  role,
  attributes,
  onMouseDown,
}: {
  text: string;
  fg: string;
  role: string;
  attributes?: number;
  onMouseDown?: (event: any) => void;
}) {
  return (
    <Box
      height={1}
      width={displayWidth(text)}
      flexDirection="row"
      data-gloom-role={role}
      data-gloom-interactive={onMouseDown ? "true" : undefined}
      onMouseDown={onMouseDown}
    >
      <Text fg={fg} selectable={false} attributes={attributes}>{text}</Text>
    </Box>
  );
}

/**
 * Reverse video for an inverted header, an underline for a printed one, bold
 * for a focused title. The terminal gets real cell attributes and the DOM host
 * maps the same flags onto CSS, so one decision covers both renderers.
 *
 * INVERSE is the attribute rather than a pre-swapped pair of colours because
 * the title run only covers the columns the words occupy; the row behind it is
 * painted from the same tokens, and letting the renderer do the flip keeps the
 * two in step when a title is truncated.
 */
function headerAttributes(pane: PaneTokens, focused: boolean): number | undefined {
  let attributes = 0;
  if (pane.chrome.invertHeader) attributes |= TextAttributes.INVERSE;
  if (pane.chrome.underlineHeader) attributes |= TextAttributes.UNDERLINE;
  if (focused && (pane.chrome.headerMode === "inline" || pane.chrome.headerMode === "plain")) {
    attributes |= TextAttributes.BOLD;
  }
  return attributes || undefined;
}

export function PaneHeader({
  title,
  width,
  focused,
  windowModeSelected = false,
  floating = false,
  showActions = false,
  quickSettings = [],
  onHeaderMouseMove,
  onHeaderMouseDown,
  onHeaderMouseDrag,
  onHeaderMouseDragEnd,
  onHeaderContextMenu,
  onActionMouseDown,
  onCloseMouseDown,
}: PaneHeaderProps) {
  const { nativePaneChrome } = useUiCapabilities();
  const nativeRenderer = useNativeRenderer();
  const glyphs = useGlyphs();
  const { pane } = useThemeTokens();
  const terminalHeaderRef = useRef<unknown>(null);
  const visuallyFocused = focused || windowModeSelected;
  const state = visuallyFocused ? "focused" : "idle";
  const grip = pane.chrome.grip;
  // With INVERSE the renderer swaps the pair, so the title run is handed the
  // colours the other way round and the row keeps the resolved background.
  const rowBackground = floating ? pane.title.floatingBg[state] : pane.title.bg[state];
  const rowText = floating ? pane.title.floatingText[state] : pane.title.text[state];
  const inverted = pane.chrome.invertHeader;
  const backgroundColor = rowBackground;
  const textColor = inverted ? rowBackground : rowText;
  const textBackground = inverted ? rowText : undefined;
  const gripColor = pane.title.grip[state];
  const borderColor = visuallyFocused ? pane.border.focused : pane.border.idle;
  const attributes = headerAttributes(pane, visuallyFocused);
  const displayTitle = styleTitle(title, pane);
  const quickSettingLabel = ` ${glyphs.bolt} `;
  const actionText = showActions ? PANE_HEADER_ACTION : "     ";
  const closeText = floating ? PANE_HEADER_CLOSE : "";
  const terminalQuickSettingsWidth = quickSettings.reduce((total) => total + displayWidth(quickSettingLabel), 0);
  const handleTerminalHeaderMouseDown = useCallback((event: any) => {
    capturePointerDrag(nativeRenderer, terminalHeaderRef.current);
    onHeaderMouseDown?.(event);
  }, [nativeRenderer, onHeaderMouseDown]);

  if (nativePaneChrome) {
    return (
      <Box
        height={PANE_HEADER_HEIGHT}
        width={width}
        backgroundColor={backgroundColor}
        flexDirection="row"
        data-gloom-role="pane-header"
        data-gloom-header-mode={pane.chrome.headerMode}
        data-floating={floating ? "true" : "false"}
        data-focused={focused ? "true" : "false"}
        data-window-mode-selected={windowModeSelected ? "true" : "false"}
        onMouseDown={onHeaderMouseDown}
        onMouseMove={onHeaderMouseMove}
        onMouseDrag={onHeaderMouseDrag}
        onMouseDragEnd={onHeaderMouseDragEnd}
        onContextMenu={onHeaderContextMenu}
        style={{
          borderBottom: pane.chrome.headerMode === "bar" || pane.chrome.underlineHeader
            ? `1px solid ${borderColor}`
            : "none",
          boxShadow: pane.chrome.headerMode === "bar"
            ? `inset 0 -1px 0 ${blendHex(backgroundColor, visuallyFocused ? colors.borderFocused : colors.textBright, visuallyFocused ? 0.18 : 0.04)}`
            : "none",
        }}
      >
        {grip && (
          <Text fg={gripColor} selectable={false} data-gloom-role="pane-grip" attributes={attributes}>
            {grip}
          </Text>
        )}
        <Box minWidth={0} flexShrink={1} overflow="hidden">
          <Text
            fg={textColor}
            bg={textBackground}
            attributes={attributes}
            selectable={false}
            data-gloom-role="pane-title"
            style={{
              fontWeight: visuallyFocused ? "var(--gloom-heading-weight, 700)" : 600,
              letterSpacing: "var(--gloom-letter-spacing, 0)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {displayTitle}
          </Text>
        </Box>
        {quickSettings.map((setting) => (
          <Box key={setting.key} data-gloom-role="pane-quick-setting" data-setting-key={setting.key}>
            <DesktopPaneButton
              onMouseDown={setting.onMouseDown}
              color={setting.active ? colors.warning : colors.textDim}
              label={`${setting.label}: ${setting.active ? "on" : "off"}`}
              pressed={setting.active}
              icon={(
                <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
                  <path
                    d="M7.1 1.2 2.7 6.5h3.1l-.7 4.3 4.4-5.5H6.4l.7-4.1Z"
                    fill="currentColor"
                  />
                </svg>
              )}
            />
          </Box>
        ))}
        <Box flexGrow={1} minWidth={0} />
        <Box data-gloom-role="pane-action">
          {showActions ? (
            <DesktopPaneButton
              onMouseDown={onActionMouseDown}
              icon={(
                <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
                  <circle cx="2" cy="6" r="1.1" fill="currentColor" />
                  <circle cx="6" cy="6" r="1.1" fill="currentColor" />
                  <circle cx="10" cy="6" r="1.1" fill="currentColor" />
                </svg>
              )}
            />
          ) : <Box width={2} />}
        </Box>
        {floating && (
          <Box data-gloom-role="pane-close" marginLeft={1}>
            <DesktopPaneButton
              onMouseDown={onCloseMouseDown}
              icon={(
                <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
                  <path
                    d="M3 3L9 9M9 3L3 9"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            />
          </Box>
        )}
      </Box>
    );
  }

  // When focus is carried by the border, only the focused pane is boxed, which
  // is what makes the terminal style's grid readable. Any other focus mode has
  // its own signal, so the box is a constant and every pane gets one.
  const boxedHeader = pane.chrome.drawsBorder
    && (visuallyFocused || floating || pane.chrome.focusMode !== "border");

  if (boxedHeader) {
    // Build: ┌─:: Title ─────────── ... x─┐
    // Reserve 2 for corners, 1 for the rule after the corner, 1 before the next.
    const { topLeft, topRight, horizontal } = glyphs.border;
    const innerWidth = Math.max(0, width - 4);
    const contentWidth = grip.length + terminalQuickSettingsWidth + closeText.length + actionText.length;
    const titleWidth = Math.max(0, innerWidth - contentWidth);
    const clippedTitle = truncateTitle(displayTitle, titleWidth);
    const fillLen = Math.max(0, innerWidth - grip.length - displayWidth(clippedTitle) - terminalQuickSettingsWidth - actionText.length - closeText.length);
    const fill = horizontal.repeat(fillLen);

    return (
      <Box
        ref={terminalHeaderRef}
        height={PANE_HEADER_HEIGHT}
        width={width}
        backgroundColor={backgroundColor}
        flexDirection="row"
        onMouseDown={handleTerminalHeaderMouseDown}
        onMouseMove={onHeaderMouseMove}
        onMouseDrag={onHeaderMouseDrag}
        onMouseDragEnd={onHeaderMouseDragEnd}
      >
        <Text fg={borderColor} selectable={false}>{`${topLeft}${horizontal}`}</Text>
        <Text fg={textColor} bg={textBackground} selectable={false} attributes={attributes}>{`${grip}${clippedTitle}`}</Text>
        {quickSettings.map((setting) => (
          <TerminalPaneButton
            key={setting.key}
            text={quickSettingLabel}
            fg={setting.active ? colors.warning : colors.textDim}
            role="pane-quick-setting"
            onMouseDown={setting.onMouseDown}
          />
        ))}
        <Text fg={borderColor} selectable={false}>{fill}</Text>
        <TerminalPaneButton
          text={actionText}
          fg={textColor}
          role="pane-action"
          onMouseDown={onActionMouseDown}
        />
        {floating && (
          <TerminalPaneButton
            text={closeText}
            fg={textColor}
            role="pane-close"
            onMouseDown={onCloseMouseDown}
          />
        )}
        <Text fg={borderColor} selectable={false}>{`${horizontal}${topRight}`}</Text>
      </Box>
    );
  }

  const titleWidth = Math.max(0, width - grip.length - terminalQuickSettingsWidth - actionText.length - closeText.length);
  const clippedTitle = truncateTitle(displayTitle, titleWidth);
  // An inverted or underlined header owns the whole row, so the title run is
  // padded out to the columns it covers rather than stopping at the last word.
  const padding = " ".repeat(Math.max(0, titleWidth - displayWidth(clippedTitle)));

  return (
    <Box
      ref={terminalHeaderRef}
      height={PANE_HEADER_HEIGHT}
      width={width}
      backgroundColor={backgroundColor}
      flexDirection="row"
      onMouseDown={handleTerminalHeaderMouseDown}
      onMouseMove={onHeaderMouseMove}
      onMouseDrag={onHeaderMouseDrag}
      onMouseDragEnd={onHeaderMouseDragEnd}
    >
      <Text fg={textColor} bg={textBackground} selectable={false} attributes={attributes}>
        {`${grip}${clippedTitle}${padding}`}
      </Text>
      {quickSettings.map((setting) => (
        <TerminalPaneButton
          key={setting.key}
          text={quickSettingLabel}
          fg={setting.active ? colors.warning : colors.textDim}
          role="pane-quick-setting"
          onMouseDown={setting.onMouseDown}
        />
      ))}
      <TerminalPaneButton
        text={actionText}
        fg={textColor}
        role="pane-action"
        attributes={attributes}
        onMouseDown={onActionMouseDown}
      />
      {floating && (
        <TerminalPaneButton
          text={closeText}
          fg={textColor}
          role="pane-close"
          attributes={attributes}
          onMouseDown={onCloseMouseDown}
        />
      )}
    </Box>
  );
}
