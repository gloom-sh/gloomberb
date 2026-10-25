import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../theme/font-scale";
import { isLiveResizing, onLiveResizeEnd, onLiveResizeStart } from "../../../ui/live-resize";
import { RESIZE_SETTLE_MS } from "../../../ui/resize-settle";

/**
 * A surface that draws for one size (a chart, a heat map) inside a pane's own
 * layout: under a query bar, beside a table, in a column of text. Panes size
 * their boxes in whole cells from the pane's size, so a surface is a fraction
 * of a cell short of the box it sits in, and nothing in it follows a resize
 * until the pane renders again.
 *
 * A surface looks up its boxes to the pane's content box. On an axis where
 * every box between them follows the frame by CSS already (it stretches or
 * grows), is sized to exactly the space its own parent gives it, or is a
 * fraction of a cell short of a space nothing else takes, and its own cells
 * reach within a cell of the space its parent gives it, the surface takes
 * that space by CSS at rest (`data-gloom-fill-x`/`-y`): it fills its box, and
 * so does each box above it that was short. When a resize starts, the exact
 * boxes above a filled surface follow by CSS for the length of the resize
 * (`data-gloom-follow-x`/`-y`), and the surface follows the frame to the
 * pixel on that axis (`followsFrame`).
 *
 * A box that has a size of its own on the way (a fixed width, a share of the
 * pane, a whole-cell rounding) leaves the surface on its cells on that axis,
 * as it was, and to `useLiveStretch`'s prediction during a resize. So does a
 * box that scrolls content larger than itself (a column of charts and text),
 * and, at rest, a sized box whose data table would be resized with it (the
 * chart-table kit's band over its table). Tables register separately to let
 * their ancestors follow only during a resize, keeping their rest layout.
 *
 * A surface's exact ancestor is already the size CSS gives it, and a filled
 * box only gains the fraction of a cell its cells leave, from space that is
 * empty: it starts where that space starts and nothing comes after it, and
 * no sibling grows into it. A table preserves that fraction during a drag.
 */

type Axis = "x" | "y";
type Mode = "stretch" | "grow";
/** A box on the way up from a surface: exact (follows only during a resize) or short (fills at rest). */
type Link = [HTMLElement, Mode, "exact" | "short"];

/** Tracked surfaces, with the observer that refits each when its parent's box changes size at rest. */
const surfaces = new Map<HTMLElement, ResizeObserver | null>();
/** Tables follow during a resize, but keep their original whole-cell layout at rest. */
const tables = new Set<HTMLElement>();
/** The boxes above each surface that fill at rest along with it. */
const boxFills = new Map<HTMLElement, Array<[HTMLElement, Axis, Mode]>>();
const followed = new WeakMap<HTMLElement, { x: boolean; y: boolean }>();
interface FollowMark {
  element: HTMLElement;
  axis: Axis;
  mode: Mode;
  margin: number | null;
}
let followMarks: FollowMark[] = [];
let settleFrame: number | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let settleObserver: MutationObserver | null = null;
let installed = false;

/** Below this, in px, two sizes are the same: the browser lays out in 1/64 px. */
const EXACT_PX = 0.5;

/** The pane's cell on `axis`, the unit the boxes a surface sits in were counted in. */
const cellOn = (axis: Axis) => (axis === "x" ? WEB_CELL_WIDTH : WEB_CELL_HEIGHT);

const SIZE = { x: "width", y: "height" } as const;
const FILL_ATTRIBUTE = { x: "data-gloom-fill-x", y: "data-gloom-fill-y" } as const;
const FOLLOW_ATTRIBUTE = { x: "data-gloom-follow-x", y: "data-gloom-follow-y" } as const;
const GAP_ATTRIBUTE = { x: "data-gloom-follow-gap-x", y: "data-gloom-follow-gap-y" } as const;
const GAP_MARGIN = { x: "--gloom-follow-x-margin", y: "--gloom-follow-y-margin" } as const;
const MARGIN = { x: "marginRight", y: "marginBottom" } as const;
const SETTLE_ATTRIBUTE = "data-gloom-follow-settling";
const SETTLE_TRANSITION = "--gloom-follow-transition";

