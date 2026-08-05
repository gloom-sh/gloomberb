import type { CSSProperties } from "react";
import { TextAttributes, type TextProps } from "../../../../ui/host";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../input-host";

export function cellWidth(value: unknown): CSSProperties["width"] {
  if (typeof value === "number") return `${value * WEB_CELL_WIDTH}px`;
  return value as CSSProperties["width"];
}

export function cellHeight(value: unknown): CSSProperties["height"] {
  if (typeof value === "number") return `${value * WEB_CELL_HEIGHT}px`;
  return value as CSSProperties["height"];
}

function cellInset(value: unknown, axis: "x" | "y"): CSSProperties["paddingLeft"] {
  if (typeof value === "number") return `${value * (axis === "x" ? WEB_CELL_WIDTH : WEB_CELL_HEIGHT)}px`;
  return value as CSSProperties["paddingLeft"];
}

export function commonStyle(props: Record<string, unknown>): CSSProperties {
  const hasFixedInlineSize = props.width != null || props.flexBasis != null;
  const hasFixedBlockSize = props.height != null;
  const gapUnit = props.flexDirection === "row" ? WEB_CELL_WIDTH : WEB_CELL_HEIGHT;
  const zeroMinInlineSize = props.minWidth == null && allowsZeroMinSize(props, "inline");
  const zeroMinBlockSize = props.minHeight == null && allowsZeroMinSize(props, "block");
  return {
    color: typeof props.fg === "string" ? props.fg : undefined,
    backgroundColor: typeof props.bg === "string" ? props.bg : typeof props.backgroundColor === "string" ? props.backgroundColor : undefined,
    display: "flex",
    flexDirection: props.flexDirection === "row" ? "row" : "column",
    flexGrow: typeof props.flexGrow === "number" ? props.flexGrow : undefined,
    flexShrink: typeof props.flexShrink === "number" ? props.flexShrink : hasFixedInlineSize || hasFixedBlockSize ? 0 : undefined,
    flexBasis: cellWidth(props.flexBasis),
    flexWrap: props.flexWrap === "wrap" ? "wrap" : undefined,
    alignItems: props.alignItems as CSSProperties["alignItems"],
    justifyContent: props.justifyContent as CSSProperties["justifyContent"],
    position: props.position as CSSProperties["position"],
    left: cellWidth(props.left),
    right: cellWidth(props.right),
    top: cellHeight(props.top),
    bottom: cellHeight(props.bottom),
    zIndex: typeof props.zIndex === "number" ? props.zIndex : undefined,
    width: cellWidth(props.width),
    height: cellHeight(props.height),
    minWidth: cellWidth(props.minWidth),
    minHeight: cellHeight(props.minHeight),
    maxWidth: cellWidth(props.maxWidth),
    maxHeight: cellHeight(props.maxHeight),
    paddingLeft: cellInset(props.paddingLeft ?? props.paddingX ?? props.padding, "x"),
    paddingRight: cellInset(props.paddingRight ?? props.paddingX ?? props.padding, "x"),
    paddingTop: cellInset(props.paddingTop ?? props.paddingY ?? props.padding, "y"),
    paddingBottom: cellInset(props.paddingBottom ?? props.paddingY ?? props.padding, "y"),
    marginLeft: cellInset(props.marginLeft ?? props.marginX ?? props.margin, "x"),
    marginRight: cellInset(props.marginRight ?? props.marginX ?? props.margin, "x"),
    marginTop: cellInset(props.marginTop ?? props.marginY ?? props.margin, "y"),
    marginBottom: cellInset(props.marginBottom ?? props.marginY ?? props.margin, "y"),
    gap: typeof props.gap === "number" ? `${props.gap * gapUnit}px` : props.gap as CSSProperties["gap"],
    overflow: props.overflow as CSSProperties["overflow"],
    border: props.border ? `1px solid ${typeof props.borderColor === "string" ? props.borderColor : "var(--gloom-border)"}` : undefined,
    boxSizing: "border-box",
    minInlineSize: zeroMinInlineSize ? 0 : undefined,
    minBlockSize: zeroMinBlockSize ? 0 : undefined,
  };
}

export function textStyle(props: TextProps): CSSProperties {
  const attributes = props.attributes;
  const shouldWrap = props.wrapText || props.wrapMode === "word" || props.wrapMode === "char";
  return {
    color: props.fg,
    backgroundColor: props.bg,
    display: "inline-block",
    lineHeight: "var(--cell-h)",
    fontWeight: props.bold || hasAttribute(attributes, TextAttributes.BOLD) ? 700 : undefined,
    fontStyle: props.italic || hasAttribute(attributes, TextAttributes.ITALIC) ? "italic" : undefined,
    textDecoration: [
      props.underline || hasAttribute(attributes, TextAttributes.UNDERLINE) ? "underline" : "",
      props.strikethrough || hasAttribute(attributes, TextAttributes.STRIKETHROUGH) ? "line-through" : "",
    ].filter(Boolean).join(" ") || undefined,
    opacity: props.dim || hasAttribute(attributes, TextAttributes.DIM) ? 0.65 : undefined,
    filter: props.inverse || hasAttribute(attributes, TextAttributes.INVERSE) ? "invert(1)" : undefined,
    whiteSpace: shouldWrap ? "pre-wrap" : "pre",
    overflowWrap: shouldWrap ? "break-word" : undefined,
    overflow: "visible",
    textOverflow: "clip",
    width: cellWidth(props.width),
    maxWidth: cellWidth(props.maxWidth),
    minWidth: cellWidth(props.minWidth) ?? 0,
    flexShrink: shouldWrap ? 1 : 0,
  };
}

export function cleanDomProps(props: Record<string, unknown>): Record<string, unknown> {
  const next = { ...props };
  for (const key of [
    "fg", "bg", "backgroundColor", "flexDirection", "flexGrow", "flexShrink", "flexBasis", "flexWrap",
    "alignItems", "justifyContent",
    "padding", "paddingX", "paddingY", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
    "margin", "marginX", "marginY", "marginLeft", "marginRight", "marginTop", "marginBottom",
    "bold", "underline", "inverse", "dim", "italic", "strikethrough", "attributes", "content", "position", "left", "right", "top", "bottom",
    "zIndex", "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight", "gap",
    "border", "borderStyle", "borderColor", "overflow", "selectable", "visible", "name", "color",
    "focused", "focusedBackgroundColor", "textColor", "focusedTextColor", "placeholderColor",
    "cursorColor", "selectionBg", "selectionFg", "showCursor", "keyBindings", "wrapText", "wrapMode",
    "initialValue", "value", "onInput", "onChange", "onSubmit", "onEscape", "onCursorChange", "onMouse",
    "scrollX", "scrollY", "focusable", "bitmap", "bitmaps", "crosshair", "vectors", "text", "font",
    "hoverBackgroundColor",
  ]) {
    delete next[key];
  }
  for (const key of Object.keys(next)) {
    if (key.startsWith("onMouse")) delete next[key];
  }
  return next;
}

function allowsZeroMinSize(props: Record<string, unknown>, axis: "inline" | "block"): boolean {
  if (props.overflow === "hidden" || props.overflow === "clip") return true;
  if (typeof props.flexShrink === "number" && props.flexShrink > 0) return true;
  return axis === "inline" ? props.scrollX === true : props.scrollY === true;
}

function hasAttribute(attributes: unknown, flag: number): boolean {
  return typeof attributes === "number" && (attributes & flag) !== 0;
}
