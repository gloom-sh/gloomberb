import { Box, Span, Text, useNativeRenderer, useUiCapabilities, useUiHost } from "../../../ui";
import { useCallback, useRef, type ReactNode } from "react";
import { blendHex, colors, floatingPaneTitleBg, paneTitleBg, paneTitleText } from "../../../theme/colors";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import {
  PANE_HEADER_ACTION,
  PANE_HEADER_CLOSE,
  PANE_HEADER_FLOATING,
  PANE_HEADER_TILED,
  resolveTerminalPaneHeaderGeometry,
} from "./terminal-header-geometry";

export {
  PANE_HEADER_ACTION,
  PANE_HEADER_CLOSE,
  PANE_HEADER_FLOATING,
  PANE_HEADER_TILED,
} from "./terminal-header-geometry";

const PANE_HEADER_HEIGHT = 1;
const PANE_HEADER_GRIP = ":: ";

interface PaneHeaderProps {
  title: string;
  width: number;
  focused: boolean;
  windowModeSelected?: boolean;
  floating?: boolean;
  showActions?: boolean;
  onHeaderMouseMove?: (event: any) => void;
  onHeaderMouseDown?: (event: any) => void;
  onHeaderMouseDrag?: (event: any) => void;
  onHeaderMouseDragEnd?: (event: any) => void;
  onHeaderContextMenu?: (event: any) => void;
  onActionMouseDown?: (event: any) => void;
  onFloatToggleMouseDown?: (event: any) => void;
  onCloseMouseDown?: (event: any) => void;
}

function truncateTitle(title: string, maxWidth: number): string {
  return truncateToDisplayWidth(title, maxWidth);
}

function captureTerminalPointerDrag(renderer: unknown, renderable: unknown): void {
  if (!renderable) return;
  const hostCapture = (renderer as { captureMouseRenderable?: (target: unknown) => void }).captureMouseRenderable;
  if (typeof hostCapture === "function") {
    hostCapture.call(renderer, renderable);
    return;
  }
  const capture = (renderer as { setCapturedRenderable?: (target: unknown) => void }).setCapturedRenderable;
  if (typeof capture !== "function") return;
  capture.call(renderer, renderable);
}