interface Pass {
  styles: Map<Element, CSSStyleDeclaration>;
}

function styleOf(pass: Pass, element: Element): CSSStyleDeclaration {
  let style = pass.styles.get(element);
  if (!style) {
    // The element's own window: the page's, or a test's DOM that sets no globals.
    style = (element.ownerDocument.defaultView ?? window).getComputedStyle(element);
    pass.styles.set(element, style);
  }
  return style;
}

const px = (value: string) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** The size the box was given in its own style, in px, or null (auto, a percentage, nothing). */
function ownSize(element: HTMLElement, axis: Axis): number | null {
  const value = element.style[SIZE[axis]];
  return value.endsWith("px") ? parseFloat(value) : null;
}

function isPaneContent(element: Element): boolean {
  return element.getAttribute("data-gloom-role") === "pane-content";
}

function inFlow(pass: Pass, element: Element): boolean {
  const style = styleOf(pass, element);
  return style.display !== "none" && style.position !== "absolute" && style.position !== "fixed";
}

/** The parent's content box on `axis`, in fractional px (clientWidth rounds to whole ones). */
function innerSize(pass: Pass, parent: HTMLElement, axis: Axis): number {
  const style = styleOf(pass, parent);
  const rect = parent.getBoundingClientRect();
  if (axis === "x") {
    const borders = px(style.borderLeftWidth) + px(style.borderRightWidth);
    const scrollbar = Math.max(0, parent.offsetWidth - parent.clientWidth - borders);
    return rect.width - borders - scrollbar - px(style.paddingLeft) - px(style.paddingRight);
  }
  const borders = px(style.borderTopWidth) + px(style.borderBottomWidth);
  const scrollbar = Math.max(0, parent.offsetHeight - parent.clientHeight - borders);
  return rect.height - borders - scrollbar - px(style.paddingTop) - px(style.paddingBottom);
}

/**
 * How `element` takes its size on `axis` from its parent: as the flex
 * container's cross axis, its main axis, or neither (a grid, a block's
 * height), with the space the parent gives it there; NaN when that space is
 * not one the element could simply take (siblings that grow too).
 */
function placement(pass: Pass, element: HTMLElement, axis: Axis): { mode: Mode | null; space: number } {
  const parent = element.parentElement;
  if (!parent) return { mode: null, space: NaN };
  const parentStyle = styleOf(pass, parent);
  const style = styleOf(pass, element);
  const inner = innerSize(pass, parent, axis);
  const margins = axis === "x"
    ? px(style.marginLeft) + px(style.marginRight)
    : px(style.marginTop) + px(style.marginBottom);
  const flex = parentStyle.display === "flex" || parentStyle.display === "inline-flex";
  if (!flex) return axis === "x" && parentStyle.display === "block" ? { mode: "stretch", space: inner - margins } : { mode: null, space: NaN };
  const row = parentStyle.flexDirection.startsWith("row");
  const main = (axis === "x") === row;
  if (!main) return { mode: "stretch", space: inner - margins };
  let taken = 0;
  let count = 0;
  for (const sibling of parent.children) {
    if (!inFlow(pass, sibling)) continue;
    count += 1;
    if (sibling === element) continue;
    const siblingStyle = styleOf(pass, sibling);
    // A sibling that grows shares what is left: nothing here is simply the rest.
    if (px(siblingStyle.flexGrow) > 0) return { mode: "grow", space: NaN };
    const rect = sibling.getBoundingClientRect();
    taken += axis === "x"
      ? rect.width + px(siblingStyle.marginLeft) + px(siblingStyle.marginRight)
      : rect.height + px(siblingStyle.marginTop) + px(siblingStyle.marginBottom);
  }
  const gap = px(axis === "x" ? parentStyle.columnGap : parentStyle.rowGap);
  return { mode: "grow", space: inner - taken - gap * Math.max(0, count - 1) - margins };
}

