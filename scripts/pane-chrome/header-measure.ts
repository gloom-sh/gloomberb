/**
 * What the app's top bar draws, measured in the page: each item of the bar
 * (the command prompt, the update status, Help, the market summary, the
 * Windows caption buttons) and the boxes it paints, cut to what can show.
 * Shared by the header checks (header-checks.ts) and anything that wants the
 * same numbers from another browser.
 *
 * An item is a child of the bar. What it paints is its buttons and controls
 * whole, every run of text (a button's label too, in case it spills out of
 * it), and every icon, each cut by the boxes that clip it. A box that shows nothing (an empty spacer, text wrapped onto a line the
 * bar hides) is left out.
 */

export interface HeaderBox { left: number; right: number; top: number; bottom: number }

interface HeaderPaint {
  /** What it is: a button's label, a text run, or the tag of an icon. */
  label: string;
  kind: "control" | "text" | "icon";
  /** The whole box, before any clipping. */
  box: HeaderBox;
  /** The part that can show. */
  visible: HeaderBox;
  /** The text is cut by its own box and ends in an ellipsis. */
  ellipsis: boolean;
}

interface HeaderItem {
  name: string;
  box: HeaderBox;
  paints: HeaderPaint[];
}

export interface HeaderMeasure {
  width: number;
  bar: HeaderBox;
  items: HeaderItem[];
}

/** A page expression that returns a HeaderMeasure, or null when there is no top bar. */
export const HEADER_MEASURE = `(() => {
  const bar = document.querySelector("[data-gloom-role=app-header]");
  if (!bar) return null;
  const boxOf = (element) => {
    const r = element.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  const meet = (a, b) => ({ left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) });
  const empty = (box) => box.right - box.left < 0.5 || box.bottom - box.top < 0.5;
  const clips = (element) => {
    const style = getComputedStyle(element);
    return style.overflowX !== "visible" || style.overflowY !== "visible";
  };
  // A box cut by the window and by every box from "from" up to the bar that clips what it holds.
  const visibleOf = (box, from) => {
    let visible = meet(box, { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight });
    for (let node = from; node; node = node.parentElement) {
      if (clips(node)) visible = meet(visible, boxOf(node));
      if (node === bar) break;
    }
    return visible;
  };
  // Where the glyphs of an element's own text are: they can run past its box.
  const inkOf = (element) => {
    const range = document.createRange();
    let ink = null;
    for (const node of element.childNodes) {
      if (node.nodeType !== 3 || !node.textContent.trim()) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      ink = ink ? { left: Math.min(ink.left, r.left), right: Math.max(ink.right, r.right), top: Math.min(ink.top, r.top), bottom: Math.max(ink.bottom, r.bottom) }
        : { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }
    return ink;
  };
  const shown = (element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
  };
  const paintsOf = (item) => {
    const paints = [];
    const add = (element, kind, label) => {
      if (!shown(element)) return;
      const style = getComputedStyle(element);
      // Text that its own box cuts with an ellipsis is drawn whole to the ellipsis; any other cut is a cut.
      const ellipsis = kind === "text" && style.textOverflow === "ellipsis" && clips(element) && element.scrollWidth > element.clientWidth + 0.5;
      const ink = kind === "text" ? inkOf(element) : null;
      const box = ink ? (ellipsis ? meet(ink, boxOf(element)) : ink) : boxOf(element);
      const visible = visibleOf(box, ellipsis ? element.parentElement : kind === "text" ? element : element.parentElement);
      if (empty(box) || empty(visible)) return;
      paints.push({ label, kind, box, visible, ellipsis });
    };
    for (const element of [item, ...item.querySelectorAll("*")]) {
      const tag = element.tagName.toLowerCase();
      if (tag === "button" || element.getAttribute("role") === "button" || element.dataset.gloomInteractive === "true") {
        add(element, "control", (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 40));
      }
      if (tag === "svg") { add(element, "icon", "svg"); continue; }
      if (element.closest("svg")) continue;
      const text = [...element.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join("").trim();
      if (text) add(element, "text", text.slice(0, 40));
    }
    return paints;
  };
  const nameOf = (item, index) => {
    const role = item.dataset.gloomRole ?? item.querySelector("[data-gloom-role]")?.dataset.gloomRole;
    const text = (item.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 24);
    return (role ? role : "item " + index) + (text && !role ? " \\"" + text + "\\"" : "");
  };
  return {
    width: window.innerWidth,
    bar: boxOf(bar),
    items: [...bar.children].map((item, index) => ({ name: nameOf(item, index), box: boxOf(item), paints: paintsOf(item) })),
  };
})()`;

const overlap = (a: HeaderBox, b: HeaderBox) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
  && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
const cut = (paint: HeaderPaint) => paint.visible.left > paint.box.left + 0.5 || paint.visible.right < paint.box.right - 0.5
  || paint.visible.top > paint.box.top + 0.5 || paint.visible.bottom < paint.box.bottom - 0.5;
const px = (box: HeaderBox) => `${Math.round(box.left)}-${Math.round(box.right)}`;

/**
 * Why a measured bar fails, or nothing: two items paint over each other, or
 * something is cut by a box it sits in (or the window edge) rather than ending
 * in an ellipsis of its own. A button is whole or not there at all.
 */
export function headerFailures(measure: HeaderMeasure | null): string[] {
  if (!measure) return ["there is no top bar"];
  const failures: string[] = [];
  const items = measure.items.filter((item) => item.paints.length > 0);
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      for (const a of items[i]!.paints) {
        const b = items[j]!.paints.find((paint) => overlap(a.visible, paint.visible));
        if (b) {
          failures.push(`${items[i]!.name} "${a.label}" (${px(a.visible)}) overlaps ${items[j]!.name} "${b.label}" (${px(b.visible)})`);
          break;
        }
      }
    }
  }
  for (const item of items) {
    for (const paint of item.paints) {
      if (cut(paint)) {
        failures.push(`${item.name} "${paint.label}" is cut off (${px(paint.box)} shows ${px(paint.visible)})`);
      }
      if (paint.visible.top < measure.bar.top - 0.5 || paint.visible.bottom > measure.bar.bottom + 0.5) {
        failures.push(`${item.name} "${paint.label}" leaves the bar's row`);
      }
    }
  }
  return failures;
}

/** The visible box of the first control in the bar whose label starts with `label`. */
export function headerControl(measure: HeaderMeasure | null, label: string): HeaderBox | null {
  for (const item of measure?.items ?? []) {
    const paint = item.paints.find((entry) => entry.kind === "control" && entry.label.startsWith(label));
    if (paint) return paint.visible;
  }
  return null;
}
