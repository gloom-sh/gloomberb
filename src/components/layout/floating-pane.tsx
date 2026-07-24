import { Box, Text, useUiCapabilities } from "../../ui";
import type { ReactNode } from "react";
import { colors, floatingPaneBg } from "../../theme/colors";
import type { FloatingResizeCorner } from "../../plugins/pane-manager";
import { PaneBodyFrame, getPaneWindowAttributes } from "./pane/frame";
import { PaneHeader } from "./pane/header";
import { hasPaneFooterContent, PaneFooterBar, type CombinedPaneFooter } from "./pane/footer";
import { resolvePaneBodyFrame, shouldReservePaneFooter } from "./pane/sizing";

interface FloatingPaneWrapperProps {
  paneId?: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  focused: boolean;
  windowModeSelected?: boolean;
  showActions?: boolean;
  onMouseDown?: (event: any) => void;
  onHeaderMouseMove?: (event: any) => void;
  onHeaderMouseDown?: (event: any) => void;
  onHeaderMouseDrag?: (event: any) => void;
  onHeaderMouseDragEnd?: (event: any) => void;
  onHeaderContextMenu?: (event: any) => void;
  onActionMouseDown?: (event: any) => void;
  onFloatToggleMouseDown?: (event: any) => void;
  onCloseMouseDown?: (event: any) => void;
  onResizeMouseDown?: (corner: FloatingResizeCorner, event: any) => void;
  onResizeMouseDrag?: (event: any) => void;
  onResizeMouseDragEnd?: (event: any) => void;
  footer?: CombinedPaneFooter | null;
  children: ReactNode;
}

function TerminalFloatingPaneBorder({ width, height }: { width: number; height: number }) {
  const borderWidth = Math.max(0, Math.floor(width));
  const borderHeight = Math.max(0, Math.floor(height));
  const bodyHeight = Math.max(0, borderHeight - 2);
  if (borderWidth < 2 || bodyHeight <= 0) return null;

  return (
    <>
      <Box position="absolute" top={1} left={0} width={1} height={bodyHeight}>
        <Text fg={colors.border} selectable={false}>{"│".repeat(bodyHeight)}</Text>
      </Box>
      <Box position="absolute" top={1} left={borderWidth - 1} width={1} height={bodyHeight}>
        <Text fg={colors.border} selectable={false}>{"│".repeat(bodyHeight)}</Text>
      </Box>
    </>
  );
}

