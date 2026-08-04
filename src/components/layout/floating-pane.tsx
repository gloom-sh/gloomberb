import { Box, Text, useUiCapabilities } from "../../ui";
import type { ReactNode } from "react";
import { colors, floatingPaneBg } from "../../theme/colors";
import { PaneBodyFrame, getPaneWindowAttributes } from "./pane/frame";
import { PaneHeader, type PaneHeaderQuickSetting } from "./pane/header";
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
  quickSettings?: PaneHeaderQuickSetting[];
  onMouseDown?: (event: any) => void;
  onMouseDownCapture?: (event: any) => void;
  onHeaderMouseMove?: (event: any) => void;
  onHeaderMouseDown?: (event: any) => void;
  onHeaderMouseDrag?: (event: any) => void;
  onHeaderMouseDragEnd?: (event: any) => void;
  onHeaderContextMenu?: (event: any) => void;
  onActionMouseDown?: (event: any) => void;
  onCloseMouseDown?: (event: any) => void;
  onResizeMouseDown?: (event: any) => void;
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
  quickSettings,
  onMouseDown,
  onMouseDownCapture,
  onHeaderMouseMove,
  onHeaderMouseDown,
  onHeaderMouseDrag,
  onHeaderMouseDragEnd,
  onHeaderContextMenu,
  onActionMouseDown,
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

  return (
    <Box
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
      onMouseDownCapture={onMouseDownCapture}
    >
      <PaneHeader
        title={title}
        width={width}
        focused={focused}
        windowModeSelected={windowModeSelected}
        floating
        showActions={showActions}
        quickSettings={quickSettings}
        onHeaderMouseMove={onHeaderMouseMove}
        onHeaderMouseDown={onHeaderMouseDown}
        onHeaderMouseDrag={onHeaderMouseDrag}
        onHeaderMouseDragEnd={onHeaderMouseDragEnd}
        onHeaderContextMenu={onHeaderContextMenu}
        onActionMouseDown={onActionMouseDown}
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
        <Box
          position="absolute"
          bottom={0}
          right={0}
          width={2}
          height={1}
          data-gloom-role="resize-handle"
          onMouseDown={onResizeMouseDown}
          onMouseDrag={onResizeMouseDrag}
          onMouseDragEnd={onResizeMouseDragEnd}
        />
      ) : (
        <Box position="absolute" bottom={0} right={0} width={2} height={1}>
          <Text fg={focused ? colors.borderFocused : colors.border} selectable={false}>{"─◢"}</Text>
        </Box>
      )}
    </Box>
  );
}
