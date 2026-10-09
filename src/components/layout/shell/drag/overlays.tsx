import { Box, useUiCapabilities } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import type { DockLeafLayout } from "../../../../layout/pane-manager";
import type { DragPreview } from "./index";
import { useLiveDrag, useLiveHoverOverlay, type LiveDragGeometry, type LiveDragStore } from "./live";
import { slideStyle } from "./slide";

/** A docked pane on the move is drawn as an outline at its floating size, until it is over a drop target. */
function DockedDragOutline({ live }: { live: LiveDragStore }) {
  const rect = useLiveDrag(live, selectDockedOutline);
  const { nativePaneChrome } = useUiCapabilities();
  if (!rect) return null;
  // The desktop slides it from the corner on the compositor; the terminal redraws it in place.
  const slide = nativePaneChrome === true;
  return (
    <Box
      position="absolute"
      left={slide ? 0 : rect.x}
      top={slide ? 0 : rect.y}
      style={slide ? slideStyle(rect.x, rect.y) : undefined}
      width={rect.width}
      height={rect.height}
      border
      borderStyle="single"
      borderColor={colors.borderFocused}
      backgroundColor={colors.panel}
      zIndex={95}
    />
  );
}

function selectDockedOutline(geometry: LiveDragGeometry) {
  const { paneDrag, floating } = geometry;
  return paneDrag?.mode === "docked" && floating?.paneId === paneDrag.paneId ? floating.rect : null;
}

const selectDockPreview = (geometry: LiveDragGeometry) => geometry.dockPreview;

export function ShellDragOverlays({
  dockLeafLayouts,
  externalDockPreview,
  live,
}: {
  dockLeafLayouts: DockLeafLayout[];
  /** A pane from another window over this one's edge. */
  externalDockPreview: DragPreview | null;
  live: LiveDragStore;
}) {
  const activeHoverOverlay = useLiveHoverOverlay(live, dockLeafLayouts);
  const dockPreview = useLiveDrag(live, selectDockPreview);
  const effectiveDockPreview = dockPreview ?? externalDockPreview;
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
            borderStyle="single"
            borderColor={active ? colors.borderFocused : colors.border}
            backgroundColor={active ? colors.header : colors.panel}
            zIndex={cell.position === "center" ? 98 : 97}
          />
        );
      })}

      {!effectiveDockPreview && <DockedDragOutline live={live} />}

      {effectiveDockPreview && (
        <Box
          position="absolute"
          left={effectiveDockPreview.rect.x}
          top={effectiveDockPreview.rect.y}
          width={effectiveDockPreview.rect.width}
          height={effectiveDockPreview.rect.height}
          border
          borderStyle="single"
          borderColor={colors.borderFocused}
          backgroundColor={colors.panel}
          zIndex={96}
        />
      )}
    </>
  );
}