/**
 * Whether the space `element` would grow into on `axis` is empty and right
 * after it: it starts where its space starts, so filling it moves nothing
 * (not a sibling after it, not a centred or end-aligned box).
 */
function startsSpace(pass: Pass, element: HTMLElement, axis: Axis, space: number): boolean {
  const parent = element.parentElement;
  if (!parent) return false;
  const style = styleOf(pass, parent);
  const own = styleOf(pass, element);
  const rect = element.getBoundingClientRect();
  const box = parent.getBoundingClientRect();
  const end = axis === "x"
    ? box.left + px(style.borderLeftWidth) + px(style.paddingLeft) + innerSize(pass, parent, "x")
    : box.top + px(style.borderTopWidth) + px(style.paddingTop) + innerSize(pass, parent, "y");
  const start = axis === "x" ? rect.left : rect.top;
  const margin = px(axis === "x" ? own.marginRight : own.marginBottom);
  return Math.abs(end - start - margin - space) <= EXACT_PX;
}

/**
 * How a box with a size of its own on `axis` sits in the space its parent
 * gives it: exactly, a fraction of a cell off empty space, or neither.
 */
function sizedFit(pass: Pass, element: HTMLElement, axis: Axis, own: number): { mode: Mode; kind: "exact" | "short" } | null {
  const { mode, space } = placement(pass, element, axis);
  if (mode === null || !Number.isFinite(space)) return null;
  const short = space - own;
  if (Math.abs(short) <= EXACT_PX) return { mode, kind: "exact" };
  // Whole cells floored from the pane's size leave less than a cell, give or
  // take the layout's rounding of the pane's box. Counted around a bar the
  // page draws taller than a row (a query bar), they run a fraction of a cell
  // past it instead, into what the box clips: filling takes back only that.
  if (Math.abs(short) < cellOn(axis) + EXACT_PX && startsSpace(pass, element, axis, space)) return { mode, kind: "short" };
  return null;
}

/** Whether `element` scrolls content larger than itself on either axis. */
function scrolls(pass: Pass, element: HTMLElement): boolean {
  const style = styleOf(pass, element);
  const scrollable = (overflow: string) => overflow === "auto" || overflow === "scroll";
  if (!scrollable(style.overflowX) && !scrollable(style.overflowY)) return false;
  return element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1;
}

/**
 * Whether following the frame through `box` on `axis` would resize a data
 * table in it: one whose boxes up to `box` all stretch or grow with it. A
 * table in a box with a size of its own (a table of a fixed width beside a
 * chart) stays put.
 */
function resizesTable(pass: Pass, box: HTMLElement, axis: Axis): boolean {
  for (const table of box.querySelectorAll<HTMLElement>("[data-gloom-role=\"data-table\"]")) {
    let element: HTMLElement | null = table;
    while (element && element !== box) {
      if (ownSize(element, axis) !== null || !inFlow(pass, element)) break;
      const style = styleOf(pass, element);
      const { mode } = placement(pass, element, axis);
      const parentStyle = element.parentElement ? styleOf(pass, element.parentElement) : null;
      const align = style.alignSelf === "auto" || style.alignSelf === "normal" ? parentStyle?.alignItems : style.alignSelf;
      const stretches = mode === "stretch" && (align === "stretch" || align === "normal");
      const grows = mode === "grow" && px(style.flexGrow) > 0;
      if (!stretches && !grows) break;
      element = element.parentElement;
    }
    if (element === box) return true;
  }
  return false;
}

/** Whether `element` is the only box laid out in its parent. */
function onlyInFlow(pass: Pass, element: HTMLElement): boolean {
  for (const sibling of element.parentElement?.children ?? []) {
    if (sibling !== element && inFlow(pass, sibling)) return false;
  }
  return true;
}

