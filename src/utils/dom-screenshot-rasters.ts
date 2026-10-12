/// <reference lib="dom" />

import { cssUrl, splitTopLevel } from "./dom-screenshot-css";

/**
 * Pixels the pane capture cannot repaint itself. The capture walks the DOM and
 * redraws boxes and text; an `<svg>` (gauges, sparklines, chart drawings,
 * icons) or an `<img>` has neither, so before the paint each one is turned
 * into something the canvas can draw in place: an SVG becomes a standalone SVG
 * image with its computed styles written in, an image is used as it is. The
 * images CSS paints from `url()` (background and mask images, such as the
 * chart toolbar's icons) are loaded too.
 *
 * Anything that would taint the canvas (a cross-origin image without CORS) is
 * left out: one tainted pixel and the whole screenshot can no longer be encoded.
 */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * Inherited properties an SVG reads from its context or from stylesheets. Each
 * element gets the ones whose computed value differs from its parent's, so the
 * standalone image paints with the same colours, strokes and fonts as the page
 * (`currentColor`, CSS variables, `font-family: inherit` and app stylesheets
 * all resolve to plain values).
 */
const INHERITED_PROPERTIES = [
  "color",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "paint-order",
  "clip-rule",
  "visibility",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-stretch",
  "letter-spacing",
  "word-spacing",
  "text-anchor",
  "dominant-baseline",
  "direction",
  "shape-rendering",
  "text-rendering",
] as const;

/**
 * Properties that do not inherit, with the values that mean "nothing set".
 * The outer `<svg>` gets none of them: the capture applies its opacity to the
 * whole image.
 */
const OWN_PROPERTIES: Record<string, readonly string[]> = {
  opacity: ["1"],
  "vector-effect": ["none"],
  "mix-blend-mode": ["normal"],
  "clip-path": ["none"],
  mask: ["none"],
  filter: ["none"],
  "alignment-baseline": ["auto", "baseline"],
  "baseline-shift": ["0px", "baseline"],
};

const STOP_PROPERTIES = ["stop-color", "stop-opacity"] as const;

/** `url("https://host/page#id")` and `url("#id")` both point at the copy's own `#id`. */
function localReferences(value: string): string {
  return value.replace(/url\((["']?)[^"')]*#([^"')]+)\1\)/g, "url(#$2)");
}

function inlineSvgStyle(
  source: Element,
  target: Element,
  computed: CSSStyleDeclaration,
  parent: CSSStyleDeclaration | null,
): void {
  const style = (target as SVGElement).style;
  if (!style) return;
  for (const property of INHERITED_PROPERTIES) {
    const value = computed.getPropertyValue(property);
    if (value && (!parent || parent.getPropertyValue(property) !== value)) {
      style.setProperty(property, localReferences(value));
    }
  }
  if (!parent) return;
  if (computed.display === "none") style.setProperty("display", "none");
  for (const [property, unset] of Object.entries(OWN_PROPERTIES)) {
    const value = computed.getPropertyValue(property);
    if (value && !unset.includes(value)) style.setProperty(property, localReferences(value));
  }
  if (source.localName === "stop") {
    for (const property of STOP_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (value) style.setProperty(property, value);
    }
  }
}

/** The box an SVG draws into: its border box less borders and padding. */
export function contentBox(element: Element, style: CSSStyleDeclaration = getComputedStyle(element)): DOMRect {
  const rect = element.getBoundingClientRect();
  const px = (value: string) => Number.parseFloat(value) || 0;
  const left = px(style.borderLeftWidth) + px(style.paddingLeft);
  const top = px(style.borderTopWidth) + px(style.paddingTop);
  const right = px(style.borderRightWidth) + px(style.paddingRight);
  const bottom = px(style.borderBottomWidth) + px(style.paddingBottom);
  return new DOMRect(rect.left + left, rect.top + top, Math.max(0, rect.width - left - right), Math.max(0, rect.height - top - bottom));
}

