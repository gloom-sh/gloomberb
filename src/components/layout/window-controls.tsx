import { Box, useRendererHost } from "../../ui";
import { useCallback } from "react";
import { t } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import { TITLEBAR_OVERLAY_HEIGHT_PX } from "./titlebar-overlay";

const WINDOWS_CONTROL_SIZE_PX = TITLEBAR_OVERLAY_HEIGHT_PX;
export const WINDOWS_CONTROL_GROUP_WIDTH_PX = WINDOWS_CONTROL_SIZE_PX * 3;

type WindowControlAction = "minimize" | "toggle-maximize" | "close";

const WINDOWS_CONTROLS: Array<{
  action: WindowControlAction;
  labelKey: string;
}> = [
  { action: "minimize", labelKey: "Minimize" },
  { action: "toggle-maximize", labelKey: "Maximize" },
  { action: "close", labelKey: "Close" },
];

function stopMouse(event: { stopPropagation?: () => void; preventDefault?: () => void }) {
  event.stopPropagation?.();
  event.preventDefault?.();
}

function WindowControlIcon({ action }: { action: WindowControlAction }) {
  if (action === "minimize") {
    return (
      <svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
        <path d="M2.5 6.5H9.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="square" />
      </svg>
    );
  }

  if (action === "toggle-maximize") {
    return (
      <svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
        <rect x="3" y="3" width="6" height="6" stroke="currentColor" strokeWidth="1.25" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
      <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The page covers the top of its window's frame, so the strip along its top
 * stands in for the frame's top edge: a press there resizes the window, and at
 * either end diagonally, as Windows does from a native frame.
 */
const TOP_EDGE_HEIGHT_PX = 4;
const TOP_CORNER_WIDTH_PX = 16;

type TopEdge = "top" | "top-left" | "top-right";

const TOP_EDGES: Array<{ edge: TopEdge; cursor: string; width?: number }> = [
  { edge: "top-left", cursor: "nwse-resize", width: TOP_CORNER_WIDTH_PX },
  { edge: "top", cursor: "ns-resize" },
  { edge: "top-right", cursor: "nesw-resize", width: TOP_CORNER_WIDTH_PX },
];

function WindowTopEdge() {
  const rendererHost = useRendererHost();
  const startResize = useCallback((edge: TopEdge, event: { stopPropagation?: () => void; preventDefault?: () => void }) => {
    stopMouse(event);
    void rendererHost.startWindowResize?.(edge);
  }, [rendererHost]);

  return (
    <Box
      flexDirection="row"
      data-gloom-role="window-top-edge"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: `${TOP_EDGE_HEIGHT_PX}px`,
        // Over the buttons too: a native frame's top edge runs above them.
        zIndex: 1001,
      }}
    >
      {TOP_EDGES.map(({ edge, cursor, width }) => (
        <Box
          key={edge}
          height="100%"
          flexGrow={width ? 0 : 1}
          flexShrink={0}
          width={width ? `${width}px` : undefined}
          data-window-edge={edge}
          style={{ cursor }}
          onMouseDown={(event: { stopPropagation?: () => void; preventDefault?: () => void }) => startResize(edge, event)}
        />
      ))}
    </Box>
  );
}

interface WindowControlsProps {
  windowKind?: "main" | "detached";
}

export function WindowControls({ windowKind = "main" }: WindowControlsProps) {
  useAppLanguage();
  const rendererHost = useRendererHost();

  const controlWindow = useCallback((action: WindowControlAction, event: { stopPropagation?: () => void; preventDefault?: () => void }) => {
    stopMouse(event);
    void rendererHost.controlWindow?.(action);
  }, [rendererHost]);

  return (
    <>
      <WindowTopEdge />
      <Box
        flexDirection="row"
        alignItems="stretch"
        flexShrink={0}
        width={`${WINDOWS_CONTROL_GROUP_WIDTH_PX}px`}
        data-gloom-role="window-controls"
        data-window-kind={windowKind}
        aria-hidden={false}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          // A popped-out window's title bar is its pane header, which ends in a
          // 1px rule; the buttons stop above it so the rule runs the full width.
          height: `${WINDOWS_CONTROL_SIZE_PX - (windowKind === "detached" ? 1 : 0)}px`,
          zIndex: 1000,
          backgroundColor: "inherit",
        }}
      >
        {WINDOWS_CONTROLS.map((control) => (
          <Box
            key={control.action}
            alignItems="center"
            justifyContent="center"
            flexShrink={0}
            width={`${WINDOWS_CONTROL_SIZE_PX}px`}
            height="100%"
            data-gloom-role="window-control"
            data-window-control-action={control.action}
            data-gloom-interactive="true"
            role="button"
            aria-label={t(control.labelKey)}
            title={t(control.labelKey)}
            onMouseDown={(event: { stopPropagation?: () => void; preventDefault?: () => void }) => controlWindow(control.action, event)}
          >
            <WindowControlIcon action={control.action} />
          </Box>
        ))}
      </Box>
    </>
  );
}
