/** @jsxImportSource react */
import type { ReactNode } from "react";
import { FloatingPaneWrapper } from "../../../components/layout/floating-pane";
import { PaneFooterProvider, hasPaneFooterContent } from "../../../components/layout/pane/footer";
import { resolvePaneBodyFrame } from "../../../components/layout/pane/sizing";

/** Static captures retain warnings and optional source status without action shortcuts. */
export function PaneShotFrame({ paneId, title, width, height, preserveStatus = false, children }: {
  paneId: string;
  title: string;
  width: number;
  height: number;
  preserveStatus?: boolean;
  children: (frame: ReturnType<typeof resolvePaneBodyFrame>) => ReactNode;
}) {
  return <PaneFooterProvider>{(registeredFooter) => {
    const footer = { info: registeredFooter.info.filter((segment) => preserveStatus || segment.icon === "warning"), hints: [], menu: [], keys: [] };
    const bodyFrame = resolvePaneBodyFrame({
      width,
      height,
      nativePaneChrome: true,
      footerVisible: hasPaneFooterContent(footer),
      reserveFooter: false,
    });
    return <FloatingPaneWrapper
      paneId={paneId}
      title={title}
      x={0}
      y={0}
      width={width}
      height={height}
      zIndex={1}
      focused
      showActions={false}
      footer={footer}
    >
      {children(bodyFrame)}
    </FloatingPaneWrapper>;
  }}</PaneFooterProvider>;
}
