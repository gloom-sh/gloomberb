/// <reference lib="dom" />

import {
  cssUrl,
  imageLayerRect,
  objectFitRect,
  parseBoxShadows,
  parseLinearGradient,
  splitTopLevel,
  type Box,
} from "./dom-screenshot-css";
import { contentBox, prepareImages, type PreparedImages } from "./dom-screenshot-rasters";
import { isScreenshotWatermarkVisible, setScreenshotWatermarkVisible } from "./screenshot-watermark";
import type { CapturePane } from "../remote/pane-screenshot";

export interface PngScreenshot {
  pngBase64: string;
  width: number;
  height: number;
}

interface CaptureOrigin {
  left: number;
  top: number;
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function findPaneScreenshotTarget(paneId?: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  if (paneId) {
    const escapedPaneId = escapeAttributeValue(paneId);
    const target = document.querySelector<HTMLElement>(`[data-gloom-pane-id="${escapedPaneId}"]`);
    if (target) return target;
  }
  return document.querySelector<HTMLElement>(
    "[data-gloom-role='pane-window'][data-focused='true'], [data-gloom-role='detached-pane-window'][data-focused='true']",
  );
}

function isVisible(style: CSSStyleDeclaration): boolean {
  return style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.opacity || "1") > 0;
}

function isPaintableColor(value: string): boolean {
  return value !== "" && value !== "transparent" && !/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(value);
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function localRect(rect: DOMRect, origin: CaptureOrigin) {
  return {
    x: rect.left - origin.left,
    y: rect.top - origin.top,
    width: rect.width,
    height: rect.height,
  };
}

type LocalRect = ReturnType<typeof localRect>;

/** Adds a rounded rectangle to the current path, as one closed subpath. */
function addRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  addRoundedRect(context, x, y, width, height, radius);
}

function fillBackground(
  context: CanvasRenderingContext2D,
  style: CSSStyleDeclaration,
  rect: ReturnType<typeof localRect>,
): void {
  if (!isPaintableColor(style.backgroundColor)) return;
  context.fillStyle = style.backgroundColor;
  roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, px(style.borderTopLeftRadius));
  context.fill();
}

const BORDER_SIDES = ["top", "right", "bottom", "left"] as const;

interface BorderSide {
  width: number;
  color: string;
}

function borderSides(style: CSSStyleDeclaration): (BorderSide | null)[] {
  return BORDER_SIDES.map((side) => {
    const lineStyle = style.getPropertyValue(`border-${side}-style`);
    const width = px(style.getPropertyValue(`border-${side}-width`));
    const color = style.getPropertyValue(`border-${side}-color`);
    return lineStyle === "none" || lineStyle === "hidden" || width <= 0 || !isPaintableColor(color)
      ? null
      : { width, color };
  });
}

/** The border box less its borders, where backgrounds are placed and inset shadows fall. */
function paddingBox(rect: LocalRect, style: CSSStyleDeclaration): Box {
  // Computed widths: zero for no border, and still taken by a transparent one.
  const [top, right, bottom, left] = BORDER_SIDES.map((side) => px(style.getPropertyValue(`border-${side}-width`)));
  return {
    x: rect.x + left!,
    y: rect.y + top!,
    width: Math.max(0, rect.width - left! - right!),
    height: Math.max(0, rect.height - top! - bottom!),
  };
}

/**
 * One CSS image layer (a `url()` image or a linear gradient) at its size and
 * position in `area`. False when it cannot be painted.
 */
function paintImageLayer(
  context: CanvasRenderingContext2D,
  layer: string,
  area: Box,
  size: string,
  position: string,
  urls: PreparedImages["urls"],
): boolean {
  const url = cssUrl(layer);
  if (url) {
    const image = urls.get(url);
    if (!image) return false;
    const target = imageLayerRect(area, { width: image.naturalWidth, height: image.naturalHeight }, size, position);
    context.drawImage(image, target.x, target.y, target.width, target.height);
    return true;
  }
  const tile = imageLayerRect(area, area, size === "contain" || size === "cover" ? "auto" : size, position);
  const gradient = parseLinearGradient(layer, tile.width, tile.height);
  if (!gradient) return false;
  try {
    const fill = context.createLinearGradient(
      tile.x + gradient.x0,
      tile.y + gradient.y0,
      tile.x + gradient.x1,
      tile.y + gradient.y1,
    );
    for (const stop of gradient.stops) fill.addColorStop(stop.offset, stop.color);
    context.fillStyle = fill;
  } catch {
    // A stop colour the canvas cannot read.
    return false;
  }
  context.fillRect(tile.x, tile.y, tile.width, tile.height);
  return true;
}

