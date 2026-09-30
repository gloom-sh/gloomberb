export {
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH,
  type FloatingRect,
} from "./floating";

export {
  findDockLeaf,
  getDockDividerLayouts,
  getDockedPaneIds,
  getDockLeafLayouts,
  getDockResizeTargets,
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
  type FloatingPaneVisibility,
} from "./gridlock";
export type {
  DropTarget,
  FloatingResizeCorner,
} from "./types";