/**
 * Whether `element`'s size on `axis` follows the frame by CSS (exact boxes
 * once marked, short ones once filled), and whether it is definite, that is,
 * does not come from what it holds. Collects the sized boxes on the way into
 * `links`.
 */
function trace(pass: Pass, element: HTMLElement, axis: Axis, links: Link[]): { follows: boolean; definite: boolean } {
  if (isPaneContent(element)) return { follows: true, definite: true };
  const parent = element.parentElement;
  if (!parent || !inFlow(pass, element) || scrolls(pass, element)) return { follows: false, definite: ownSize(element, axis) !== null };
  const own = ownSize(element, axis);
  const style = styleOf(pass, element);
  if (own !== null) {
    const above = trace(pass, parent, axis, links);
    const fit = sizedFit(pass, element, axis, own);
    if (above.follows && above.definite && fit) {
      links.push([element, fit.mode, fit.kind]);
      return { follows: true, definite: true };
    }
    return { follows: false, definite: true };
  }
  const { mode } = placement(pass, element, axis);
  const parentStyle = styleOf(pass, parent);
  const blockLevel = style.display === "flex" || style.display === "block" || style.display === "grid";
  const align = style.alignSelf === "auto" || style.alignSelf === "normal" ? parentStyle.alignItems : style.alignSelf;
  const stretches = mode === "stretch" && blockLevel && (align === "stretch" || align === "normal");
  const grows = mode === "grow" && px(style.flexGrow) > 0;
  if (!stretches && !grows) return { follows: false, definite: false };
  const above = trace(pass, parent, axis, links);
  return { follows: above.follows, definite: above.definite };
}

/**
 * The surface's fill on `axis` at rest, the mode it takes its parent's space
 * by, with the short boxes above it that fill too; null when it keeps its cells.
 */
function restFill(pass: Pass, surface: HTMLElement, axis: Axis): { mode: Mode; boxes: Array<[HTMLElement, Mode]> } | null {
  const parent = surface.parentElement;
  const own = ownSize(surface, axis);
  if (!parent || own === null || !inFlow(pass, surface)) return null;
  // The pane's root takes the pane's whole box, however many cells it was given.
  if (isPaneContent(parent) && onlyInFlow(pass, surface)) {
    const { mode, space } = placement(pass, surface, axis);
    return mode && own < space + cellOn(axis) ? { mode, boxes: [] } : null;
  }
  // Its cells reach within a cell of the space, short of it or past it, and into space nothing else takes.
  const fit = sizedFit(pass, surface, axis, own);
  if (!fit) return null;
  // Only where the boxes above it follow the frame too: a surface that could
  // not follow keeps its cells, and the prediction keeps it on the frame.
  const links: Link[] = [];
  if (!trace(pass, parent, axis, links).follows) return null;
  if (links.some(([element]) => resizesTable(pass, element, axis))) return null;
  return { mode: fit.mode, boxes: links.filter(([, , kind]) => kind === "short").map(([element, mode]) => [element, mode]) };
}

/** Whether a surface other than `surface` fills `element` on `axis`. */
function filledByAnother(surface: HTMLElement, element: HTMLElement, axis: Axis): boolean {
  for (const [other, boxes] of boxFills) {
    if (other !== surface && boxes.some(([box, at]) => box === element && at === axis)) return true;
  }
  return false;
}

/** Sets the boxes above `surface` that fill along with it, and clears the ones that no longer do. */
function setBoxFills(surface: HTMLElement, boxes: Array<[HTMLElement, Axis, Mode]>): void {
  for (const [element, axis] of boxFills.get(surface) ?? []) {
    const kept = boxes.some(([box, at]) => box === element && at === axis);
    if (!kept && !filledByAnother(surface, element, axis)) element.removeAttribute(FILL_ATTRIBUTE[axis]);
  }
  if (boxes.length) boxFills.set(surface, boxes);
  else boxFills.delete(surface);
  for (const [element, axis, mode] of boxes) {
    if (element.getAttribute(FILL_ATTRIBUTE[axis]) !== mode) element.setAttribute(FILL_ATTRIBUTE[axis], mode);
  }
}

