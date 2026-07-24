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
  | { kind: "leaf"; targetId: string; position: LeafDropPosition };

export type FloatingResizeCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "top"
  | "bottom"
  | "left"
  | "right";

export interface LayoutSimulation {
  layout: LayoutConfig;
  previewRect: LayoutBounds | null;
}
