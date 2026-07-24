import { Box, Text } from "../../../../ui";
import type {
  DockGeometryOptions,
  DockLeafLayout,
  FloatingRect,
  LayoutBounds,
  ResolvedPane,
} from "../../../../plugins/pane-manager";
import { colors } from "../../../../theme/colors";
import { constrainFloatingRectToBounds } from "../drag";
import {
  getFloatingResizeCornerPosition,
  type WindowEditDockMovePreview,
  windowEditHelpText,
  windowEditStatusLine,
} from "../../window-edit/presentation";
import type { WindowEditState } from "../../window-edit/mode";
import {
  NativeWindowEditStatus,
  resolveNativeFloatingResizeCornerRect,
} from "../../window-edit/status";
import { MENU_Z_INDEX, truncateMenuText } from "../menu";
import { ShellLayoutGridOverlay } from "../drag/overlays";

interface ShellWindowModeOverlaysProps {
  bounds: LayoutBounds;
  contentHeight: number;
  dockGeometryOptions: DockGeometryOptions;
  dockLeafLayouts: DockLeafLayout[];
  dragFloatingRect: { paneId: string; rect: FloatingRect } | null;
  focusedPaneId: string | null;
  getPaneTitle: (pane: ResolvedPane) => string;
  menuOpen: boolean;
  nativePaneChrome: boolean;
  nativeWindowModePanelRect: LayoutBounds | null;
  overlayOpen: boolean;
  paneMap: Map<string, ResolvedPane>;
  visibleFloatingPanes: Array<{ pane: ResolvedPane; rect: FloatingRect }>;
  width: number;
  windowMode: WindowEditState | null;
  windowModeDockMovePreview: WindowEditDockMovePreview | null;
}

function getHighlightedPaneId(windowMode: WindowEditState | null, focusedPaneId: string | null): string | null {
  if (windowMode?.mode === "move" && windowMode.focus.kind === "dock-move") {
    return windowMode.focus.targetId;
  }
  return windowMode?.paneId ?? focusedPaneId;
}

function windowModeBannerKey(windowMode: WindowEditState): string {
  const focusKey = windowMode.focus.kind === "dock-move"
    ? `${windowMode.focus.targetId}:${windowMode.focus.position}`
    : windowMode.focus.kind === "dock-resize"
      ? windowMode.focus.pathKey
      : windowMode.focus.kind === "floating-resize"
        ? windowMode.focus.corner
        : "move";
  return `window-mode-banner:${windowMode.paneId}:${windowMode.mode}:${windowMode.focus.kind}:${focusKey}:${windowMode.notice ?? ""}`;
}

