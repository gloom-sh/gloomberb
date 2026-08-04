import { Box, useUiCapabilities } from "../../../ui";
import type { ReactNode } from "react";
import { paneBg } from "../../../theme/colors";
import { PaneBodyFrame, getPaneWindowAttributes } from "./frame";
import { PaneHeader, type PaneHeaderQuickSetting } from "./header";
import { hasPaneFooterContent, PaneFooterBar, type CombinedPaneFooter } from "./footer";
import { resolvePaneBodyFrame, shouldReservePaneFooter } from "./sizing";

interface PaneWrapperProps {
  paneId?: string;
  title?: string;
  focused: boolean;
  windowModeSelected?: boolean;
  width?: number;
  height?: number | `${number}%` | "auto";
  flexGrow?: number;
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
  footer?: CombinedPaneFooter | null;
  children: ReactNode;
}

export function PaneWrapper({
  paneId,
  title,
  focused,
  windowModeSelected = false,
  width = 0,
  height,
  flexGrow,
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
  footer,
  children,
}: PaneWrapperProps) {
  const { nativePaneChrome } = useUiCapabilities();
  const bg = paneBg(focused);
  const showFooter = hasPaneFooterContent(footer);
  const reserveFooter = !!title && shouldReservePaneFooter(nativePaneChrome, showFooter);
  const renderFooter = !!title && (reserveFooter || showFooter);
  const bodyFrame = resolvePaneBodyFrame({
    height: typeof height === "number" ? height : undefined,
    nativePaneChrome,
    footerVisible: renderFooter,
    reserveFooter,
    headerRows: title ? 1 : 0,
  });

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      flexGrow={flexGrow}
      backgroundColor={bg}
      overflow="hidden"
      {...getPaneWindowAttributes({
        enabled: nativePaneChrome,
        role: "pane-window",
        paneId,
        floating: false,
        focused,
        windowModeSelected,
        showBorderColor: true,
      })}
      onMouseDown={onMouseDown}
      onMouseDownCapture={onMouseDownCapture}
    >
      {title && (
        <PaneHeader
          title={title}
          width={width}
          focused={focused}
          windowModeSelected={windowModeSelected}
          showActions={showActions}
          quickSettings={quickSettings}
          onHeaderMouseMove={onHeaderMouseMove}
          onHeaderMouseDown={onHeaderMouseDown}
          onHeaderMouseDrag={onHeaderMouseDrag}
          onHeaderMouseDragEnd={onHeaderMouseDragEnd}
          onHeaderContextMenu={onHeaderContextMenu}
          onActionMouseDown={onActionMouseDown}
        />
      )}
      <PaneBodyFrame layoutProps={bodyFrame.layoutProps} backgroundColor={bg}>
        {children}
      </PaneBodyFrame>
      {renderFooter && (
        <PaneFooterBar
          footer={footer}
          focused={focused}
          width={typeof width === "number" ? width : undefined}
        />
      )}
    </Box>
  );
}
