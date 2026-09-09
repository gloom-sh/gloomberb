import { Box } from "../../../../ui";
import { colors, tokens } from "../../../../theme/colors";
import type { FloatingRect } from "../../../../plugins/pane-manager";
import type { DragPreview, HoverOverlay } from "./index";

export function ShellDragOverlays({
  activeHoverOverlay,
  activePaneDrag,
  dockPreview,
  dragFloatingRect,
  effectiveDockPreview,
}: {
  activeHoverOverlay: HoverOverlay | null;
  activePaneDrag: { paneId: string; mode: "docked" | "floating" } | null;
  dockPreview: DragPreview | null;
  dragFloatingRect: { paneId: string; rect: FloatingRect } | null;
  effectiveDockPreview: DragPreview | null;
}) {
  return (
    <>
      {activeHoverOverlay && activeHoverOverlay.cells.map((cell) => {
        const active = dockPreview?.kind === "dock"
          && dockPreview.target.kind === "leaf"
          && dockPreview.target.targetId === activeHoverOverlay.targetId
          && dockPreview.target.position === cell.position;
        return (
          <Box
            key={`cell:${activeHoverOverlay.targetId}:${cell.position}`}
            position="absolute"
            left={cell.rect.x}
            top={cell.rect.y}
            width={cell.rect.width}
            height={cell.rect.height}
            border
            borderStyle={tokens.pane.chrome.boxBorderStyle}
            borderColor={active ? colors.borderFocused : colors.border}
            backgroundColor={active ? colors.header : colors.panel}
            zIndex={cell.position === "center" ? 98 : 97}
          />
        );
      })}

      {activePaneDrag
        && activePaneDrag.mode === "docked"
        && dragFloatingRect?.paneId === activePaneDrag.paneId
        && !effectiveDockPreview
        && (
          <Box
            position="absolute"
            left={dragFloatingRect.rect.x}
            top={dragFloatingRect.rect.y}
            width={dragFloatingRect.rect.width}
            height={dragFloatingRect.rect.height}
            border
            borderStyle={tokens.pane.chrome.boxBorderStyle}
            borderColor={colors.borderFocused}
            backgroundColor={colors.panel}
            zIndex={95}
          />
        )}

      {effectiveDockPreview && (
        <Box
          position="absolute"
          left={effectiveDockPreview.rect.x}
          top={effectiveDockPreview.rect.y}
          width={effectiveDockPreview.rect.width}
          height={effectiveDockPreview.rect.height}
          border
          borderStyle={tokens.pane.chrome.boxBorderStyle}
          borderColor={colors.borderFocused}
          backgroundColor={colors.panel}
          zIndex={96}
        />
      )}
    </>
  );
}
