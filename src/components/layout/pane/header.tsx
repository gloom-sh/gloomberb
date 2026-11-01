import { Box, Text, useActionShortcut, useNativeRenderer, useRendererHost, useUiCapabilities } from "../../../ui";
import { useCallback, useRef, type ReactNode } from "react";
import { colors, floatingPaneTitleBg, paneTitleBg, paneTitleText } from "../../../theme/colors";
import { WEB_CELL_WIDTH } from "../../../theme/font-scale";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import { capturePointerDrag } from "../../../ui/pointer-drag";
import { Tabs } from "../../ui/tabs";
import { ICON_GLYPHS, Icon, IconButton } from "../../ui/icon";
import { Button } from "../../ui/button";
import { t } from "../../../i18n";
import type { PaneHeaderTabsRegistration } from "./header-tabs";
import { nativePaneHeaderRows } from "./sizing";

const PANE_HEADER_HEIGHT = 1;
const PANE_HEADER_GRIP = ":: ";
export const PANE_HEADER_ACTION = " ... ";
/** The pane's docs: the same width shown or blank, so the title never shifts. */
export const PANE_HEADER_HELP = " ? ";
export const PANE_HEADER_CLOSE = " x ";
/**
 * Desktop: narrower than this many cells, a header leaves Ask Gloom out (the
 * pane menu and the key still ask), so the title keeps room and the `?`, the
 * menu and the close button sit where they always do.
 */
export const PANE_HEADER_ASK_MIN_WIDTH = 32;
/** Same width as the close mark, so the header hit areas stay put. */
export const PANE_HEADER_RESTORE = " - ";
const PANE_HEADER_LOCK = " 🔒 ";
const HIDDEN_HEADER_BUTTON = { visibility: "hidden" } as const;

interface PaneHeaderProps {
  title: string;
  /**
   * Desktop and web: the ticker of a single-ticker pane, drawn where its title names it as a
   * control that opens ticker search for the pane (`onTitleTickerPress`).
   */
  titleTicker?: string | null;
  onTitleTickerPress?: () => void;
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
  /** Desktop only: the header is a popped-out window's title bar. */
  titleBar?: PaneHeaderTitleBar | null;
  onHeaderMouseMove?: (event: any) => void;
  onHeaderMouseDown?: (event: any) => void;
  onHeaderMouseDrag?: (event: any) => void;
  onHeaderMouseDragEnd?: (event: any) => void;
  onHeaderContextMenu?: (event: any) => void;
  onActionMouseDown?: (event: any) => void;
  /** The `?`: this pane's entry in DOCS. Absent, the header draws no `?`. */
  onHelpMouseDown?: (event: any) => void;
  /**
   * Desktop: the button beside the `?` that asks Ask Gloom about this pane.
   * The terminal reaches it from the pane menu and the key instead.
   */
  onAskMouseDown?: (event: any) => void;
  onCloseMouseDown?: (event: any) => void;
  /** Pane fullscreen. The corner mark leaves fullscreen instead of closing. */
  fullscreen?: boolean;
  onRestoreMouseDown?: (event: any) => void;
}

/**
 * A popped-out window has no title bar of its own: the pane header is it. The
 * window moves by it and closes by its own controls, so there is no grip and
 * no close button.
 */
interface PaneHeaderTitleBar {
  /** Height in cells. */
  rows: number;
  /** Sits in the window's title-bar overlay, beside the macOS traffic lights. */
  overlay: boolean;
  /** Cells kept clear before the title for the traffic lights. */
  leadingInset: number;
  /** Drawn after the pane actions: the Windows window buttons. */
  trailing?: ReactNode;
}

/** A quick setting's terminal button: its glyph with a space either side. */
function quickSettingText(setting: { icon: PaneHeaderQuickSetting["icon"] }): string {
  return ` ${ICON_GLYPHS[setting.icon]} `;
}

