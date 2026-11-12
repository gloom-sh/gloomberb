import { FADE_PX } from "../../src/renderers/dom/host/overflow-fade-px";

/**
 * What a query bar draws, measured in the page: every control, run of text
 * and icon in it, each cut to what can show through the boxes that clip it.
 * Shared by the query bar checks (query-bar-checks.ts) and anything that
 * wants the same numbers from another browser or from a real pane.
 *
 * A strip that scrolls by itself (an option chain's expiries) cuts the
 * choices at its edges on purpose; the bar's own scroll, its last resort when
 * nothing more can give way, cuts what runs past its edge. Both are told
 * apart from any other cut, which is a control drawn over or into another.
 * A control drawn at no width, or hidden whole by anything but those two, is
 * a failure too, and so is a strip that keeps no whole choice clear of its
 * fades.
 */

interface QueryBarBox { left: number; right: number; top: number; bottom: number }

interface QueryBarPaint {
  /** What it is: a control's label, a text run, or "svg". */
  label: string;
  kind: "control" | "text" | "icon";
  /** The part that can show. */
  visible: QueryBarBox;
  /** Text cut by a box that clips it, short of an ellipsis of its own: by a strip that scrolls by itself, the bar's own scroll, or something else. */
  cut: "strip" | "bar" | "other" | null;
  /** Text that ends in an ellipsis with less than two ems of it before: a letter or two. */
  sliver: boolean;
  /** A control drawn at no width, or hidden whole by a box other than a strip or the bar that scrolls. */
  collapsed: boolean;
  /** The filter id of the strip that cut it. */
  strip?: string;
}

interface QueryBarStrip {
  /** The filter id. */
  id: string;
  /** The width its choices scroll in. */
  width: number;
  /** Choices whose text shows whole, clear of the fades at the edges that hide more. */
  clearChoices: number;
  /** The chosen choice shows whole, clear of the fades; null when none is chosen. */
  chosenClear: boolean | null;
}

export interface QueryBarMeasure {
  /** The `data-query-bar-case` the bar sits in, or its index on the page. */
  name: string;
  bar: QueryBarBox;
  /** The bar ran out of room: its controls run past its edge and it scrolls. */
  overflows: boolean;
  paints: QueryBarPaint[];
  /** Pairs of paints that are not inside one another and overlap. */
  overlaps: Array<[number, number]>;
  /** The inline lists that scroll by themselves. */
  strips: QueryBarStrip[];
}

