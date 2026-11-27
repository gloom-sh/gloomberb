import { Box, Text, useUiCapabilities, type BoxRenderable } from "../../ui";
import type { ReactNode, RefObject } from "react";
import { colors, floatingPaneBg } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { PaneBodyFrame, getPaneWindowAttributes } from "./pane/frame";
import { PaneHeader, paneHeaderHoldsOneStrip, type PaneHeaderChromeProps } from "./pane/header";
import { PaneHeaderTabsProvider, usePaneHeaderTabsHost } from "./pane/header-tabs";
import { hasPaneFooterContent, PaneFooterBar, type CombinedPaneFooter } from "./pane/footer";
import { resolvePaneBodyFrame, shouldReservePaneFooter } from "./pane/sizing";

interface FloatingPaneWrapperProps extends PaneHeaderChromeProps {
  paneId?: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  /** Fully covered by windows above it: skip drawing, keep the tree mounted. */
  hidden?: boolean;
  focused: boolean;
  onMouseDown?: (event: any) => void;
  onMouseDownCapture?: (event: any) => void;
  onCloseMouseDown?: (event: any) => void;
  onResizeMouseDown?: (event: any) => void;
  onResizeMouseDrag?: (event: any) => void;
  onResizeMouseDragEnd?: (event: any) => void;
  footer?: CombinedPaneFooter | null;
  footerSupplement?: ReactNode;
  /** The pane's frame, which a desktop resize sizes outside React; its header, body and footer stretch with it. */
  frameRef?: RefObject<BoxRenderable | null>;
  children: ReactNode;
}

/**
 * The window's sides, between its title bar and footer, which draw the top
 * and bottom of the frame. Focused or not, so what is under the window never
 * runs into it; focus draws them in the focus colour, as it does the rest.
 */
function TerminalFloatingPaneBorder({ width, height, focused }: { width: number; height: number; focused: boolean }) {
  const borderWidth = Math.max(0, Math.floor(width));
  const borderHeight = Math.max(0, Math.floor(height));
  const bodyHeight = Math.max(0, borderHeight - 2);
  if (borderWidth < 2 || bodyHeight <= 0) return null;
  const color = focused ? colors.borderFocused : colors.border;

  return (
    <>
      <Box position="absolute" top={1} left={0} width={1} height={bodyHeight}>
        <Text fg={color} selectable={false}>{"│".repeat(bodyHeight)}</Text>
      </Box>
      <Box position="absolute" top={1} left={borderWidth - 1} width={1} height={bodyHeight}>
        <Text fg={color} selectable={false}>{"│".repeat(bodyHeight)}</Text>
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
  hidden = false,
  focused,
  windowModeSelected = false,
  onMouseDown,
  onMouseDownCapture,
  onCloseMouseDown,
  onResizeMouseDown,
  onResizeMouseDrag,
  onResizeMouseDragEnd,
  footer,
  footerSupplement,
  frameRef,
  stack = null,
  children,
  ...headerProps
}: FloatingPaneWrapperProps) {
  const { nativePaneChrome } = useUiCapabilities();
  // As a docked pane: a header too narrow for two strips keeps its stack's.
  const { headerTabs, contextValue: headerTabsContext } = usePaneHeaderTabsHost(
    nativePaneChrome === true && !paneHeaderHoldsOneStrip(stack, width),
  );
  const palette = useThemeColors();
  const bg = floatingPaneBg(focused, palette);
  const showFooter = hasPaneFooterContent(footer);
  const reserveFooter = shouldReservePaneFooter(nativePaneChrome, showFooter);
  const renderFooter = reserveFooter || showFooter;
  const bodyFrame = resolvePaneBodyFrame({ height, nativePaneChrome, footerVisible: renderFooter, reserveFooter });

  return (
    <Box
      ref={frameRef}
      position="absolute"
      top={y}
      left={x}
      width={width}
      height={height}
      zIndex={zIndex}
      visible={!hidden}
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
        {...headerProps}
        title={title}
        width={width}
        focused={focused}
        windowModeSelected={windowModeSelected}
        floating
        tabs={headerTabs}
        stack={stack}
        bodyBackground={bg}
        topRule
        onCloseMouseDown={onCloseMouseDown}
      />

      <PaneBodyFrame layoutProps={bodyFrame.layoutProps} backgroundColor={bg}>
        <PaneHeaderTabsProvider value={headerTabsContext}>{children}</PaneHeaderTabsProvider>
      </PaneBodyFrame>

      {footerSupplement}
      {renderFooter && (
        <PaneFooterBar
          footer={footer}
          focused={focused}
          width={width}
          reserveRight={2}
          showBorder={!nativePaneChrome && !focused}
        />
      )}

      {!nativePaneChrome && <TerminalFloatingPaneBorder width={width} height={height} focused={focused || windowModeSelected} />}

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
