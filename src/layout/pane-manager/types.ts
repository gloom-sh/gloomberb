import type { LayoutConfig } from "../../types/config";
import type { LayoutBounds } from "./dock-tree";

export type LeafDropPosition =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "center"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type DropTarget =
  | { kind: "frame"; edge: "left" | "right" | "top" | "bottom" }
  /** Beside the spot `targetId` is in; "center" stacks onto it like `tab`. */
  | { kind: "leaf"; targetId: string; position: LeafDropPosition }
  /** A tab of the spot `targetId` is in, shown. */
  | { kind: "tab"; targetId: string };

export type FloatingResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface LayoutSimulation {
  layout: LayoutConfig;
  previewRect: LayoutBounds | null;
}
