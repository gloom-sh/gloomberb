import { Box, Text, useActionShortcut, useNativeRenderer, useRendererHost, useUiCapabilities } from "../../../ui";
import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { colors, floatingPaneTitleBg, paneTitleBg, paneTitleText } from "../../../theme/colors";
import { WEB_CELL_WIDTH } from "../../../theme/font-scale";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import { capturePointerDrag } from "../../../ui/pointer-drag";
import { Tabs } from "../../ui/tabs";
import { ICON_GLYPHS, Icon, IconButton } from "../../ui/icon";
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
/** Terminal: between two tabs of a stack, and the most of a title one tab shows. */
const STACK_TAB_SEPARATOR = " │ ";
const STACK_TAB_MAX_WIDTH = 16;

/**
 * Panes stacked in one spot of the dock: the header names each as a tab in
 * place of the title, the one shown first among equals.
 */
export interface PaneHeaderStack {
  /** In tab order. */
  tabs: ReadonlyArray<{ id: string; title: string }>;
  /** The pane shown. */
  active: string;
  /** A click on a tab: show that pane. */
  onSelect: (id: string) => void;
  /** A press on a tab, in place of the header's: a drag moves that pane out of the stack. */
  onTabMouseDown?: (id: string, event: any) => void;
}

/**
 * Terminal: each tab of a stack in its header, as text and where it starts,
 * in cells from where the title starts (after the grip). The pointer runtime
 * finds the tab under a press with it.
 */
export function stackTabSpans(titles: readonly string[]): Array<{ start: number; text: string }> {
  let start = 0;
  return titles.map((title) => {
    const text = truncateToDisplayWidth(title, STACK_TAB_MAX_WIDTH);
    const span = { start, text };
    start += displayWidth(text) + STACK_TAB_SEPARATOR.length;
    return span;
  });
}

/** Terminal: the cells before a header's title: the grip, after the corner a focused or floating pane draws. */
export function paneHeaderTitleStart(framed: boolean): number {
  return (framed ? 2 : 0) + PANE_HEADER_GRIP.length;
}

/** Terminal: how wide a stack's tabs are, all of them. */
function stackTabsWidth(stack: PaneHeaderStack): number {
  const last = stackTabSpans(stack.tabs.map((tab) => tab.title)).at(-1);
  return last ? last.start + displayWidth(last.text) : 0;
}

/** Terminal: a stack's tabs in at most `width` cells (all of them with `pad`), the shown one in `activeFg`, the rest dim. */
function TerminalStackTabs({ stack, width, activeFg, pad }: { stack: PaneHeaderStack; width: number; activeFg: string; pad: boolean }) {
  const spans = stackTabSpans(stack.tabs.map((tab) => tab.title));
  const parts: Array<{ key: string; text: string; fg: string }> = [];
  stack.tabs.forEach((tab, index) => {
    if (index > 0) parts.push({ key: `sep:${tab.id}`, text: STACK_TAB_SEPARATOR, fg: colors.border });
    parts.push({ key: tab.id, text: spans[index]!.text, fg: tab.id === stack.active ? activeFg : colors.textDim });
  });
  let left = width;
  return (
    <>
      {parts.map((part) => {
        const text = truncateToDisplayWidth(part.text, Math.max(0, left));
        left -= displayWidth(text);
        return text ? <Text key={part.key} fg={part.fg} selectable={false}>{text}</Text> : null;
      })}
      {pad && left > 0 && <Text fg={activeFg} selectable={false}>{" ".repeat(left)}</Text>}
    </>
  );
}

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
  /** Panes stacked in this spot: their tabs replace the title. */
  stack?: PaneHeaderStack | null;
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
  stack = null,
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
  const topInset = topRule ? 1 : 0;
  const handleTerminalHeaderMouseDown = useCallback((event: any) => {
    capturePointerDrag(nativeRenderer, terminalHeaderRef.current);
    onHeaderMouseDown?.(event);
  }, [nativeRenderer, onHeaderMouseDown]);
  // The whole bar moves the pane: the grip, the title, the empty space and its
  // padding. Tabs and buttons stop the press before it gets here. A fullscreen
  // pane cannot move, so there the bar moves the desktop window instead.
  const windowDrag = Boolean(titleBar) || (fullscreen && titleBarOverlay === true && nativeWindowChrome === true);
  const beginPaneDrag = (event: { stopPropagation?: () => void; target?: unknown }) => {
    event.stopPropagation?.();
    // A press on one of a stack's tabs moves that pane, not the one shown.
    const tabId = stack?.onTabMouseDown ? stackTabOfTarget(event.target) : null;
    if (tabId && stack?.onTabMouseDown) {
      stack.onTabMouseDown(tabId, event);
      return;
    }
    onHeaderMouseDown?.(event);
  };
  const stackTabItems = useMemo(
    () => stack?.tabs.map((tab) => ({ label: tab.title, value: tab.id })) ?? null,
    [stack?.tabs],
  );
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
          {stack && stackTabItems ? (
            <Box data-gloom-role="pane-stack-tabs" minWidth={0} flexShrink={1} style={{ alignSelf: "stretch" }}>
              <Tabs
                tabs={stackTabItems}
                activeValue={stack.active}
                onSelect={stack.onSelect}
                variant="bare"
                dense
                focused={visuallyFocused}
                keyboardNavigation={false}
                paneMenu={false}
              />
            </Box>
          ) : (
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
              {title}
            </Text>
          )}
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
    const fillLen = Math.max(0, innerWidth - PANE_HEADER_GRIP.length - (stack ? Math.min(titleWidth, stackTabsWidth(stack)) : displayWidth(clippedTitle)) - terminalQuickSettingsWidth - actionText.length - closeText.length);
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
        {stack ? (
          <>
            <Text fg={textColor} selectable={false}>{PANE_HEADER_GRIP}</Text>
            <TerminalStackTabs stack={stack} width={titleWidth} activeFg={textColor} pad={false} />
          </>
        ) : (
          <Text fg={textColor} selectable={false}>{`${PANE_HEADER_GRIP}${clippedTitle}`}</Text>
        )}
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
      {stack ? (
        <>
          <Text fg={textColor} selectable={false}>{PANE_HEADER_GRIP}</Text>
          <TerminalStackTabs stack={stack} width={titleWidth} activeFg={textColor} pad />
        </>
      ) : (
        <Text fg={textColor} selectable={false}>
          {`${PANE_HEADER_GRIP}${clippedTitle}${padding}`}
        </Text>
      )}
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

/** Desktop: the stack tab a press landed on, by the tab button it hit. */
function stackTabOfTarget(target: unknown): string | null {
  const element = target as { closest?: (selector: string) => { getAttribute(name: string): string | null } | null } | null;
  return element?.closest?.('[data-gloom-role="pane-stack-tabs"] [data-tab-value]')?.getAttribute("data-tab-value") ?? null;
}
