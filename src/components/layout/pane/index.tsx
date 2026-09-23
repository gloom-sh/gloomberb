import { Box, useUiCapabilities } from "../../../ui";
import type { ReactNode } from "react";
import { paneBg } from "../../../theme/colors";
import { PaneBodyFrame, getPaneWindowAttributes } from "./frame";
import { PaneHeader, type PaneHeaderQuickSetting } from "./header";
import { PaneHeaderTabsProvider, usePaneHeaderTabsHost } from "./header-tabs";
import { hasPaneFooterContent, PaneFooterBar, type CombinedPaneFooter } from "./footer";
import { paneHeaderRows, resolvePaneBodyFrame, shouldReservePaneFooter } from "./sizing";

interface PaneWrapperProps {
  paneId?: string;
  title?: string;
  focused: boolean;
  windowModeSelected?: boolean;
  width?: number;
  height?: number | `${number}%` | "auto";
  flexGrow?: number;
  locked?: boolean;
  showActions?: boolean;
  quickSettings?: PaneHeaderQuickSetting[];
  /** A dock divider line is drawn over the top row (the pane is below another). */
  topRule?: boolean;
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
  locked = false,
  showActions = false,
  quickSettings,
  topRule = false,
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
  const { headerTabs, contextValue: headerTabsContext } = usePaneHeaderTabsHost(nativePaneChrome === true && !!title);
  const bg = paneBg(focused);
  const showFooter = hasPaneFooterContent(footer);
  const reserveFooter = !!title && shouldReservePaneFooter(nativePaneChrome, showFooter);
  const renderFooter = !!title && (reserveFooter || showFooter);
  const bodyFrame = resolvePaneBodyFrame({
    height: typeof height === "number" ? height : undefined,
    nativePaneChrome,
    footerVisible: renderFooter,
    reserveFooter,
    headerRows: title ? paneHeaderRows(nativePaneChrome) : 0,
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
          locked={locked}
          showActions={showActions}
          quickSettings={quickSettings}
          tabs={headerTabs}
          bodyBackground={bg}
          topRule={topRule}
          onHeaderMouseMove={onHeaderMouseMove}
          onHeaderMouseDown={onHeaderMouseDown}
          onHeaderMouseDrag={onHeaderMouseDrag}
          onHeaderMouseDragEnd={onHeaderMouseDragEnd}
          onHeaderContextMenu={onHeaderContextMenu}
          onActionMouseDown={onActionMouseDown}
        />
      )}
      <PaneBodyFrame layoutProps={bodyFrame.layoutProps} backgroundColor={bg}>
        <PaneHeaderTabsProvider value={headerTabsContext}>{children}</PaneHeaderTabsProvider>
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