/** Layer `index` of a comma-separated list that repeats when shorter, as CSS reads it. */
function layerValue(list: string[], index: number, fallback: string): string {
  return list.length > 0 ? list[index % list.length]! : fallback;
}

/** Background images and gradients over the background colour, the last layer lowest. */
function paintBackgroundImages(
  context: CanvasRenderingContext2D,
  style: CSSStyleDeclaration,
  rect: LocalRect,
  urls: PreparedImages["urls"],
): void {
  const value = style.backgroundImage;
  if (!value || value === "none") return;
  const layers = splitTopLevel(value, ",");
  const sizes = splitTopLevel(style.backgroundSize, ",");
  const positions = splitTopLevel(style.backgroundPosition, ",");
  const area = paddingBox(rect, style);
  context.save();
  roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, px(style.borderTopLeftRadius));
  context.clip();
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    paintImageLayer(context, layers[index]!, area, layerValue(sizes, index, "auto"), layerValue(positions, index, "0% 0%"), urls);
  }
  context.restore();
}

function maskImage(style: CSSStyleDeclaration): string {
  const value = style.getPropertyValue("mask-image") || style.getPropertyValue("-webkit-mask-image");
  return value && value !== "none" ? value : "";
}

/** Each side in its own width and colour: a divider is often one side alone. */
function strokeBorder(
  context: CanvasRenderingContext2D,
  style: CSSStyleDeclaration,
  rect: LocalRect,
): void {
  const [top, right, bottom, left] = borderSides(style);
  if (!top && !right && !bottom && !left) return;
  const radius = px(style.borderTopLeftRadius);
  if (radius > 0 && top && right && bottom && left
    && [right, bottom, left].every((side) => side.width === top.width && side.color === top.color)) {
    context.strokeStyle = top.color;
    context.lineWidth = top.width;
    roundedRectPath(
      context,
      rect.x + top.width / 2,
      rect.y + top.width / 2,
      Math.max(0, rect.width - top.width),
      Math.max(0, rect.height - top.width),
      radius,
    );
    context.stroke();
    return;
  }
  const band = (side: BorderSide | null | undefined, x: number, y: number, width: number, height: number) => {
    if (!side || width <= 0 || height <= 0) return;
    context.fillStyle = side.color;
    context.fillRect(x, y, width, height);
  };
  const topWidth = top?.width ?? 0;
  const bottomWidth = bottom?.width ?? 0;
  const middle = rect.height - topWidth - bottomWidth;
  band(top, rect.x, rect.y, rect.width, topWidth);
  band(bottom, rect.x, rect.y + rect.height - bottomWidth, rect.width, bottomWidth);
  band(left, rect.x, rect.y + topWidth, left?.width ?? 0, middle);
  band(right, rect.x + rect.width - (right?.width ?? 0), rect.y + topWidth, right?.width ?? 0, middle);
}

/**
 * Sharp box shadows: the hairline dividers, focus rings and selection outlines
 * the app draws with `inset 0 -1px 0` or `0 0 0 2px`. Blurred shadows are
 * soft decoration around a box and are left out.
 */