export interface PaneHeaderQuickSetting {
  key: string;
  icon: "zap" | "sqrt";
  label: string;
  description?: string;
  active: boolean;
  onMouseDown?: (event: any) => void;
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

/**
 * Where `symbol` stands in a pane's title as a word of its own ("OMON SPY", "Chart: NVDA  \u29c9
 * Linked to DES"), so the header can draw it as a control. Null when the title does not name it.
 */
export function findTitleTicker(title: string, symbol: string): { start: number; end: number } | null {
  if (!symbol) return null;
  for (let start = title.indexOf(symbol); start >= 0; start = title.indexOf(symbol, start + 1)) {
    const end = start + symbol.length;
    if ((start === 0 || /\s/.test(title[start - 1]!)) && (end === title.length || /[\s,]/.test(title[end]!))) {
      return { start, end };
    }
  }
  return null;
}

/**
 * The ticker in a single-ticker pane's title: a ghost button in the title's own type, marked
 * with the chevron a query bar's choices carry, that opens ticker search for the pane. It sits
 * where the title's text put the ticker, so only the chevron and the hover fill tell it apart.
 */
function PaneTitleTicker({ symbol, color, onPress }: {
  symbol: string;
  color: string;
  onPress: () => void;
}) {
  const searchShortcut = useActionShortcut("ticker-search");
  const label = "Change ticker";
  // A span in the title's line, so the title still ends in one ellipsis. The button's inset goes
  // into the space before it, so the ticker's letters stay where the title's text put them.
  return (
    <Text
      data-gloom-role="pane-title-ticker"
      style={{ display: "inline-flex", verticalAlign: "top", marginLeft: "calc(-1 * var(--gloom-space-xs))" }}
    >
      <Button
        label={label}
        title={searchShortcut ? `${t(label)} (${searchShortcut})` : t(label)}
        variant="plain"
        compact
        stopPropagation
        onPress={onPress}
      >
        <Text fg={color} selectable={false} style={{ fontWeight: "var(--gloom-weight-bold)" }}>{symbol}</Text>
        <Text style={{ display: "inline-flex", marginLeft: "var(--gloom-space-xs)" }}>
          <Icon name="chevron-down" size={9} color={colors.textMuted} />
        </Text>
      </Button>
    </Text>
  );
}

export function PaneHeader({
  title,
  titleTicker = null,
  onTitleTickerPress,
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
  titleBar = null,
  onHeaderMouseMove,
  onHeaderMouseDown,
  onHeaderMouseDrag,
  onHeaderMouseDragEnd,
  onHeaderContextMenu,
  onActionMouseDown,
  onHelpMouseDown,
  onAskMouseDown,
  onCloseMouseDown,
  fullscreen = false,
  onRestoreMouseDown,
}: PaneHeaderProps) {
  const { nativePaneChrome, titleBarOverlay, nativeWindowChrome = titleBarOverlay } = useUiCapabilities();
  const rendererHost = useRendererHost();
  const nativeRenderer = useNativeRenderer();
  const menuShortcut = useActionShortcut("pane-menu");
  const closeShortcut = useActionShortcut("pane-close");
  const fullscreenShortcut = useActionShortcut("pane-fullscreen");
  const askShortcut = useActionShortcut("pane-ask");
  const terminalHeaderRef = useRef<unknown>(null);
  const visuallyFocused = focused || windowModeSelected;
  const backgroundColor = floating ? floatingPaneTitleBg(visuallyFocused) : paneTitleBg(visuallyFocused);
  const actionText = showActions ? PANE_HEADER_ACTION : "     ";
  const helpText = onHelpMouseDown ? (showActions ? PANE_HEADER_HELP : "   ") : "";
  const closeText = fullscreen ? PANE_HEADER_RESTORE : floating ? PANE_HEADER_CLOSE : "";
  const onCornerMouseDown = fullscreen ? onRestoreMouseDown : onCloseMouseDown;
  const lockText = locked ? PANE_HEADER_LOCK : "";
  const terminalQuickSettingsWidth = quickSettings.reduce((total, setting) => total + displayWidth(quickSettingText(setting)), 0)
    + displayWidth(lockText) + helpText.length;
  const textColor = paneTitleText(visuallyFocused, floating);
  const tickerAt = titleTicker ? findTitleTicker(title, titleTicker) : null;
  const topInset = topRule ? 1 : 0;
  const handleTerminalHeaderMouseDown = useCallback((event: any) => {
    capturePointerDrag(nativeRenderer, terminalHeaderRef.current);
    onHeaderMouseDown?.(event);
  }, [nativeRenderer, onHeaderMouseDown]);
  // The whole bar moves the pane: the grip, the title, the empty space and its
  // padding. Tabs and buttons stop the press before it gets here. A fullscreen
  // pane cannot move, so there the bar moves the desktop window instead.
  const windowDrag = Boolean(titleBar) || (fullscreen && titleBarOverlay === true && nativeWindowChrome === true);
  const beginPaneDrag = (event: { stopPropagation?: () => void }) => {
    event.stopPropagation?.();
    onHeaderMouseDown?.(event);
  };
  const beginWindowDrag = (event?: { stopPropagation?: () => void; detail?: number }) => {
    event?.stopPropagation?.();
    if (titleBar) {
      onHeaderMouseDown?.(event);
      return;
    }
    void rendererHost.startWindowDrag?.(event);
  };
  const barHandlers = windowDrag
    ? { onMouseDown: beginWindowDrag }
    : { onMouseDown: beginPaneDrag, onMouseDrag: onHeaderMouseDrag, onMouseDragEnd: onHeaderMouseDragEnd };

  if (nativePaneChrome) {
    // Focused, the rule is the accent; otherwise the one hairline.
    const ruleColor = visuallyFocused ? colors.borderFocused : "var(--gloom-hairline)";
    // No width of its own: it stretches across its pane, so it follows a
    // frame a resize sizes outside React.
    return (
      <Box
        height={titleBar?.rows ?? nativePaneHeaderRows()}
        backgroundColor={backgroundColor}
        flexDirection="row"
        data-gloom-role="pane-header"
        data-titlebar-overlay={titleBar?.overlay ? "true" : undefined}
        data-floating={floating ? "true" : "false"}
        data-focused={focused ? "true" : "false"}
        data-window-mode-selected={windowModeSelected ? "true" : "false"}
        data-drag-surface={windowDrag ? "window" : "pane"}
        {...barHandlers}
        onMouseMove={onHeaderMouseMove}
        onContextMenu={onHeaderContextMenu}
        style={{
          // One 1px rule at the bottom, painted inside the header, mirrored by
          // 1px of padding at the top where the pane's divider or floating border
          // sits, so everything centred in the content box is centred between
          // the two visible lines. Title-bar tabs end on the same edge and the
          // active one covers the rule.
          paddingInline: titleBar
            ? `${6 + titleBar.leadingInset * WEB_CELL_WIDTH}px ${titleBar.trailing ? 0 : 6}px`
            : "var(--gloom-inset)",
          paddingTop: topInset,
          paddingBottom: 1,
          // A window title bar also keeps the window's top edge its own colour.
          boxShadow: titleBar
            ? `inset 0 -1px 0 ${ruleColor}, 0 -1px 0 ${backgroundColor}, inset 0 1px 0 ${backgroundColor}`
            : `inset 0 -1px 0 ${ruleColor}`,
        }}
      >
        {!titleBar && (
          <Box data-gloom-role="pane-grip" flexShrink={0} flexDirection="row" alignItems="center" style={{ alignSelf: "stretch", marginRight: "var(--gloom-space-xs)" }}>
            <Icon name="grip" size={12} color={visuallyFocused ? colors.borderFocused : colors.textMuted} />
          </Box>
        )}
        {/* Full header height, so trimming the title to its capitals never lets
            this clip cut descenders. */}
        <Box data-gloom-role="pane-header-chrome" minWidth={0} flexShrink={tabs ? 0 : 1} overflow="hidden" flexDirection="row" alignItems="center" style={{ alignSelf: "stretch", ...(tabs ? { maxWidth: "40%" } : {}) }}>
          <Text
            fg={textColor}
            selectable={false}
            data-gloom-role="pane-title"
            style={{
              // Focus changes the colour, never the weight: a bold title would
              // change width as the pane takes and loses focus.
              fontWeight: 700,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {tickerAt && onTitleTickerPress ? (
              <>
                {title.slice(0, tickerAt.start)}
                <PaneTitleTicker
                  symbol={title.slice(tickerAt.start, tickerAt.end)}
                  color={textColor}
                  onPress={onTitleTickerPress}
                />
                {title.slice(tickerAt.end)}
              </>
            ) : title}
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
              marginLeft: "var(--gloom-space-sm)",
              // Undoes the negative top margin for what is centred in the strip:
              // the overflow chevron, and the tab labels (styles.css).
              "--pane-tab-top-inset": `${topInset}px`,
              // The active tab's box opens into the pane over the bottom rule
              // (styles.css), drawn in the rule's colour so the two are one line.
              "--pane-tab-border": ruleColor,
              // Until the strip has measured the surface under the tab (top-surface.ts).
              "--pane-tab-active-bg": bodyBackground ?? colors.bg,
              // The active tab reads as active whenever the pane is focused, even
              // while a detail or field inside the pane owns the keyboard.
              "--pane-tab-active-fg": visuallyFocused ? colors.textBright : colors.text,
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
              onDrag={windowDrag && !tabs.onReorder ? beginWindowDrag : undefined}
              closeMode={tabs.closeMode}
              paneMenu={tabs.paneMenu}
            />
          </Box>
        )}
        {quickSettings.map((setting) => (
          <Box key={setting.key} data-gloom-role="pane-quick-setting" data-setting-key={setting.key}>
            <IconButton
              icon={setting.icon}
              label={`${setting.label}: ${setting.active ? "on" : "off"}`}
              pressed={setting.active}
              onPress={setting.onMouseDown ? (event) => setting.onMouseDown?.(event) : undefined}
            />
          </Box>
        ))}
        <Box flexGrow={1} minWidth={0} />
        {locked && (
          <Box data-gloom-role="pane-lock">
            <IconButton icon="lock" label="Locked: the close shortcut leaves this pane open" color={colors.textMuted} />
          </Box>
        )}
        {onAskMouseDown && width >= PANE_HEADER_ASK_MIN_WIDTH && (
          // Hidden rather than swapped for a spacer while the pane is not
          // focused or hovered: it keeps its width, so showing it moves nothing.
          <Box data-gloom-role="pane-ask" style={showActions ? undefined : HIDDEN_HEADER_BUTTON}>
            <IconButton
              icon="ask"
              label="Ask Gloom about this pane"
              shortcut={askShortcut || undefined}
              onPress={showActions ? (event) => onAskMouseDown(event) : undefined}
            />
          </Box>
        )}
        {onHelpMouseDown && (
          <Box data-gloom-role="pane-help">
            {showActions ? (
              <IconButton
                icon="help"
                label="Docs for this pane"
                onPress={(event) => onHelpMouseDown(event)}
              />
            ) : <Box width={2} />}
          </Box>
        )}
        <Box data-gloom-role="pane-action">
          {showActions ? (
            <IconButton
              icon="more"
              label="Pane actions"
              shortcut={menuShortcut || undefined}
              hasPopup="menu"
              onPress={onActionMouseDown ? (event) => onActionMouseDown(event) : undefined}
            />
          ) : <Box width={2} />}
        </Box>
        {(fullscreen || (floating && !titleBar)) && (
          <Box data-gloom-role={fullscreen ? "pane-restore" : "pane-close"} marginLeft={1}>
            <IconButton
              icon={fullscreen ? "minimize" : "close"}
              label={fullscreen ? "Exit fullscreen" : "Close pane"}
              shortcut={(fullscreen ? fullscreenShortcut : closeShortcut) || undefined}
              onPress={onCornerMouseDown ? (event) => onCornerMouseDown(event) : undefined}
            />
          </Box>
        )}
        {titleBar?.trailing}
      </Box>
    );
  }

  if (visuallyFocused || floating || fullscreen) {
    // Build: ┌─:: Title ─────────── ... x─┐
    // Fullscreen draws "-" in that corner. Reserve 2 for the frame.
    const borderColor = visuallyFocused ? colors.borderFocused : colors.border;
    const innerWidth = Math.max(0, width - 4);
    const contentWidth = PANE_HEADER_GRIP.length + terminalQuickSettingsWidth + closeText.length + actionText.length;
    const titleWidth = Math.max(0, innerWidth - contentWidth);
    const clippedTitle = truncateToDisplayWidth(title, titleWidth);
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
            text={quickSettingText(setting)}
            fg={setting.active ? colors.warning : colors.textDim}
            role="pane-quick-setting"
            onMouseDown={setting.onMouseDown}
          />
        ))}
        <Text fg={borderColor} selectable={false}>{fill}</Text>
        {locked && (
          <TerminalPaneButton text={lockText} fg={colors.textMuted} role="pane-lock" />
        )}
        {helpText && (
          <TerminalPaneButton text={helpText} fg={textColor} role="pane-help" onMouseDown={showActions ? onHelpMouseDown : undefined} />
        )}
        <TerminalPaneButton
          text={actionText}
          fg={textColor}
          role="pane-action"
          onMouseDown={onActionMouseDown}
        />
        {(fullscreen || floating) && (
          <TerminalPaneButton
            text={closeText}
            fg={textColor}
            role={fullscreen ? "pane-restore" : "pane-close"}
            onMouseDown={onCornerMouseDown}
          />
        )}
        <Text fg={borderColor} selectable={false}>{"─┐"}</Text>
      </Box>
    );
  }

  const titleWidth = Math.max(0, width - PANE_HEADER_GRIP.length - terminalQuickSettingsWidth - actionText.length - closeText.length);
  const clippedTitle = truncateToDisplayWidth(title, titleWidth);
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
          text={quickSettingText(setting)}
          fg={setting.active ? colors.warning : colors.textDim}
          role="pane-quick-setting"
          onMouseDown={setting.onMouseDown}
        />
      ))}
      {locked && (
        <TerminalPaneButton text={lockText} fg={colors.textMuted} role="pane-lock" />
      )}
      {helpText && (
        <TerminalPaneButton text={helpText} fg={textColor} role="pane-help" onMouseDown={showActions ? onHelpMouseDown : undefined} />
      )}
      <TerminalPaneButton
        text={actionText}
        fg={textColor}
        role="pane-action"
        onMouseDown={onActionMouseDown}
      />
      {(fullscreen || floating) && (
        <TerminalPaneButton
          text={closeText}
          fg={textColor}
          role={fullscreen ? "pane-restore" : "pane-close"}
          onMouseDown={onCornerMouseDown}
        />
      )}
    </Box>
  );
}