/** A page expression that returns a QueryBarMeasure for every query bar on the page. */
export const QUERY_BAR_MEASURE = `(() => {
  const boxOf = (element) => {
    const r = element.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  const meet = (a, b) => ({ left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) });
  const empty = (box) => box.right - box.left < 0.5 || box.bottom - box.top < 0.5;
  // Narrower than this a control cannot be seen or hit.
  const noWidth = (box) => box.right - box.left < 2;
  const clips = (element) => {
    const style = getComputedStyle(element);
    return style.overflowX !== "visible" || style.overflowY !== "visible";
  };
  const shown = (element, bar) => {
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      if (node === bar) break;
    }
    return true;
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
  const kindOfClip = (node) => node.matches(".gloom-qb-scroll") ? "bar"
    : node.matches("[data-strip=true] .gloom-qb-segments") ? "strip" : "other";
  const measure = (bar, index) => {
    const paints = [];
    const elements = [];
    const add = (element, kind, label) => {
      if (!shown(element, bar)) return;
      const style = getComputedStyle(element);
      const ellipsis = kind === "text" && style.textOverflow === "ellipsis" && clips(element) && element.scrollWidth > element.clientWidth + 0.5;
      const ink = kind === "text" ? inkOf(element) : null;
      const box = ink ? (ellipsis ? meet(ink, boxOf(element)) : ink) : boxOf(element);
      let visible = meet(box, { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight });
      let cut = null;
      let strip;
      let hiddenBy = null;
      for (let node = ellipsis || kind !== "text" ? element.parentElement : element; node; node = node.parentElement) {
        if (clips(node)) {
          const next = meet(visible, boxOf(node));
          if (!hiddenBy && !empty(visible) && noWidth(next)) hiddenBy = kindOfClip(node);
          if (kind === "text" && !cut && (next.left > visible.left + 0.5 || next.right < visible.right - 0.5)) {
            cut = kindOfClip(node);
            if (cut === "strip") strip = node.closest("[data-item-id]")?.getAttribute("data-item-id") ?? undefined;
          }
          visible = next;
        }
        if (node === bar) break;
      }
      const collapsed = kind === "control" && (noWidth(box) || hiddenBy === "other");
      if (!collapsed && (empty(box) || empty(visible))) return;
      const room = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      paints.push({ label, kind, visible, cut, strip, sliver: ellipsis && room < 2 * parseFloat(style.fontSize), collapsed });
      elements.push(element);
    };
    for (const element of bar.querySelectorAll("*")) {
      const tag = element.tagName.toLowerCase();
      if (tag === "button" || element.getAttribute("role") === "button") {
        add(element, "control", (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 40));
      }
      if (tag === "svg") { add(element, "icon", "svg"); continue; }
      if (element.closest("svg")) continue;
      const text = [...element.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join("").trim();
      if (text) add(element, "text", text.slice(0, 40));
    }
    const over = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    const overlaps = [];
    for (let i = 0; i < paints.length; i += 1) {
      for (let j = i + 1; j < paints.length; j += 1) {
        if (elements[i].contains(elements[j]) || elements[j].contains(elements[i])) continue;
        if (over(paints[i].visible, paints[j].visible)) overlaps.push([i, j]);
      }
    }
    const strips = [...bar.querySelectorAll(".gloom-qb-inline[data-strip=true]")].map((group) => {
      const choices = group.querySelector(".gloom-qb-segments");
      const box = boxOf(choices);
      // The fades cover ${FADE_PX} px at each edge that hides more (overflow-fade.ts).
      const left = box.left + (choices.scrollLeft > 1 ? ${FADE_PX} : 0);
      const right = box.right - (choices.scrollLeft + choices.clientWidth < choices.scrollWidth - 1 ? ${FADE_PX} : 0);
      // A choice's text, inside its padding, is what has to show.
      const clear = (button) => {
        const r = boxOf(button.querySelector(".gloom-qb-text") ?? button);
        return r.right - r.left >= 2 && r.left >= left - 0.5 && r.right <= right + 0.5;
      };
      const chosen = choices.querySelector("button[data-active=true]");
      return {
        id: group.getAttribute("data-item-id") ?? "",
        width: box.right - box.left,
        clearChoices: [...choices.querySelectorAll("button")].filter(clear).length,
        chosenClear: chosen ? clear(chosen) : null,
      };
    });
    const name = bar.closest("[data-query-bar-case]")?.getAttribute("data-query-bar-case") ?? "query bar " + index;
    const scroll = bar.querySelector(".gloom-qb-scroll");
    const overflows = !!scroll && scroll.scrollWidth > scroll.clientWidth + 1;
    return { name, bar: boxOf(bar), overflows, paints, overlaps, strips };
  };
  return [...document.querySelectorAll("[data-gloom-role=query-bar]")].map(measure);
})()`;

const px = (box: QueryBarBox) => `${Math.round(box.left)}-${Math.round(box.right)}`;

/**
 * Why a measured bar fails, or nothing: two of its controls paint over each
 * other, something is cut by a box other than one of the `strips` that scroll
 * by themselves (filter ids), a control is drawn at no width, a strip shows no
 * whole choice (or not its chosen one) clear of its fades, or, unless
 * `barMayScroll`, the bar ran out of room and cut what runs past its edge
 * although giving way should have made it fit.
 */
export function queryBarFailures(measure: QueryBarMeasure, { barMayScroll, strips = [] }: { barMayScroll: boolean; strips?: readonly string[] }): string[] {
  const failures: string[] = [];
  if (measure.overflows && !barMayScroll) failures.push("the bar runs past its edge");
  const name = (index: number) => `${measure.paints[index]!.kind} "${measure.paints[index]!.label}" (${px(measure.paints[index]!.visible)})`;
  for (const [a, b] of measure.overlaps) failures.push(`${name(a)} overlaps ${name(b)}`);
  for (const strip of measure.strips) {
    if (strip.clearChoices === 0) failures.push(`the ${strip.id} strip (${Math.round(strip.width)} px) shows no whole choice clear of its fades`);
    else if (strip.chosenClear === false) failures.push(`the ${strip.id} strip (${Math.round(strip.width)} px) does not show its chosen choice whole, clear of its fades`);
  }
  measure.paints.forEach((paint, index) => {
    if (paint.collapsed) failures.push(`${name(index)} is drawn at no width`);
    if (paint.sliver) failures.push(`${name(index)} is cut to a sliver before its ellipsis`);
    const allowed = paint.cut === null || (paint.cut === "bar" && barMayScroll) || (paint.cut === "strip" && strips.includes(paint.strip ?? ""));
    if (!allowed) failures.push(`${name(index)} is cut ${paint.cut === "bar" ? "by the bar's edge" : paint.cut === "strip" ? `by the ${paint.strip} strip` : "short"}`);
    if (!paint.collapsed && (paint.visible.top < measure.bar.top - 0.5 || paint.visible.bottom > measure.bar.bottom + 0.5)) failures.push(`${name(index)} leaves the bar's row`);
  });
  return failures;
}