function paintBoxShadows(
  context: CanvasRenderingContext2D,
  style: CSSStyleDeclaration,
  rect: LocalRect,
  inset: boolean,
): void {
  if (style.boxShadow === "none") return;
  const radius = px(style.borderTopLeftRadius);
  // The first shadow is on top, so paint from the last.
  for (const shadow of parseBoxShadows(style.boxShadow).reverse()) {
    if (shadow.inset !== inset || shadow.blur > 0 || !isPaintableColor(shadow.color)) continue;
    context.save();
    context.fillStyle = shadow.color;
    if (inset) {
      const box = paddingBox(rect, style);
      const innerRadius = Math.max(0, radius - Math.max(box.x - rect.x, box.y - rect.y));
      roundedRectPath(context, box.x, box.y, box.width, box.height, innerRadius);
      context.clip();
      context.beginPath();
      addRoundedRect(context, box.x, box.y, box.width, box.height, innerRadius);
      addRoundedRect(
        context,
        box.x + shadow.x + shadow.spread,
        box.y + shadow.y + shadow.spread,
        Math.max(0, box.width - shadow.spread * 2),
        Math.max(0, box.height - shadow.spread * 2),
        Math.max(0, innerRadius - shadow.spread),
      );
      context.fill("evenodd");
    } else {
      const shape = {
        x: rect.x + shadow.x - shadow.spread,
        y: rect.y + shadow.y - shadow.spread,
        width: rect.width + shadow.spread * 2,
        height: rect.height + shadow.spread * 2,
      };
      // Outside the box only: an outer shadow never shows through a see-through background.
      context.beginPath();
      context.rect(
        Math.min(shape.x, rect.x) - 1,
        Math.min(shape.y, rect.y) - 1,
        Math.max(shape.width, rect.width) + Math.abs(shadow.x) + 2,
        Math.max(shape.height, rect.height) + Math.abs(shadow.y) + 2,
      );
      addRoundedRect(context, rect.x, rect.y, rect.width, rect.height, radius);
      context.clip("evenodd");
      roundedRectPath(context, shape.x, shape.y, shape.width, shape.height, radius > 0 ? radius + shadow.spread : 0);
      context.fill();
    }
    context.restore();
  }
}

function shouldClip(style: CSSStyleDeclaration): boolean {
  return [style.overflow, style.overflowX, style.overflowY].some((value) => (
    value === "hidden" || value === "clip" || value === "auto" || value === "scroll"
  ));
}

function applyClip(
  context: CanvasRenderingContext2D,
  style: CSSStyleDeclaration,
  rect: LocalRect,
): void {
  if (!shouldClip(style)) return;
  roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, px(style.borderTopLeftRadius));
  context.clip();
}

function fontFor(style: CSSStyleDeclaration): string {
  if (style.font) return style.font;
  return [
    style.fontStyle || "normal",
    style.fontVariant || "normal",
    style.fontWeight || "400",
    `${style.fontSize || "14px"}/${style.lineHeight || "normal"}`,
    style.fontFamily || "monospace",
  ].join(" ");
}

function textBaselineOffset(style: CSSStyleDeclaration, rect: Pick<DOMRect, "height">): number {
  const fontSize = px(style.fontSize) || rect.height;
  const lineHeight = px(style.lineHeight) || rect.height || fontSize;
  return Math.max(fontSize * 0.78, (lineHeight + fontSize * 0.58) / 2);
}

type TextRect = Pick<DOMRect, "left" | "top" | "width" | "height">;

