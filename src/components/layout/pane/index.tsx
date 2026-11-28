import { Box, useUiCapabilities } from "../../../ui";
import type { ReactNode } from "react";
import { paneBg } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { PaneBodyFrame, getPaneWindowAttributes, type DockEdge } from "./frame";
import { PaneHeader, paneHeaderHoldsOneStrip, type PaneHeaderChromeProps } from "./header";
import { PaneHeaderTabsProvider, usePaneHeaderTabsHost } from "./header-tabs";
import { hasPaneFooterContent, PaneFooterBar, type CombinedPaneFooter } from "./footer";
import { paneHeaderRows, resolvePaneBodyFrame, shouldReservePaneFooter } from "./sizing";

interface PaneWrapperProps extends PaneHeaderChromeProps {
  paneId?: string;
  title?: string;
  focused: boolean;
  width?: number;
  height?: number | `${number}%` | "auto";
  /**
   * Desktop: fill the box it sits in instead of taking `width` and `height`,
   * so a box restyled by a drag (a divider) sizes the pane without a render.
   * `width` still fits the header and footer.
   */
  stretch?: boolean;
  flexGrow?: number;
  /** A dock divider line is drawn over the top row (the pane is below another). */
  topRule?: boolean;
  /** Desktop: the sides that face another docked pane across the gap between them. */
  dockEdges?: readonly DockEdge[];
  onMouseDown?: (event: any) => void;
  onMouseDownCapture?: (event: any) => void;
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
  stretch = false,
  flexGrow,
  topRule = false,
  dockEdges,
  stack,
  onMouseDown,
  onMouseDownCapture,
  footer,
  children,
  ...headerProps
}: PaneWrapperProps) {
  const { nativePaneChrome } = useUiCapabilities();
  // A header too narrow for its stack's tabs and the pane's own strip keeps
  // the stack's: the pane draws its strip in its body.
  const { headerTabs, contextValue: headerTabsContext } = usePaneHeaderTabsHost(
    nativePaneChrome === true && !!title && !paneHeaderHoldsOneStrip(stack, width),
  );
  // This frame can sit below a memoized layer. The body surface feeds canvas
  // charts too, so subscribe rather than reading the non-reactive facade.
  const colors = useThemeColors();
  const bg = paneBg(focused, colors);
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
      width={stretch ? "100%" : width}
      height={stretch ? "100%" : height}
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
        dockEdges,
      })}
      onMouseDown={onMouseDown}
      onMouseDownCapture={onMouseDownCapture}
    >
      {title && (
        <PaneHeader
          {...headerProps}
          title={title}
          width={width}
          focused={focused}
          windowModeSelected={windowModeSelected}
          tabs={headerTabs}
          stack={stack}
          bodyBackground={bg}
          topRule={topRule}
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