/** Fills the surface's box at rest, on the axes where it is a fraction of a cell short of it. */
export function fitSurface(surface: HTMLElement): void {
  // A surface that is not displayed (a hidden tab) has no space to fit: it
  // keeps its fills for when it shows again, instead of losing them to the
  // 0 by 0 it is laid out at meanwhile and taking them back as it reappears.
  if (!surface.isConnected || isLiveResizing() || followMarks.length > 0 || surface.getClientRects().length === 0) return;
  const pass: Pass = { styles: new Map() };
  // Judged on the cells each box was given and where it starts, neither of which a fill changes.
  const fills = { x: restFill(pass, surface, "x"), y: restFill(pass, surface, "y") };
  const boxes: Array<[HTMLElement, Axis, Mode]> = [];
  for (const axis of ["x", "y"] as const) {
    const fill = fills[axis];
    if (!fill) surface.removeAttribute(FILL_ATTRIBUTE[axis]);
    else {
      if (surface.getAttribute(FILL_ATTRIBUTE[axis]) !== fill.mode) surface.setAttribute(FILL_ATTRIBUTE[axis], fill.mode);
      for (const [element, mode] of fill.boxes) boxes.push([element, axis, mode]);
    }
  }
  setBoxFills(surface, boxes);
  fitGrip(surface);
}

/**
 * A floating pane's resize grip sits over the bottom-right corner of its
 * content when it has no footer: a chart that reaches that corner keeps the
 * last label of its time axis clear of it.
 */
function fitGrip(surface: HTMLElement): void {
  const frame = surface.closest("[data-gloom-role=\"pane-window\"][data-floating=\"true\"]");
  const grip = frame?.querySelector(":scope > [data-gloom-role=\"resize-handle\"]");
  let under = false;
  if (grip) {
    const at = grip.getBoundingClientRect();
    for (const axis of surface.querySelectorAll("[data-gloom-role=\"chart-time-axis\"]")) {
      const rect = axis.getBoundingClientRect();
      if (rect.right > at.left + EXACT_PX && rect.bottom > at.top + EXACT_PX && rect.top < at.bottom && rect.left < at.right) under = true;
    }
  }
  if (under) surface.setAttribute("data-gloom-grip-clear", "true");
  else surface.removeAttribute("data-gloom-grip-clear");
}

function applyFollowMark({ element, axis, mode, margin }: FollowMark): void {
  element.setAttribute(FOLLOW_ATTRIBUTE[axis], mode);
  if (margin !== null) {
    element.setAttribute(GAP_ATTRIBUTE[axis], "");
    element.style.setProperty(GAP_MARGIN[axis], `${margin}px`);
  }
}

function clearFollowMark({ element, axis }: FollowMark): void {
  element.removeAttribute(FOLLOW_ATTRIBUTE[axis]);
  element.removeAttribute(GAP_ATTRIBUTE[axis]);
  element.style.removeProperty(GAP_MARGIN[axis]);
  element.removeAttribute(SETTLE_ATTRIBUTE);
  element.style.removeProperty(SETTLE_TRANSITION);
}

function cancelSettling(): void {
  if (settleFrame !== null) cancelAnimationFrame(settleFrame);
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleFrame = null;
  settleTimer = null;
  settleObserver?.disconnect();
  settleObserver = null;
}

/** Placement excludes margins: add only the empty space after the visible box. */
function followingMargin(pass: Pass, element: HTMLElement, axis: Axis): number {
  const margin = px(styleOf(pass, element)[MARGIN[axis]]);
  const { space } = placement(pass, element, axis);
  const size = element.getBoundingClientRect()[SIZE[axis]];
  return Number.isFinite(space) ? margin + space - size : margin;
}

