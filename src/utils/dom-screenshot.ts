/// <reference lib="dom" />

import { isScreenshotWatermarkVisible, setScreenshotWatermarkVisible } from "./screenshot-watermark";

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

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
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

function strokeBorder(
  context: CanvasRenderingContext2D,
  style: CSSStyleDeclaration,
  rect: ReturnType<typeof localRect>,
): void {
  const widths = [
    px(style.borderTopWidth),
    px(style.borderRightWidth),
    px(style.borderBottomWidth),
    px(style.borderLeftWidth),
  ];
  if (widths.every((width) => width <= 0) || !isPaintableColor(style.borderTopColor)) return;

  context.strokeStyle = style.borderTopColor;
  context.lineWidth = Math.max(...widths);
  roundedRectPath(
    context,
    rect.x + context.lineWidth / 2,
    rect.y + context.lineWidth / 2,
    Math.max(0, rect.width - context.lineWidth),
    Math.max(0, rect.height - context.lineWidth),
    px(style.borderTopLeftRadius),
  );
  context.stroke();
}

function shouldClip(style: CSSStyleDeclaration): boolean {
  return [style.overflow, style.overflowX, style.overflowY].some((value) => (
    value === "hidden" || value === "clip" || value === "auto" || value === "scroll"
  ));
}

function applyClip(
  context: CanvasRenderingContext2D,
  style: CSSStyleDeclaration,
  rect: ReturnType<typeof localRect>,
): boolean {
  if (!shouldClip(style)) return false;
  roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, px(style.borderTopLeftRadius));
  context.clip();
  return true;
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
    for (const fragment of fragments) {
      const text = style.whiteSpace === "normal" || style.whiteSpace === "nowrap"
        ? fragment.value.replace(/\s+/g, " ") : fragment.value.replace(/\r?\n/g, "");
      if (!text) continue;
      const rect = fragment.rect;
      context.fillText(text, rect.left - origin.left, rect.top - origin.top + textBaselineOffset(style, rect));
    }
  } finally { range.detach(); }
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
  const value = element.value;
  if (!value) return;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  if (!isVisible(style) || !isPaintableColor(style.color) || rect.width <= 0 || rect.height <= 0) return;
  context.fillStyle = style.color;
  context.font = fontFor(style);
  const left = rect.left - origin.left + px(style.paddingLeft);
  const top = rect.top - origin.top + px(style.paddingTop) + textBaselineOffset(style, rect);
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    context.fillText(line, left, top + index * (px(style.lineHeight) || rect.height));
  }
}

function drawElement(
  context: CanvasRenderingContext2D,
  element: Element,
  origin: CaptureOrigin,
): void {
  if (!(element instanceof HTMLElement || element instanceof SVGElement)) return;

  const style = getComputedStyle(element);
  if (!isVisible(style)) return;

  const rect = localRect(element.getBoundingClientRect(), origin);
  if (rect.width <= 0 || rect.height <= 0) return;

  context.save();
  const opacity = Number.parseFloat(style.opacity || "1");
  if (Number.isFinite(opacity)) {
    context.globalAlpha *= Math.max(0, Math.min(opacity, 1));
  }

  fillBackground(context, style, rect);
  strokeBorder(context, style, rect);
  const clipped = applyClip(context, style, rect);

  if (element instanceof HTMLCanvasElement) {
    drawCanvasElement(context, element, origin);
  } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    drawInputElement(context, element, origin);
  }

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      drawTextNode(context, child as Text, origin);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      drawElement(context, child as Element, origin);
    }
  }

  if (clipped) {
    context.restore();
  } else {
    context.restore();
  }
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

async function captureElementPngBase64(element: HTMLElement): Promise<PngScreenshot> {
  const rect = element.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  if (width <= 0 || height <= 0) {
    throw new Error("Pane is not visible.");
  }

  await waitForFonts();

  const scale = Math.max(1, Math.min(globalThis.devicePixelRatio || 1, 3));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create pane screenshot.");
  context.scale(scale, scale);
  context.clearRect(0, 0, width, height);
  // Reveal the chart watermark only for the synchronous paint below: the
  // browser never gets a frame in between, so the live UI does not flicker.
  const watermarkWasVisible = isScreenshotWatermarkVisible();
  setScreenshotWatermarkVisible(true);
  try {
    drawElement(context, element, { left: rect.left, top: rect.top });
  } finally {
    if (!watermarkWasVisible) setScreenshotWatermarkVisible(false);
  }

  return {
    pngBase64: await blobToBase64(await canvasToPngBlob(canvas)),
    width,
    height,
  };
}

export async function capturePaneScreenshotPngBase64(paneId?: string): Promise<PngScreenshot> {
  const target = findPaneScreenshotTarget(paneId);
  if (!target) throw new Error("Pane is not visible.");
  return captureElementPngBase64(target);
}
