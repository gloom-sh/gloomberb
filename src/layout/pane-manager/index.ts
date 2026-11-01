export {
  compactFloatingZ,
  FLOATING_PANE_MAX_Z,
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH,
  SHELL_DRAG_Z,
  type FloatingRect,
} from "./floating";

export {
  findDockLeaf,
  getDockDividerLayouts,
  getDockedPaneIds,
  getDockLeafLayouts,
  getDockResizeTargets,
  getDockSplitGeometry,
  showDockTab,
  type DockDividerLayout,
  type DockGeometryOptions,
  type DockLeafLayout,
  type DockResizeTarget,
  type LayoutBounds,
} from "./dock-tree";

export {
  getLayoutPreview,
  getLeafRect,
  isPaneDetached,
  isPaneDocked,
  isPaneInLayout,
  resolveDocked,
  resolveFloating,
  type ResolvedPane,
} from "./queries";

export {
  addPaneFloating,
  bringToFront,
  detachPaneToFrame,
  floatAtRect,
  floatPane,
  getRememberedFloatingRect,
  moveFloatingPane,
  resizeFloatingPaneFromCorner,
} from "./floating-actions";

export {
  addPaneToLayout,
  applyDrop,
  dockPane,
  insertAtRootEdge,
  resizeSplitAtPath,
  simulateDrop,
  swapPanes,
} from "./docking";

export { restoreHiddenPanes } from "./hidden-panes";
export {
  removeFloatingPanes,
  removePane,
  removeUnavailablePaneTypes,
  type PaneTypeAvailability,
} from "./layout-state";
export {
  analyzeFloatingPaneVisibility,
  gridlockAllPanes,
  shouldShowTidyWindows,
  tidyWindows,
} from "./gridlock";
export type {
  DropTarget,
  FloatingResizeCorner,
} from "./types";