/** The SVG as a standalone document that paints like the page does, at `width` x `height` CSS pixels. */
function standaloneSvgMarkup(svg: SVGSVGElement, width: number, height: number): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const sources = [svg, ...Array.from(svg.querySelectorAll("*"))];
  const targets = [clone, ...Array.from(clone.querySelectorAll("*"))];
  const computed = new Map<Element, CSSStyleDeclaration>();
  const styleOf = (element: Element) => {
    let style = computed.get(element);
    if (!style) {
      style = getComputedStyle(element);
      computed.set(element, style);
    }
    return style;
  };
  sources.forEach((source, index) => {
    const target = targets[index];
    if (!target || source.namespaceURI !== SVG_NAMESPACE) return;
    const parent = index === 0 || !source.parentElement ? null : styleOf(source.parentElement);
    inlineSvgStyle(source, target, styleOf(source), parent);
  });
  // HTML inside an SVG image taints the canvas in WebKit; the capture cannot
  // carry its stylesheet styles into the image anyway.
  for (const foreign of Array.from(clone.querySelectorAll("foreignObject"))) foreign.remove();

  clone.setAttribute("xmlns", SVG_NAMESPACE);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  // The page lays the SVG out (absolute, 100% wide, offset); in the image it
  // is the whole viewport. Its opacity is the capture's to apply, once.
  for (const property of ["position", "inset", "top", "right", "bottom", "left", "margin", "transform", "translate", "scale", "rotate", "opacity"]) {
    clone.style.removeProperty(property);
  }
  clone.removeAttribute("opacity");
  clone.style.setProperty("width", `${width}px`);
  clone.style.setProperty("height", `${height}px`);
  clone.style.setProperty("overflow", "hidden");
  return new XMLSerializer().serializeToString(clone);
}

/**
 * Longest wait for one image. Data URLs load at once; a remote background
 * image the page already shows comes from cache. Anything slower is left out
 * rather than holding the copy (and the clipboard's user gesture) hostage.
 */
const IMAGE_LOAD_TIMEOUT_MS = 1_500;

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => resolve(null), IMAGE_LOAD_TIMEOUT_MS);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    image.src = src;
  });
}

/** Whether drawing `source` leaves a canvas readable, which encoding the screenshot needs. */
function readable(source: CanvasImageSource): boolean {
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const context = probe.getContext("2d");
  if (!context) return false;
  try {
    context.drawImage(source, 0, 0, 1, 1);
    context.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

function shown(element: Element, root: Element, skip?: (element: Element) => boolean): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (skip?.(node)) return false;
    if (node === root) break;
  }
  return true;
}

async function rasterizeSvg(svg: SVGSVGElement): Promise<CanvasImageSource | null> {
  const box = contentBox(svg);
  if (box.width <= 0 || box.height <= 0) return null;
  const markup = standaloneSvgMarkup(svg, box.width, box.height);
  // A data URL: the web terminal's content security policy allows data: images, not blob: ones.
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
  return image && readable(image) ? image : null;
}

export interface PreparedImages {
  /** Each outermost SVG and each loaded `<img>`, drawn in the element's content box. */
  elements: Map<Element, CanvasImageSource>;
  /** The images behind `url()` in background and mask images, by URL. */
  urls: Map<string, HTMLImageElement>;
}

const IMAGE_LAYER_PROPERTIES = ["background-image", "mask-image", "-webkit-mask-image"] as const;

/** Every `url()` the HTML under `root` paints through CSS. */
function cssImageUrls(root: Element): Set<string> {
  const urls = new Set<string>();
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (!(element instanceof HTMLElement)) continue;
    const style = getComputedStyle(element);
    for (const property of IMAGE_LAYER_PROPERTIES) {
      const value = style.getPropertyValue(property);
      if (!value || value === "none" || !value.includes("url(")) continue;
      for (const layer of splitTopLevel(value, ",")) {
        const url = cssUrl(layer);
        if (url) urls.add(url);
      }
    }
  }
  return urls;
}

/**
 * Everything under `root` the capture draws from an image. Elements and URLs
 * that fail to load or rasterize are left out, and the capture paints nothing
 * for them.
 */
export async function prepareImages(
  root: Element,
  skip?: (element: Element) => boolean,
): Promise<PreparedImages> {
  const elements = new Map<Element, CanvasImageSource>();
  const urls = new Map<string, HTMLImageElement>();
  const candidates = [
    ...(root.matches("svg, img") ? [root] : []),
    ...Array.from(root.querySelectorAll("svg, img")),
  ];
  await Promise.all([
    ...candidates.map(async (element) => {
      if (!shown(element, root, skip)) return;
      if (element instanceof SVGSVGElement) {
        // A nested SVG is painted with the outer one.
        if (element.ownerSVGElement) return;
        const raster = await rasterizeSvg(element).catch(() => null);
        if (raster) elements.set(element, raster);
      } else if (element instanceof HTMLImageElement) {
        if (element.complete && element.naturalWidth > 0 && readable(element)) elements.set(element, element);
      }
    }),
    ...Array.from(cssImageUrls(root), async (url) => {
      const image = await loadImage(url);
      if (image && image.naturalWidth > 0 && readable(image)) urls.set(url, image);
    }),
  ]);
  return { elements, urls };
}