/** Recover the browser's actual line breaks, including font and inline layout. */
export function renderedTextFragments(
  value: string,
  measure: (start: number, end: number) => readonly TextRect[],
): { value: string; rect: TextRect }[] {
  const offsets = [0];
  for (const character of value) offsets.push(offsets.at(-1)! + character.length);
  const fragments: { value: string; rect: TextRect }[] = [];
  let start = 0;
  const visible = (rects: readonly TextRect[]) => rects.filter((rect) => rect.width > 0 && rect.height > 0);
  while (start < offsets.length - 1) {
    const remaining = visible(measure(offsets[start]!, value.length));
    const first = remaining[0];
    if (!first) break;
    // Binary search by code-point boundaries; measuring every glyph in long
    // research notes would add unnecessary layout work to each screenshot.
    let low = start + 1;
    let high = offsets.length - 1;
    let end = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const rects = visible(measure(offsets[start]!, offsets[middle]!));
      if (rects.every((rect) => Math.abs(rect.top - first.top) < 0.5)) {
        end = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    const rects = visible(measure(offsets[start]!, offsets[end]!));
    if (rects.length) {
      const left = Math.min(...rects.map((rect) => rect.left));
      fragments.push({ value: value.slice(offsets[start], offsets[end]), rect: {
        left, top: first.top, height: Math.max(...rects.map((rect) => rect.height)),
        width: Math.max(...rects.map((rect) => rect.left + rect.width)) - left,
      } });
    }
    start = end;
  }
  return fragments;
}

function drawTextNode(
  context: CanvasRenderingContext2D,
  textNode: Text,
  origin: CaptureOrigin,
): void {
  const value = textNode.nodeValue ?? "";
  if (value.length === 0 || value.trim().length === 0) return;
  const parent = textNode.parentElement;
  if (!parent) return;
  const style = getComputedStyle(parent);
  if (!isVisible(style) || !isPaintableColor(style.color)) return;

  const range = document.createRange();
  range.selectNodeContents(textNode);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) { range.detach(); return; }

  context.fillStyle = style.color;
  context.font = fontFor(style);
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.direction = style.direction === "rtl" ? "rtl" : "ltr";

  try {
    const fragments = rects.length === 1 ? [{ value, rect: rects[0]! }]
      : renderedTextFragments(value, (start, end) => {
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        return Array.from(range.getClientRects());
      });
    const end = ellipsisEdge(parent, style);
    for (const fragment of fragments) {
      const whole = style.whiteSpace === "normal" || style.whiteSpace === "nowrap"
        ? fragment.value.replace(/\s+/g, " ") : fragment.value.replace(/\r?\n/g, "");
      const rect = fragment.rect;
      const text = end !== null && rect.left + rect.width > end + 0.5
        ? ellipsized((value) => context.measureText(value).width, whole, end - rect.left)
        : whole;
      if (!text) continue;
      context.fillText(text, rect.left - origin.left, rect.top - origin.top + textBaselineOffset(style, rect));
    }
  } finally { range.detach(); }
}

/**
 * The right edge where the text's block cuts it with an ellipsis
 * (text-overflow: ellipsis, set on the block, not inherited), or null.
 */
function ellipsisEdge(element: Element, style: CSSStyleDeclaration): number | null {
  let block: Element = element;
  let blockStyle = style;
  while (blockStyle.display === "inline" && block.parentElement) {
    block = block.parentElement;
    blockStyle = getComputedStyle(block);
  }
  if (blockStyle.textOverflow !== "ellipsis" || !shouldClip(blockStyle)) return null;
  return block.getBoundingClientRect().right - px(blockStyle.borderRightWidth) - px(blockStyle.paddingRight);
}