function startFollowing(): void {
  cancelSettling();
  const pass: Pass = { styles: new Map() };
  const marks = new Map<HTMLElement, Map<Axis, FollowMark>>();
  const add = (element: HTMLElement, axis: Axis, mode: Mode, keepGap: boolean) => {
    let axes = marks.get(element);
    if (!axes) marks.set(element, axes = new Map());
    const mark = axes.get(axis) ?? { element, axis, mode, margin: null };
    if (keepGap && mark.margin === null) mark.margin = followingMargin(pass, element, axis);
    axes.set(axis, mark);
  };
  // A regrab keeps the currently visible, possibly interpolated gap. Its
  // inline cell size may still be catching up, so retain the existing path.
  for (const mark of followMarks) {
    if (mark.element.isConnected) add(mark.element, mark.axis, mark.mode, mark.margin !== null);
  }
  // A resize changes the parents' boxes on every frame; nothing refits until it ends.
  for (const observer of surfaces.values()) observer?.disconnect();
  for (const surface of surfaces.keys()) {
    if (!surface.isConnected || !surface.parentElement) continue;
    const result = { x: false, y: false };
    for (const axis of ["x", "y"] as const) {
      if (!surface.hasAttribute(FILL_ATTRIBUTE[axis])) continue;
      const links: Link[] = [];
      if (!trace(pass, surface.parentElement, axis, links).follows) continue;
      result[axis] = true;
      // A short box fills, and so follows, already.
      for (const [element, mode, kind] of links) if (kind === "exact") add(element, axis, mode, false);
    }
    followed.set(surface, result);
  }
  for (const table of tables) {
    if (!table.isConnected || !table.parentElement || table.getClientRects().length === 0) continue;
    for (const axis of ["x", "y"] as const) {
      const links: Link[] = [];
      if (!trace(pass, table.parentElement, axis, links).follows) continue;
      // Preserve the measured gap, including ancestors a chart already fills.
      // Starting a resize in another pane must not move this table at all.
      for (const [element, mode] of links) add(element, axis, mode, true);
    }
  }
  // Marked after every surface and table is traced, so every fit is judged
  // from the layout the pane drew before any ancestor starts following.
  for (const mark of followMarks) clearFollowMark(mark);
  followMarks = [...marks.values()].flatMap((axes) => [...axes.values()]);
  for (const mark of followMarks) applyFollowMark(mark);
}