export function ShellWindowModeOverlays({
  bounds,
  contentHeight,
  dockGeometryOptions,
  dockLeafLayouts,
  dragFloatingRect,
  focusedPaneId,
  getPaneTitle,
  menuOpen,
  nativePaneChrome,
  nativeWindowModePanelRect,
  overlayOpen,
  paneMap,
  visibleFloatingPanes,
  width,
  windowMode,
  windowModeDockMovePreview,
}: ShellWindowModeOverlaysProps) {
  const highlightedPaneId = getHighlightedPaneId(windowMode, focusedPaneId);
  const highlightedFloatingPane = highlightedPaneId
    ? visibleFloatingPanes.find((entry) => entry.pane.instance.instanceId === highlightedPaneId)
    : null;
  const highlightedDockedLeaf = highlightedPaneId && !highlightedFloatingPane
    ? dockLeafLayouts.find((leaf) => leaf.instanceId === highlightedPaneId)
    : null;
  const highlightedRect = highlightedFloatingPane
    ? dragFloatingRect?.paneId === highlightedFloatingPane.pane.instance.instanceId
      ? constrainFloatingRectToBounds(dragFloatingRect.rect, width, contentHeight)
      : highlightedFloatingPane.rect
    : highlightedDockedLeaf?.rect ?? null;
  const highlightedZIndex = highlightedFloatingPane
    ? (highlightedFloatingPane.pane.floating?.zIndex ?? 50) + 1
    : 3;
  const gridExcludedRows = [
    ...dockLeafLayouts.map((leaf) => leaf.rect.y),
    ...visibleFloatingPanes.map(({ pane, rect }) => (
      dragFloatingRect?.paneId === pane.instance.instanceId ? dragFloatingRect.rect.y : rect.y
    )),
  ];

  return (
    <>
      {windowMode && (
        <ShellLayoutGridOverlay width={width} height={contentHeight} excludedRows={gridExcludedRows} />
      )}

      {windowModeDockMovePreview && (
        <Box
          position="absolute"
          left={windowModeDockMovePreview.rect.x}
          top={windowModeDockMovePreview.rect.y}
          width={windowModeDockMovePreview.rect.width}
          height={windowModeDockMovePreview.rect.height}
          zIndex={MENU_Z_INDEX - 2}
          border
          borderStyle="single"
          borderColor={colors.borderFocused}
          backgroundColor={colors.panel}
          data-gloom-role="window-mode-drop-preview"
          data-target-id={windowModeDockMovePreview.targetId}
          data-position={windowModeDockMovePreview.position}
        />
      )}

      {highlightedPaneId && !nativePaneChrome && highlightedRect && highlightedRect.height >= 2 && (!overlayOpen || menuOpen) && (() => {
        const selectedInWindowMode = !!windowMode;
        const borderColor = selectedInWindowMode ? colors.borderFocused : colors.border;
        const bodyTop = highlightedRect.y + 1;
        const bodyHeight = selectedInWindowMode ? highlightedRect.height - 1 : highlightedRect.height - 2;
        const bottomWidth = Math.max(0, highlightedRect.width - 2);
        return (
          <>
            {bodyHeight > 0 && (
              <Box key={`focus-l:${highlightedPaneId}`} position="absolute" left={highlightedRect.x} top={bodyTop} width={1} height={bodyHeight} zIndex={highlightedZIndex} backgroundColor={borderColor} />
            )}
            {bodyHeight > 0 && (
              <Box key={`focus-r:${highlightedPaneId}`} position="absolute" left={highlightedRect.x + highlightedRect.width - 1} top={bodyTop} width={1} height={bodyHeight} zIndex={highlightedZIndex} backgroundColor={borderColor} />
            )}
            {selectedInWindowMode && bottomWidth > 0 && (
              <Box key={`focus-b:${highlightedPaneId}`} position="absolute" left={highlightedRect.x + 1} top={highlightedRect.y + highlightedRect.height - 1} width={bottomWidth} height={1} zIndex={highlightedZIndex} backgroundColor={borderColor}>
                <Text fg={borderColor} selectable={false}>{"─".repeat(bottomWidth)}</Text>
              </Box>
            )}
          </>
        );
      })()}

      {windowMode && !nativePaneChrome && windowMode.focus.kind === "floating-resize" && highlightedFloatingPane && (() => {
        const position = getFloatingResizeCornerPosition(highlightedFloatingPane.rect, windowMode.focus.corner);
        return (
          <Box
            position="absolute"
            left={position.x}
            top={position.y}
            width={1}
            height={1}
            zIndex={(highlightedFloatingPane.pane.floating?.zIndex ?? 50) + 2}
            backgroundColor={colors.borderFocused}
          >
            <Text fg={colors.bg} selectable={false}>{position.marker}</Text>
          </Box>
        );
      })()}

      {windowMode && !nativePaneChrome && (() => {
        const pane = paneMap.get(windowMode.paneId);
        const title = pane ? getPaneTitle(pane) : "Window";
        const targetPane = windowMode.focus.kind === "dock-move" ? paneMap.get(windowMode.focus.targetId) : undefined;
        const targetTitle = targetPane ? getPaneTitle(targetPane) : undefined;
        const text = `${windowEditStatusLine(windowMode, title, bounds, dockGeometryOptions, targetTitle)} · ${windowEditHelpText(windowMode)}`;
        const bannerWidth = Math.max(1, width);
        const bannerText = truncateMenuText(text, bannerWidth).padEnd(bannerWidth, " ");
        return (
          <Box
            key={windowModeBannerKey(windowMode)}
            position="absolute"
            left={0}
            top={0}
            width={bannerWidth}
            height={1}
            zIndex={MENU_Z_INDEX - 1}
            backgroundColor={colors.borderFocused}
          >
            <Text key={bannerText} fg={colors.bg} selectable={false}>
              {bannerText}
            </Text>
          </Box>
        );
      })()}

      {windowMode && nativePaneChrome && windowMode.focus.kind === "floating-resize" && highlightedFloatingPane && (() => {
        const cornerRect = resolveNativeFloatingResizeCornerRect(highlightedFloatingPane.rect, windowMode.focus.corner);
        return (
          <Box
            position="absolute"
            left={cornerRect.x}
            top={cornerRect.y}
            width={cornerRect.width}
            height={cornerRect.height}
            zIndex={(highlightedFloatingPane.pane.floating?.zIndex ?? 50) + 3}
            backgroundColor={colors.borderFocused}
            data-gloom-role="window-mode-corner"
            data-corner={windowMode.focus.corner}
          />
        );
      })()}

      {windowMode && nativePaneChrome && nativeWindowModePanelRect && (() => {
        const pane = paneMap.get(windowMode.paneId);
        const targetPane = windowMode.focus.kind === "dock-move" ? paneMap.get(windowMode.focus.targetId) : undefined;
        return (
          <NativeWindowEditStatus
            mode={windowMode}
            title={pane ? getPaneTitle(pane) : "Window"}
            rect={nativeWindowModePanelRect}
            bounds={bounds}
            dockGeometryOptions={dockGeometryOptions}
            targetTitle={targetPane ? getPaneTitle(targetPane) : undefined}
            zIndex={MENU_Z_INDEX - 1}
          />
        );
      })()}
    </>
  );
}