/** The longest start of `text` that fits `width` with an ellipsis after it, as the screen cuts it. */
export function ellipsized(measure: (text: string) => number, text: string, width: number): string {
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(`${characters.slice(0, middle).join("")}\u2026`) <= width) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join("")}\u2026`;
}

function drawCanvasElement(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  origin: CaptureOrigin,
): void {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  try {
    context.drawImage(canvas, rect.left - origin.left, rect.top - origin.top, rect.width, rect.height);
  } catch {
    // Ignore canvases the browser considers unsafe to read.
  }
}

function drawInputElement(
  context: CanvasRenderingContext2D,
  element: HTMLInputElement | HTMLTextAreaElement,
  origin: CaptureOrigin,
): void {
  // Paint what the screen shows: a password field is dots, never its value.
  const typed = element instanceof HTMLInputElement && element.type === "password"
    ? "\u2022".repeat(element.value.length)
    : element.value;
  // An empty field shows its placeholder, in the placeholder's colour.
  const value = typed || element.placeholder;
  if (!value) return;
  const style = getComputedStyle(element);
  const color = typed ? style.color : getComputedStyle(element, "::placeholder").color;
  const rect = element.getBoundingClientRect();
  if (!isVisible(style) || !isPaintableColor(color) || rect.width <= 0 || rect.height <= 0) return;
  context.fillStyle = color;
  context.font = fontFor(style);
  const left = rect.left - origin.left + px(style.paddingLeft);
  const top = rect.top - origin.top + px(style.paddingTop) + textBaselineOffset(style, rect);
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    context.fillText(line, left, top + index * (px(style.lineHeight) || rect.height));
  }
}

/** An SVG or image the browser rasterized up front, in its content box. */
function drawRaster(
  context: CanvasRenderingContext2D,
  element: Element,
  style: CSSStyleDeclaration,
  raster: CanvasImageSource,
  origin: CaptureOrigin,
): void {
  const box = contentBox(element, style);
  if (box.width <= 0 || box.height <= 0) return;
  const local = { x: box.left - origin.left, y: box.top - origin.top, width: box.width, height: box.height };
  try {
    if (element instanceof HTMLImageElement) {
      const fitted = objectFitRect(style.objectFit, local, { width: element.naturalWidth, height: element.naturalHeight });
      context.save();
      context.beginPath();
      context.rect(local.x, local.y, local.width, local.height);
      context.clip();
      context.drawImage(raster, fitted.x, fitted.y, fitted.width, fitted.height);
      context.restore();
    } else {
      context.drawImage(raster, local.x, local.y, local.width, local.height);
    }
  } catch {
    // A raster that cannot be drawn is left out, like a failed one.
  }
}

interface PaintPass {
  context: CanvasRenderingContext2D;
  origin: CaptureOrigin;
  /** Device pixels per CSS pixel of the capture. */
  scale: number;
  skip?: (element: Element) => boolean;
  /** SVGs, images and CSS image URLs, loaded before the paint (dom-screenshot-rasters). */
  images: PreparedImages;
  /** The masked element being painted into its own layer, so it is not masked twice. */
  maskedElement?: Element;
}

/**
 * A masked element (the chart toolbar's icons, a fading tab strip): painted
 * into a layer of its own, cut by the mask's alpha, then laid down. A mask
 * image that did not load hides the element, as an unloaded mask does on
 * screen; a mask the capture cannot read (a radial gradient) returns false,
 * and the element is painted unmasked instead.
 */
function drawMasked(pass: PaintPass, element: Element, style: CSSStyleDeclaration, rect: LocalRect, mask: string): boolean {
  const width = Math.ceil(rect.width * pass.scale);
  const height = Math.ceil(rect.height * pass.scale);
  if (width <= 0 || height <= 0) return true;
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const alpha = document.createElement("canvas");
  alpha.width = width;
  alpha.height = height;
  const layerContext = layer.getContext("2d");
  const alphaContext = alpha.getContext("2d");
  if (!layerContext || !alphaContext) return false;

  // Masks are placed in the border box.
  const area = { x: 0, y: 0, width: rect.width, height: rect.height };
  alphaContext.scale(pass.scale, pass.scale);
  const layers = splitTopLevel(mask, ",");
  const sizes = splitTopLevel(style.getPropertyValue("mask-size") || style.getPropertyValue("-webkit-mask-size"), ",");
  const positions = splitTopLevel(style.getPropertyValue("mask-position") || style.getPropertyValue("-webkit-mask-position"), ",");
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const painted = paintImageLayer(
      alphaContext,
      layers[index]!,
      area,
      layerValue(sizes, index, "auto"),
      layerValue(positions, index, "0% 0%"),
      pass.images.urls,
    );
    if (!painted) return cssUrl(layers[index]!) !== null;
  }

  layerContext.scale(pass.scale, pass.scale);
  layerContext.translate(-rect.x, -rect.y);
  drawElement({ ...pass, context: layerContext, maskedElement: element }, element);
  layerContext.setTransform(1, 0, 0, 1, 0, 0);
  layerContext.globalCompositeOperation = "destination-in";
  layerContext.drawImage(alpha, 0, 0);
  pass.context.drawImage(layer, rect.x, rect.y, rect.width, rect.height);
  return true;
}

function drawElement(pass: PaintPass, element: Element): void {
  const { context, origin } = pass;
  if (!(element instanceof HTMLElement || element instanceof SVGElement)) return;
  if (pass.skip?.(element)) return;

  const style = getComputedStyle(element);
  if (!isVisible(style)) return;

  const rect = localRect(element.getBoundingClientRect(), origin);
  if (rect.width <= 0 || rect.height <= 0) return;

  const mask = pass.maskedElement === element ? "" : maskImage(style);
  if (mask && drawMasked(pass, element, style, rect, mask)) return;

  context.save();
  const opacity = Number.parseFloat(style.opacity || "1");
  if (Number.isFinite(opacity)) {
    context.globalAlpha *= Math.max(0, Math.min(opacity, 1));
  }

  // CSS order: outer shadow, background, inset shadow, border, then content.
  paintBoxShadows(context, style, rect, false);
  fillBackground(context, style, rect);
  paintBackgroundImages(context, style, rect, pass.images.urls);
  paintBoxShadows(context, style, rect, true);
  strokeBorder(context, style, rect);
  applyClip(context, style, rect);

  const raster = pass.images.elements.get(element);
  if (raster) {
    drawRaster(context, element, style, raster, origin);
  } else if (element instanceof HTMLCanvasElement) {
    drawCanvasElement(context, element, origin);
  } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    drawInputElement(context, element, origin);
  }

  // An SVG's shapes and text are in its raster; they are not boxes to walk.
  if (!(element instanceof SVGElement)) {
    for (const child of paintOrder(element)) {
      if (child.nodeType === Node.TEXT_NODE) {
        drawTextNode(context, child as Text, origin);
      } else {
        drawElement(pass, child as Element);
      }
    }
  }

  context.restore();
}

/** Where a child falls in its parent's paint: below the flow, in it, or above it at its z-index. */
function paintLayer(child: Element): number {
  const style = getComputedStyle(child);
  if (style.position === "static") return 0;
  const z = Number.parseInt(style.zIndex, 10);
  return Number.isFinite(z) && z !== 0 ? z : 0.5;
}

/**
 * A parent's children in the order the screen paints them, as CSS stacks
 * them: negative z-index first, then text and in-flow boxes, then positioned
 * boxes, then positive z-index by its value, each in document order. A chart
 * toolbar placed over its canvas with a z-index comes before the canvas in
 * the document and would otherwise be painted under it.
 */
function paintOrder(element: Element): ChildNode[] {
  const children = Array.from(element.childNodes)
    .filter((child) => child.nodeType === Node.TEXT_NODE || child.nodeType === Node.ELEMENT_NODE);
  if (!children.some((child) => child.nodeType === Node.ELEMENT_NODE && getComputedStyle(child as Element).position !== "static")) {
    return children;
  }
  return children
    .map((child, index) => ({ child, index, layer: child.nodeType === Node.ELEMENT_NODE ? paintLayer(child as Element) : 0 }))
    .sort((left, right) => left.layer - right.layer || left.index - right.index)
    .map(({ child }) => child);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read screenshot data."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Could not encode pane screenshot."));
      }, "image/png");
    } catch {
      reject(new Error("Could not encode pane screenshot."));
    }
  });
}

async function waitForFonts(): Promise<void> {
  const fontSet = document.fonts;
  if (!fontSet) return;
  await Promise.race([
    fontSet.ready,
    new Promise((resolve) => setTimeout(resolve, 250)),
  ]).catch(() => {});
}

async function paintElement(
  element: HTMLElement,
  scale: number,
  options: { background?: string; skip?: (element: Element) => boolean } = {},
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  await waitForFonts();
  // Images load asynchronously, so SVGs and CSS images are ready before the synchronous paint.
  const images = await prepareImages(element, options.skip);
  const rect = element.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  if (width <= 0 || height <= 0) {
    throw new Error("Pane is not visible.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create pane screenshot.");
  context.scale(scale, scale);
  context.clearRect(0, 0, width, height);
  if (options.background) {
    context.fillStyle = options.background;
    context.fillRect(0, 0, width, height);
  }
  // Reveal the chart watermark only for the synchronous paint below: the
  // browser never gets a frame in between, so the live UI does not flicker.
  const watermarkWasVisible = isScreenshotWatermarkVisible();
  setScreenshotWatermarkVisible(true);
  try {
    drawElement({ context, origin: { left: rect.left, top: rect.top }, scale, skip: options.skip, images }, element);
  } finally {
    if (!watermarkWasVisible) setScreenshotWatermarkVisible(false);
  }
  return { canvas, width, height };
}

async function captureElementPngBase64(element: HTMLElement): Promise<PngScreenshot> {
  const scale = Math.max(1, Math.min(globalThis.devicePixelRatio || 1, 3));
  const { canvas, width, height } = await paintElement(element, scale);
  return {
    pngBase64: await blobToBase64(await canvasToPngBlob(canvas)),
    width,
    height,
  };
}

export interface JpegScreenshot {
  jpegBase64: string;
  width: number;
  height: number;
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Could not encode screenshot."));
      }, "image/jpeg", quality);
    } catch {
      reject(new Error("Could not encode screenshot."));
    }
  });
}

function downscale(source: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * factor));
  canvas.height = Math.max(1, Math.round(source.height * factor));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not encode screenshot.");
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * The whole app window as a JPEG no longer than `maxBase64Length`, for bug
 * reports. Painted at 1x (text stays legible, the file stays small), then
 * shrunk until it fits. Elements matching `skip` (the feedback dialog itself)
 * are left out.
 */
export async function captureAppScreenshotJpegBase64(options: {
  maxBase64Length: number;
  skipSelector?: string;
}): Promise<JpegScreenshot> {
  if (typeof document === "undefined") throw new Error("Screenshots need a window.");
  const root = document.getElementById("root") ?? document.body;
  const background = getComputedStyle(document.body).backgroundColor;
  const skipSelector = options.skipSelector;
  let { canvas } = await paintElement(root, 1, {
    background: isPaintableColor(background) ? background : "#000",
    skip: skipSelector ? (element) => element.matches(skipSelector) : undefined,
  });
  for (const quality of [0.8, 0.7, 0.6, 0.6, 0.6]) {
    const jpegBase64 = await blobToBase64(await canvasToJpegBlob(canvas, quality));
    if (jpegBase64.length <= options.maxBase64Length) {
      return { jpegBase64, width: canvas.width, height: canvas.height };
    }
    canvas = downscale(canvas, 0.8);
  }
  throw new Error("Screenshot is too large.");
}

/**
 * One pane of this window, for pane.screenshot: painted at the scale the
 * request picks for its on-screen size, then shrunk until the PNG fits the
 * byte cap. Unlike the copy action it never falls back to another pane.
 */
export const capturePaneImage: CapturePane = async (request) => {
  if (typeof document === "undefined") throw new Error("Screenshots need a window.");
  const target = document.querySelector<HTMLElement>(
    `[data-gloom-role='pane-window'][data-gloom-pane-id="${escapeAttributeValue(request.instanceId)}"]`,
  );
  const rect = target?.getBoundingClientRect();
  if (!target || !rect || rect.width < 1 || rect.height < 1) {
    throw new Error(`Pane "${request.instanceId}" is not drawn right now (behind another tab or a full-screen pane). Focus it and try again.`);
  }
  const screen = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
  let { canvas } = await paintElement(target, request.scaleFor(screen));
  let reduced = false;
  for (;;) {
    const blob = await canvasToPngBlob(canvas);
    if (blob.size <= request.maxBytes) {
      return { pngBase64: await blobToBase64(blob), width: canvas.width, height: canvas.height, bytes: blob.size, screen, reduced };
    }
    // PNG size follows the pixel count, so shrink by the square root of the overshoot.
    const factor = Math.min(0.9, Math.sqrt(request.maxBytes / blob.size) * 0.95);
    if (Math.round(canvas.width * factor) < request.minWidth) {
      throw new Error(`The pane's image stays over ${Math.max(1, Math.round(request.maxBytes / 1024))} KB even ${request.minWidth} px wide.`);
    }
    canvas = downscale(canvas, factor);
    reduced = true;
  }
};

export async function capturePaneScreenshotPngBase64(paneId?: string): Promise<PngScreenshot> {
  const target = findPaneScreenshotTarget(paneId);
  if (!target) throw new Error("Pane is not visible.");
  return captureElementPngBase64(target);
}