function finishFollowing(): void {
  cancelSettling();
  for (const mark of followMarks) clearFollowMark(mark);
  followMarks = [];
  for (const surface of surfaces.keys()) followed.delete(surface);
  // After the release has laid the panes out: every surface fits its box again.
  const refit = () => {
    if (isLiveResizing() || followMarks.length > 0) return;
    for (const [surface, observer] of surfaces) {
      fitSurface(surface);
      if (observer && surface.parentElement) observer.observe(surface.parentElement);
    }
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(refit);
  else setTimeout(refit, 0);
}

function settleFollowing(): void {
  settleFrame = null;
  if (isLiveResizing()) return;
  if (settleTimer !== null) clearTimeout(settleTimer);
  const pass: Pass = { styles: new Map() };
  const visible = followMarks.map(({ element, axis }) => px(styleOf(pass, element)[MARGIN[axis]]));
  // Measure every target in the complete resting layout. Measuring a child
  // against its still-following parent would give nested gaps the wrong end.
  for (const mark of followMarks) clearFollowMark(mark);
  const rest: Pass = { styles: new Map() };
  const targets = followMarks.map(({ element, axis }) => followingMargin(rest, element, axis));
  const transitions = new Map(followMarks.map(({ element }) => [element, styleOf(rest, element).transition]));
  for (const [index, mark] of followMarks.entries()) {
    mark.margin = visible[index]!;
    applyFollowMark(mark);
  }
  // Establish the starting margins before changing their targets. Everything
  // above happens in one task, so the temporary resting layout never paints.
  for (const document of new Set(followMarks.map(({ element }) => element.ownerDocument))) {
    void document.documentElement.offsetWidth;
  }
  for (const [element, existing] of transitions) {
    const margins = `margin-right ${RESIZE_SETTLE_MS}ms linear, margin-bottom ${RESIZE_SETTLE_MS}ms linear`;
    element.style.setProperty(SETTLE_TRANSITION, existing && existing !== "none" ? `${existing}, ${margins}` : margins);
    element.setAttribute(SETTLE_ATTRIBUTE, "");
  }
  for (const [index, mark] of followMarks.entries()) {
    mark.margin = targets[index]!;
    mark.element.style.setProperty(GAP_MARGIN[mark.axis], `${mark.margin}px`);
  }
  settleTimer = setTimeout(finishFollowing, RESIZE_SETTLE_MS * 2);
}

function stopFollowing(): void {
  for (const mark of followMarks) if (mark.margin === null) clearFollowMark(mark);
  followMarks = followMarks.filter((mark) => mark.margin !== null);
  const view = followMarks[0]?.element.ownerDocument.defaultView;
  if (!view || view.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    finishFollowing();
    return;
  }
  const schedule = () => {
    // A delayed frame must get to retarget before the old deadline removes
    // the marks. Its own settle pass installs a fresh cleanup timer.
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
    if (settleFrame === null) settleFrame = requestAnimationFrame(settleFollowing);
  };
  // A final React layout commit may land after release. Ignore the custom
  // properties written by settling itself, but include insets and margins.
  const layout = ({ style }: HTMLElement) => [style.width, style.height,
    style.marginTop, style.marginRight, style.marginBottom, style.marginLeft,
    style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].join("/");
  const sizes = new Map(followMarks.map(({ element }) => [element, layout(element)]));
  settleObserver = new view.MutationObserver((records) => {
    for (const { target } of records) {
      const element = target as HTMLElement;
      const size = layout(element);
      if (sizes.get(element) === size) continue;
      sizes.set(element, size);
      schedule();
    }
  });
  for (const element of sizes.keys()) settleObserver.observe(element, { attributes: true, attributeFilter: ["style"] });
  schedule();
}

/**
 * Tracks a surface root: fits it now, again whenever its parent's box changes
 * size at rest, and takes it into every resize's pass. Returns the untrack.
 */
export function trackSurface(surface: HTMLElement): () => void {
  installFollowing();
  const parent = surface.parentElement;
  const observer = typeof ResizeObserver !== "undefined" && parent
    ? new ResizeObserver(() => fitSurface(surface))
    : null;
  surfaces.set(surface, observer);
  fitSurface(surface);
  if (parent && !isLiveResizing()) observer?.observe(parent);
  return () => {
    observer?.disconnect();
    setBoxFills(surface, []);
    surfaces.delete(surface);
    followed.delete(surface);
    for (const axis of ["x", "y"] as const) surface.removeAttribute(FILL_ATTRIBUTE[axis]);
    surface.removeAttribute("data-gloom-grip-clear");
  };
}

function installFollowing(): void {
  if (installed) return;
  installed = true;
  onLiveResizeStart(startFollowing);
  onLiveResizeEnd(stopFollowing);
}

/** Registers a table for the resize pass, without fitting it or changing its layout at rest. */
export function trackTableResize(table: HTMLElement): () => void {
  installFollowing();
  tables.add(table);
  return () => { tables.delete(table); };
}

/** During a resize, the axes on which the surface follows the frame by CSS. */
export function surfaceFollows(surface: HTMLElement): { x: boolean; y: boolean } {
  return followed.get(surface) ?? { x: false, y: false };
}