export function DesktopPaneButton({
  label,
  icon,
  onActivate,
  role,
}: {
  label: string;
  icon: ReactNode;
  onActivate?: (event: any) => void;
  role: string;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={onActivate}
      data-gloom-role={role}
      data-gloom-interactive={onActivate ? "true" : undefined}
      aria-label={label}
      title={label}
      style={{
        appearance: "none",
        border: 0,
        borderRadius: 4,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minWidth: 20,
        paddingInline: 4,
        backgroundColor: "transparent",
        cursor: onActivate ? "pointer" : "default",
      }}
    >
      <Span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 12,
          height: 12,
          color: colors.textDim,
        }}
      >
        {icon}
      </Span>
    </button>
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
      flexShrink={0}
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
  showActions = false,
  onHeaderMouseMove,
  onHeaderMouseDown,
  onHeaderMouseDrag,
  onHeaderMouseDragEnd,
  onHeaderContextMenu,
  onActionMouseDown,
  onFloatToggleMouseDown,
  onCloseMouseDown,
}: PaneHeaderProps) {
  const { nativePaneChrome } = useUiCapabilities();
  const uiKind = useUiHost().kind;
  const nativeRenderer = useNativeRenderer();
  const terminalHeaderRef = useRef<unknown>(null);
  const visuallyFocused = focused || windowModeSelected;
  const backgroundColor = floating ? floatingPaneTitleBg(visuallyFocused) : paneTitleBg(visuallyFocused);
  const floatToggleText = floating ? PANE_HEADER_FLOATING : PANE_HEADER_TILED;
  const floatToggleLabel = floating
    ? "Pane is floating — tile pane"
    : "Pane is tiled — float pane";
  const textColor = paneTitleText(visuallyFocused, floating);
  const terminalGeometry = resolveTerminalPaneHeaderGeometry(width, {
    floating,
    focused: visuallyFocused,
    showActions,
  });
  const handleTerminalHeaderMouseDown = useCallback((event: any) => {
    captureTerminalPointerDrag(nativeRenderer, terminalHeaderRef.current);
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
        data-floating={floating ? "true" : "false"}
        data-focused={focused ? "true" : "false"}
        data-window-mode-selected={windowModeSelected ? "true" : "false"}
        onMouseDown={onHeaderMouseDown}
        onMouseMove={onHeaderMouseMove}
        onMouseDrag={onHeaderMouseDrag}
        onMouseDragEnd={onHeaderMouseDragEnd}
        onContextMenu={onHeaderContextMenu}
        style={{
          borderBottom: `1px solid ${visuallyFocused ? colors.borderFocused : colors.border}`,
          paddingInline: 6,
          boxShadow: visuallyFocused
            ? `inset 0 -1px 0 ${blendHex(paneTitleBg(visuallyFocused), colors.borderFocused, 0.18)}`
            : `inset 0 -1px 0 ${blendHex(paneTitleBg(visuallyFocused), colors.textBright, 0.04)}`,
        }}
      >
        <Text fg={visuallyFocused ? colors.borderFocused : colors.textMuted} selectable={false} data-gloom-role="pane-grip">
          {PANE_HEADER_GRIP}
        </Text>
        <Box flexGrow={1} minWidth={0} overflow="hidden">
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
        <Box data-gloom-role="pane-header-actions" position="relative" zIndex={2}>
          {uiKind === "opentui" ? (
            <TerminalPaneButton
              text={floatToggleText}
              fg={colors.textDim}
              role="pane-float-toggle"
              onMouseDown={onFloatToggleMouseDown}
            />
          ) : (
            <DesktopPaneButton
              label={floatToggleLabel}
              onActivate={onFloatToggleMouseDown}
              role="pane-float-toggle"
              icon={floating ? (
                <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
                  <rect x="4.5" y="4.5" width="6" height="6" rx="1" fill={backgroundColor} stroke="currentColor" strokeWidth="1.2" />
                </svg>
              ) : (
                <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
                  <rect x="1" y="1" width="10" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M6 1V11M1 6H11" stroke="currentColor" strokeWidth="1" />
                </svg>
              )}
            />
          )}
          {showActions ? (
            uiKind === "opentui" ? (
              <TerminalPaneButton text={PANE_HEADER_ACTION} fg={colors.textDim} role="pane-action" onMouseDown={onActionMouseDown} />
            ) : (
              <DesktopPaneButton
                label="Pane actions"
                onActivate={onActionMouseDown}
                role="pane-action"
                icon={(
                  <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
                    <circle cx="2" cy="6" r="1.1" fill="currentColor" />
                    <circle cx="6" cy="6" r="1.1" fill="currentColor" />
                    <circle cx="10" cy="6" r="1.1" fill="currentColor" />
                  </svg>
                )}
              />
            )
          ) : <Box width={2} />}
        </Box>
        {floating && (
          <Box data-gloom-role="pane-close" marginLeft={1} position="relative" zIndex={2}>
            {uiKind === "opentui" ? (
              <TerminalPaneButton text={PANE_HEADER_CLOSE} fg={colors.textDim} role="pane-close" onMouseDown={onCloseMouseDown} />
            ) : (
              <DesktopPaneButton
                label="Close pane"
                onActivate={onCloseMouseDown}
                role="pane-close"
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
            )}
          </Box>
        )}
      </Box>
    );
  }

  if (visuallyFocused || floating) {
    const borderColor = visuallyFocused ? colors.borderFocused : colors.border;
    const grip = truncateTitle(PANE_HEADER_GRIP, terminalGeometry.contentWidth);
    const titleWidth = Math.max(0, terminalGeometry.contentWidth - displayWidth(grip));
    const clippedTitle = truncateTitle(title, titleWidth);
    const fillLen = Math.max(0, terminalGeometry.contentWidth - displayWidth(grip) - displayWidth(clippedTitle));
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
        <Text
          width={displayWidth(terminalGeometry.leftBorder)}
          flexShrink={0}
          fg={borderColor}
          selectable={false}
        >
          {terminalGeometry.leftBorder}
        </Text>
        <Text width={terminalGeometry.contentWidth} flexShrink={0} fg={textColor} selectable={false}>
          {`${grip}${clippedTitle}${fill}`}
        </Text>
        {terminalGeometry.controls.toggle && (
          <TerminalPaneButton
            text={terminalGeometry.controls.toggle.text}
            fg={visuallyFocused ? colors.borderFocused : textColor}
            role="pane-float-toggle"
            onMouseDown={onFloatToggleMouseDown}
          />
        )}
        {terminalGeometry.controls.action && (
          <TerminalPaneButton
            text={terminalGeometry.controls.action.text}
            fg={textColor}
            role="pane-action"
            onMouseDown={onActionMouseDown}
          />
        )}
        {terminalGeometry.controls.close && (
          <TerminalPaneButton
            text={terminalGeometry.controls.close.text}
            fg={textColor}
            role="pane-close"
            onMouseDown={onCloseMouseDown}
          />
        )}
        <Text
          width={displayWidth(terminalGeometry.rightBorder)}
          flexShrink={0}
          fg={borderColor}
          selectable={false}
        >
          {terminalGeometry.rightBorder}
        </Text>
      </Box>
    );
  }

  const grip = truncateTitle(PANE_HEADER_GRIP, terminalGeometry.contentWidth);
  const titleWidth = Math.max(0, terminalGeometry.contentWidth - displayWidth(grip));
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
      <Text width={terminalGeometry.contentWidth} flexShrink={0} fg={textColor} selectable={false}>
        {`${grip}${clippedTitle}${padding}`}
      </Text>
      {terminalGeometry.controls.toggle && (
        <TerminalPaneButton
          text={terminalGeometry.controls.toggle.text}
          fg={textColor}
          role="pane-float-toggle"
          onMouseDown={onFloatToggleMouseDown}
        />
      )}
      {terminalGeometry.controls.action && (
        <TerminalPaneButton
          text={terminalGeometry.controls.action.text}
          fg={textColor}
          role="pane-action"
          onMouseDown={onActionMouseDown}
        />
      )}
    </Box>
  );
}
