export {
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH,
  type FloatingRect,
} from "./pane-manager/floating";

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
} from "./pane-manager/dock-tree";

export {
  getLayoutPreview,
  getLeafRect,
  isPaneDetached,
  isPaneDocked,
  isPaneInLayout,
  resolveDocked,
  resolveFloating,
  type ResolvedPane,
} from "./pane-manager/queries";

export {
  addPaneFloating,
  bringToFront,
  detachPaneToFrame,
  floatAtRect,
  floatPane,
  getRememberedFloatingRect,
  moveFloatingPane,
  resizeFloatingPaneFromCorner,
} from "./pane-manager/floating-actions";

export {
  addPaneToLayout,
  applyDrop,
  dockPane,
  insertAtRootEdge,
  resizeSplitAtPath,
  simulateDrop,
  swapPanes,
} from "./pane-manager/docking";

export {
  removeFloatingPanes,
  removePane,
  removeUnavailablePaneTypes,
  type PaneTypeAvailability,
} from "./pane-manager/layout-state";
export {
  analyzeFloatingPaneVisibility,
  gridlockAllPanes,
  shouldShowTidyWindows,
  type FloatingPaneVisibility,
} from "./pane-manager/gridlock";
export type {
  DropTarget,
  FloatingResizeCorner,
} from "./pane-manager/types";