/** Pure visual wrapper; Shell owns the interaction state and supplies handlers. */
export function FloatingPaneWrapper({
  paneId,
  title,
  x,
  y,
  width,
  height,
  zIndex,
  focused,
  windowModeSelected = false,
  showActions = false,
  onMouseDown,
  onHeaderMouseMove,
  onHeaderMouseDown,
  onHeaderMouseDrag,
  onHeaderMouseDragEnd,
  onHeaderContextMenu,
  onActionMouseDown,
  onFloatToggleMouseDown,
  onCloseMouseDown,
  onResizeMouseDown,
  onResizeMouseDrag,
  onResizeMouseDragEnd,
  footer,
  children,
}: FloatingPaneWrapperProps) {
  const { nativePaneChrome } = useUiCapabilities();
  const bg = floatingPaneBg(focused);
  const showFooter = hasPaneFooterContent(footer);
  const reserveFooter = shouldReservePaneFooter(nativePaneChrome, showFooter);
  const renderFooter = reserveFooter || showFooter;
  const bodyFrame = resolvePaneBodyFrame({ height, nativePaneChrome, footerVisible: renderFooter, reserveFooter });
  const topResizeWidth = Math.min(4, Math.max(0, width - 4));
  const topResizeLeft = Math.max(2, Math.floor((width - topResizeWidth) / 2));

  return (
    <Box
      id={`floating-pane:${paneId}`}
      position="absolute"
      top={y}
      left={x}
      width={width}
      height={height}
      zIndex={zIndex}
      backgroundColor={bg}
      flexDirection="column"
      overflow="hidden"
      {...getPaneWindowAttributes({
        enabled: nativePaneChrome,
        role: "pane-window",
        paneId,
        floating: true,
        focused,
        windowModeSelected,
        showBorderColor: true,
      })}
      onMouseDown={onMouseDown}
    >
      <PaneHeader
        title={title}
        width={width}
        focused={focused}
        windowModeSelected={windowModeSelected}
        floating
        showActions={showActions}
        onHeaderMouseMove={onHeaderMouseMove}
        onHeaderMouseDown={onHeaderMouseDown}
        onHeaderMouseDrag={onHeaderMouseDrag}
        onHeaderMouseDragEnd={onHeaderMouseDragEnd}
        onHeaderContextMenu={onHeaderContextMenu}
        onActionMouseDown={onActionMouseDown}
        onFloatToggleMouseDown={onFloatToggleMouseDown}
        onCloseMouseDown={onCloseMouseDown}
      />

      <PaneBodyFrame layoutProps={bodyFrame.layoutProps} backgroundColor={bg}>
        {children}
      </PaneBodyFrame>

      {renderFooter && (
        <PaneFooterBar
          footer={footer}
          focused={focused}
          width={width}
          reserveRight={2}
          showBorder={!nativePaneChrome && !focused}
        />
      )}

      {!nativePaneChrome && !focused && <TerminalFloatingPaneBorder width={width} height={height} />}

      {nativePaneChrome ? (
        <>
          <Box
            position="absolute"
            top={0}
            left={0}
            width={2}
            height={1}
            data-gloom-role="resize-handle"
            data-corner="top-left"
            onMouseDown={(event: any) => onResizeMouseDown?.("top-left", event)}
            onMouseDrag={onResizeMouseDrag}
            onMouseDragEnd={onResizeMouseDragEnd}
          />
          <Box
            position="absolute"
            top={0}
            right={0}
            width={2}
            height={1}
            data-gloom-role="resize-handle"
            data-corner="top-right"
            onMouseDown={(event: any) => onResizeMouseDown?.("top-right", event)}
            onMouseDrag={onResizeMouseDrag}
            onMouseDragEnd={onResizeMouseDragEnd}
          />
          <Box
            position="absolute"
            top={0}
            left={topResizeLeft}
            width={topResizeWidth}
            height={1}
            zIndex={1}
            data-gloom-role="resize-handle"
            data-corner="top"
            onMouseDown={(event: any) => onResizeMouseDown?.("top", event)}
            onMouseDrag={onResizeMouseDrag}
            onMouseDragEnd={onResizeMouseDragEnd}
          />
          <Box
            position="absolute"
            top={1}
            left={0}
            width={1}
            height={Math.max(0, height - 2)}
            data-gloom-role="resize-handle"
            data-corner="left"
            onMouseDown={(event: any) => onResizeMouseDown?.("left", event)}
            onMouseDrag={onResizeMouseDrag}
            onMouseDragEnd={onResizeMouseDragEnd}
          />
          <Box
            position="absolute"
            top={1}
            right={0}
            width={1}
            height={Math.max(0, height - 2)}
            data-gloom-role="resize-handle"
            data-corner="right"
            onMouseDown={(event: any) => onResizeMouseDown?.("right", event)}
            onMouseDrag={onResizeMouseDrag}
            onMouseDragEnd={onResizeMouseDragEnd}
          />
          <Box
            position="absolute"
            bottom={0}
            left={0}
            width={2}
            height={1}
            data-gloom-role="resize-handle"
            data-corner="bottom-left"
            onMouseDown={(event: any) => onResizeMouseDown?.("bottom-left", event)}
            onMouseDrag={onResizeMouseDrag}
            onMouseDragEnd={onResizeMouseDragEnd}
          />
          <Box
            position="absolute"
            bottom={0}
            left={2}
            width={Math.max(0, width - 4)}
            height={1}
            data-gloom-role="resize-handle"
            data-corner="bottom"
            onMouseDown={(event: any) => onResizeMouseDown?.("bottom", event)}
            onMouseDrag={onResizeMouseDrag}
            onMouseDragEnd={onResizeMouseDragEnd}
          />
          <Box
            position="absolute"
            bottom={0}
            right={0}
            width={2}
            height={1}
            data-gloom-role="resize-handle"
            data-corner="bottom-right"
            onMouseDown={(event: any) => onResizeMouseDown?.("bottom-right", event)}
            onMouseDrag={onResizeMouseDrag}
            onMouseDragEnd={onResizeMouseDragEnd}
          />
        </>
      ) : (
        <Box position="absolute" bottom={0} right={0} width={2} height={1}>
          <Text fg={focused ? colors.borderFocused : colors.border} selectable={false}>{"─◢"}</Text>
        </Box>
      )}
    </Box>
  );
}
