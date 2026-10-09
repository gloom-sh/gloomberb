import { memo, Profiler, useCallback, useMemo, type ReactNode } from "react";
import { useAppLanguage } from "../../../i18n/react";
import { isPerfTraceEnabled, recordPerfSample } from "../../../utils/perf-marks";
import { PaneInViewProvider } from "../../../state/app/activity";
import { PaneInstanceProvider } from "../../../state/app/context";
import { useThemeColors } from "../../../theme/theme-context";
import { PaneKeyboardScrollController } from "../../../state/pane-scroll-registry";
import type { PaneDef } from "../../../types/plugin";
import { Box } from "../../../ui";
import { PaneErrorBoundary } from "./error-boundary";

// Under GLOOMBERB_PERF_TRACE every pane commit is reported by pane, which is
// how a store update that fans out to the whole layout gets attributed. The
// Profiler is inert in production builds and absent from the tree otherwise.
function PaneRenderTrace({ paneId, paneType, children }: { paneId: string; paneType: string; children: ReactNode }) {
  if (!isPerfTraceEnabled()) return children;
  return (
    <Profiler
      id={paneId}
      onRender={(_id, phase, actualDuration) => {
        recordPerfSample("pane.render", actualDuration, { paneId, paneType, phase });
      }}
    >
      {children}
    </Profiler>
  );
}

interface PaneContentProps {
  component: PaneDef["component"];
  paneId: string;
  paneType: string;
  /** The header's title, named by the failure card when the pane throws. */
  title: string;
  focused: boolean;
  width: number;
  height: number;
  /** False while the pane is covered on screen; its streams drop to the off-screen cadence. */
  inView?: boolean;
  /** Passed to the pane as `close` (floating panes). */
  onClose?: (paneId: string) => void;
  /** Takes the pane out of its layout; the failure card offers it. Keep it stable: the content is memoized. */
  closePane?: (paneId: string) => void;
  /**
   * Desktop: lays the content out at `width` by `height` instead of filling
   * the pane, while a resize sizes the pane's frame ahead of it. The content,
   * and whatever measures it, then lays out again only when it renders at a
   * new size.
   */
  pinned?: boolean;
}

export const PaneContent = memo(function PaneContent({
  component: Component,
  paneId,
  paneType,
  title,
  focused,
  width,
  height,
  inView = true,
  onClose,
  closePane,
  pinned = false,
}: PaneContentProps) {
  // The pane reads text and colors while it renders, so either redraws it.
  const language = useAppLanguage();
  const theme = useThemeColors();
  const close = useCallback(() => {
    onClose?.(paneId);
  }, [onClose, paneId]);
  const closeFailedPane = useCallback(() => {
    closePane?.(paneId);
  }, [closePane, paneId]);
  // Built again only when what the pane is given changes: pinning or
  // unpinning the content box does not render the pane.
  const body = useMemo(() => (
    <PaneErrorBoundary paneType={paneType} title={title} onClose={closePane ? closeFailedPane : undefined}>
      <PaneRenderTrace paneId={paneId} paneType={paneType}>
        <Component
          paneId={paneId}
          paneType={paneType}
          focused={focused}
          width={width}
          height={height}
          close={onClose ? close : undefined}
        />
      </PaneRenderTrace>
    </PaneErrorBoundary>
  ), [Component, close, closeFailedPane, closePane, focused, height, language, onClose, paneId, paneType, theme, title, width]);

  return (
    <PaneInstanceProvider paneId={paneId}>
      <PaneInViewProvider value={inView}>
        <PaneKeyboardScrollController paneId={paneId} focused={focused} />
        <Box
          flexDirection="column"
          {...(pinned
            ? { width, height, flexGrow: 0, flexShrink: 0 }
            : { flexGrow: 1, flexShrink: 1, flexBasis: 0 })}
          minWidth={0}
          minHeight={0}
          overflow="hidden"
          data-gloom-role="pane-content"
        >
          {body}
        </Box>
      </PaneInViewProvider>
    </PaneInstanceProvider>
  );
});
