import { memo, Profiler, useCallback, type ReactNode } from "react";
import { useAppLanguage } from "../../../i18n/react";
import { isPerfTraceEnabled, recordPerfSample } from "../../../utils/perf-marks";
import { PaneInViewProvider } from "../../../state/app/activity";
import { PaneInstanceProvider } from "../../../state/app/context";
import { useThemeColors } from "../../../theme/theme-context";
import { PaneKeyboardScrollController } from "../../../state/pane-scroll-registry";
import type { PaneDef } from "../../../types/plugin";
import { Box } from "../../../ui";

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
  focused: boolean;
  width: number;
  height: number;
  /** False while the pane is covered on screen; its streams drop to the off-screen cadence. */
  inView?: boolean;
  onClose?: (paneId: string) => void;
}

export const PaneContent = memo(function PaneContent({
  component: Component,
  paneId,
  paneType,
  focused,
  width,
  height,
  inView = true,
  onClose,
}: PaneContentProps) {
  useAppLanguage();
  useThemeColors();
  const close = useCallback(() => {
    onClose?.(paneId);
  }, [onClose, paneId]);

  return (
    <PaneInstanceProvider paneId={paneId}>
      <PaneInViewProvider value={inView}>
        <PaneKeyboardScrollController paneId={paneId} focused={focused} />
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minWidth={0}
          minHeight={0}
          overflow="hidden"
          data-gloom-role="pane-content"
        >
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
        </Box>
      </PaneInViewProvider>
    </PaneInstanceProvider>
  );
});
