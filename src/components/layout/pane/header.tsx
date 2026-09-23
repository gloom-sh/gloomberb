import { Box, Span, Text, useNativeRenderer, useUiCapabilities } from "../../../ui";
import { useCallback, useRef, type ReactNode } from "react";
import { blendHex, colors, floatingPaneTitleBg, paneTitleBg, paneTitleText } from "../../../theme/colors";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import { capturePointerDrag } from "../../../ui/pointer-drag";
import { Tabs } from "../../ui/tabs";
import type { PaneHeaderTabsRegistration } from "./header-tabs";
import { nativePaneHeaderRows } from "./sizing";

const PANE_HEADER_HEIGHT = 1;
/** Space above desktop title-bar tabs, in px. */
const HEADER_TAB_TOP_GAP = 2;
const PANE_HEADER_GRIP = ":: ";
export const PANE_HEADER_ACTION = " ... ";
export const PANE_HEADER_CLOSE = " x ";
export const PANE_HEADER_LOCK = " 🔒 ";

interface PaneHeaderProps {
  title: string;
  width: number;
  focused: boolean;
  windowModeSelected?: boolean;
  floating?: boolean;
  locked?: boolean;
  showActions?: boolean;
  quickSettings?: PaneHeaderQuickSetting[];
  /** Desktop only: the pane's primary tab strip, drawn as title-bar tabs. */
  tabs?: PaneHeaderTabsRegistration | null;
  /** The body colour the active title-bar tab opens into. */
  bodyBackground?: string;
  /**
   * Desktop: a 1px line is drawn over the header's first row (a dock divider
   * above it, or a floating pane's border). The header mirrors it with padding
   * so its contents centre between the visible lines.
   */
  topRule?: boolean;
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
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      style={{
        borderRadius: 4,
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
  onMouseDown,
}: {
  text: string;
  fg: string;
  role: string;
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
      <Text fg={fg} selectable={false}>{text}</Text>
    </Box>
  );
}

export function PaneHeader({
  title,
  width,
  focused,
  windowModeSelected = false,
  floating = false,
  locked = false,
  showActions = false,
  quickSettings = [],
  tabs = null,
  bodyBackground,
  topRule = false,
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
  const terminalHeaderRef = useRef<unknown>(null);
  const visuallyFocused = focused || windowModeSelected;
  const backgroundColor = floating ? floatingPaneTitleBg(visuallyFocused) : paneTitleBg(visuallyFocused);
  const actionText = showActions ? PANE_HEADER_ACTION : "     ";
  const closeText = floating ? PANE_HEADER_CLOSE : "";
  const lockText = locked ? PANE_HEADER_LOCK : "";
  const terminalQuickSettingsWidth = quickSettings.reduce((total) => total + displayWidth(" ⚡ "), 0)
    + displayWidth(lockText);
  const textColor = paneTitleText(visuallyFocused, floating);
  const topInset = topRule ? 1 : 0;
  const handleTerminalHeaderMouseDown = useCallback((event: any) => {
    capturePointerDrag(nativeRenderer, terminalHeaderRef.current);
    onHeaderMouseDown?.(event);
  }, [nativeRenderer, onHeaderMouseDown]);

  if (nativePaneChrome) {
    return (
      <Box
        height={nativePaneHeaderRows()}
        width={width}
        backgroundColor={backgroundColor}
        flexDirection="row"
        data-gloom-role="pane-header"
        data-floating={floating ? "true" : "false"}
        data-focused={focused ? "true" : "false"}
        data-window-mode-selected={windowModeSelected ? "true" : "false"}
        onMouseDown={onHeaderMouseDown}
        onMouseMove={onHeaderMouseMove}
        onMouseDrag={onHeaderMouseDrag}
        onMouseDragEnd={onHeaderMouseDragEnd}
        onContextMenu={onHeaderContextMenu}
        style={{
          // One 1px rule at the bottom, painted inside the header, mirrored by
          // 1px of padding at the top where the pane's divider or floating border
          // sits, so everything centred in the content box is centred between
          // the two visible lines. Title-bar tabs end on the same edge and the
          // active one covers the rule.
          paddingInline: 6,
          paddingTop: topInset,
          paddingBottom: 1,
          boxShadow: `inset 0 -1px 0 ${visuallyFocused ? colors.borderFocused : colors.border}`,
        }}
      >
        <Text fg={visuallyFocused ? colors.borderFocused : colors.textMuted} selectable={false} data-gloom-role="pane-grip">
          {PANE_HEADER_GRIP}
        </Text>
        {/* Full header height, so trimming the title to its capitals never lets
            this clip cut descenders. */}
        <Box minWidth={0} flexShrink={tabs ? 0 : 1} overflow="hidden" flexDirection="row" alignItems="center" style={{ alignSelf: "stretch", ...(tabs ? { maxWidth: "40%" } : {}) }}>
          <Text
            fg={textColor}
            selectable={false}
            data-gloom-role="pane-title"
            style={{
              fontWeight: visuallyFocused ? 700 : 600,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </Text>
        </Box>
        {tabs && (
          <Box
            data-gloom-role="pane-header-tabs"
            flexShrink={1}
            minWidth={0}
            onMouseDown={(event: any) => {
              // Tabs select on click; the header must not start a pane drag.
              event.stopPropagation?.();
            }}
            style={{
              alignSelf: "stretch",
              marginTop: -topInset,
              marginBottom: -1,
              marginLeft: 10,
              "--pane-tab-top-gap": `${HEADER_TAB_TOP_GAP}px`,
              // Lifts tab labels onto the header's centre line. The tab spans
              // gap..bottom with a 1px top border; the centre line sits halfway
              // between the top rule (if any) and the bottom rule.
              "--pane-tab-label-lift": `${HEADER_TAB_TOP_GAP + 2 - topInset}px`,
              // Fallback until the tab strip has measured the surface under it.
              "--pane-tab-active-bg": bodyBackground ?? colors.bg,
              "--pane-tab-border": visuallyFocused ? colors.borderFocused : colors.border,
              // The active tab reads as active whenever the pane is focused, even
              // while a detail or field inside the pane owns the keyboard.
              "--pane-tab-active-fg": visuallyFocused ? colors.textBright : colors.text,
              "--pane-tab-hover-bg": blendHex(backgroundColor, colors.textBright, 0.06),
            }}
          >
            <Tabs
              tabs={tabs.tabs}
              activeValue={tabs.activeValue}
              onSelect={tabs.onSelect}
              variant="header"
              focused={tabs.focused}
              keyboardNavigation={tabs.keyboardNavigation}
              onAdd={tabs.onAdd}
              addLabel={tabs.addLabel}
              onReorder={tabs.onReorder}
              closeMode={tabs.closeMode}
            />
          </Box>
        )}
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
        {locked && (
          <Box data-gloom-role="pane-lock">
            <DesktopPaneButton
              color={colors.textMuted}
              label="Locked: the close shortcut leaves this pane open"
              icon={(
                <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
                  <rect x="2.5" y="5.5" width="7" height="5" rx="1.2" fill="currentColor" />
                  <path
                    d="M4.25 5.5V4a1.75 1.75 0 0 1 3.5 0v1.5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            />
          </Box>
        )}
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

  if (visuallyFocused || floating) {
    // Build: ┌─:: Title ─────────── ... x─┐
    // Reserve 2 for corners, 1 for ─ after ┌, 1 for ─ before ┐
    const borderColor = visuallyFocused ? colors.borderFocused : colors.border;
    const innerWidth = Math.max(0, width - 4);
    const contentWidth = PANE_HEADER_GRIP.length + terminalQuickSettingsWidth + closeText.length + actionText.length;
    const titleWidth = Math.max(0, innerWidth - contentWidth);
    const clippedTitle = truncateTitle(title, titleWidth);
    const fillLen = Math.max(0, innerWidth - PANE_HEADER_GRIP.length - displayWidth(clippedTitle) - terminalQuickSettingsWidth - actionText.length - closeText.length);
    const fill = "─".repeat(fillLen);

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
        <Text fg={borderColor} selectable={false}>{"┌─"}</Text>
        <Text fg={textColor} selectable={false}>{`${PANE_HEADER_GRIP}${clippedTitle}`}</Text>
        {quickSettings.map((setting) => (
          <TerminalPaneButton
            key={setting.key}
            text=" ⚡ "
            fg={setting.active ? colors.warning : colors.textDim}
            role="pane-quick-setting"
            onMouseDown={setting.onMouseDown}
          />
        ))}
        <Text fg={borderColor} selectable={false}>{fill}</Text>
        {locked && (
          <TerminalPaneButton text={lockText} fg={colors.textMuted} role="pane-lock" />
        )}
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
        <Text fg={borderColor} selectable={false}>{"─┐"}</Text>
      </Box>
    );
  }

  const titleWidth = Math.max(0, width - PANE_HEADER_GRIP.length - terminalQuickSettingsWidth - actionText.length - closeText.length);
  const clippedTitle = truncateTitle(title, titleWidth);
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
      <Text fg={textColor} selectable={false}>
        {`${PANE_HEADER_GRIP}${clippedTitle}${padding}`}
      </Text>
      {quickSettings.map((setting) => (
        <TerminalPaneButton
          key={setting.key}
          text=" ⚡ "
          fg={setting.active ? colors.warning : colors.textDim}
          role="pane-quick-setting"
          onMouseDown={setting.onMouseDown}
        />
      ))}
      {locked && (
        <TerminalPaneButton text={lockText} fg={colors.textMuted} role="pane-lock" />
      )}
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
    </Box>
  );
}
