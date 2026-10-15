/**
 * Where a pane's content stops, measured in the page: the layout checks
 * (layout-checks.ts) and the full-registry sweep (layout-sweep.ts) read the
 * same numbers.
 *
 * - `footerGap`: px between the bottom of the pane body and the footer.
 * - `bottomGap`: the empty band between the outermost box that clips or
 *   scrolls content and the footer, when nothing is drawn under it (a
 *   scroller that stops short of the footer). Both must be 0.
 * - `clipped`: boxes that cut off a few pixels of text or a picture: a box
 *   counted in 18 px rows around a header or bar the page draws 20 px.
 * - `overrun`: charts drawn for more rows than the box that clips them.
 * - `cut`: text that ends in an ellipsis written into the string, with room
 *   for more of it left on its line: cut at a count of columns.
 * - `blocks`: runs of wrapped text lines. A run is `columnWrapped` when its
 *   lines break where the next word would have fitted: wrapped at a count of
 *   columns rather than at the width it sits in. `rightGap` is how far the
 *   longest line stops short of that width.
 * - `wrapped`: text wrapping inside a box given a fixed width in pixels, with
 *   how far that box stops short of the width the text may use.
 * - `snapped`: boxes that really are a whole number of cells and stop under
 *   three cells short of a body that is not (a fill that overrides the size
 *   in CSS does not count).
 *
 * The width text may use is the inner edge of its scroller, or of a column
 * that caps it with a CSS max-width: a deliberate reading measure.
 */
interface LayoutBlock {
  lines: number;
  candidates: number;
  premature: number;
  columnWrapped: boolean;
  rightGap: number;
  tolerance: number;
  sample: string;
  /** Where lines broke early: the end of the line, then the word that would have fitted. */
  breaks: string[];
  path: string;
}

export interface LayoutMeasure {
  missing?: boolean;
  body: { width: number; height: number };
  cell: { width: number; height: number };
  footerGap: number;
  bottomGap: { gap: number; path: string } | null;
  blocks: LayoutBlock[];
  wrapped: Array<{ rightGap: number; tolerance: number; lines: number; path: string }>;
  snapped: Array<{ axis: "x" | "y"; px: number; body: number; short: number; path: string }>;
  clipped: Array<{ px: number; path: string }>;
  overrun: Array<{ px: number; path: string }>;
  /** `whole` is the element's full text, for telling a cut the page made from one that arrived in the data. */
  cut: Array<{ room: number; text: string; whole: string; path: string }>;
  /** Cut text that came that way from the source (a feed's own truncated headline): reported, not a failure. */
  arrivedCut?: Array<{ room: number; text: string; whole: string; path: string }>;
  detailOpen: boolean;
  text: string;
}

export const LAYOUT_MEASURE = (paneId: string) => `(() => {
  const pane = document.querySelector(${JSON.stringify(`[data-gloom-pane-id="${paneId}"]`)});
  const body = pane?.querySelector("[data-gloom-role=pane-body]");
  if (!pane || !body) return { missing: true };
  const footer = [...pane.querySelectorAll("[data-gloom-role=pane-footer]")].find((el) => el.getBoundingClientRect().height > 0);
  const rootStyle = getComputedStyle(document.body);
  const cellW = parseFloat(rootStyle.getPropertyValue("--cell-w")) || 8;
  const cellH = parseFloat(rootStyle.getPropertyValue("--cell-h")) || 18;
  const B = body.getBoundingClientRect();
  const footerTop = footer ? footer.getBoundingClientRect().top : B.bottom;
  const round = (v) => Math.round(v * 100) / 100;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity) > 0.01;
  };
  const describe = (el) => {
    const role = el.getAttribute("data-gloom-role") ?? el.getAttribute("data-gloom-ui");
    return role ? "[" + role + "]" : el.tagName.toLowerCase();
  };
  const path = (el) => { const out = []; for (let e = el; e && e !== body && out.length < 5; e = e.parentElement) out.unshift(describe(e)); return out.join(" > "); };
  const all = [...body.querySelectorAll("*")].filter(visible);
  const clipOf = (el) => {
    let r = { top: B.top, bottom: Math.min(B.bottom, footerTop), left: B.left, right: B.right };
    for (let e = el.parentElement; e && e !== body.parentElement; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.overflowY !== "visible" || s.overflowX !== "visible") {
        const q = e.getBoundingClientRect();
        r = { top: Math.max(r.top, q.top), bottom: Math.min(r.bottom, q.bottom), left: Math.max(r.left, q.left), right: Math.min(r.right, q.right) };
      }
    }
    return r;
  };
  const background = (el) => { const c = getComputedStyle(el).backgroundColor; return c && c !== "transparent" && !/rgba\\(.*, 0\\)$/.test(c) ? c : null; };
  const painted = [];
  for (const el of all) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const media = /^(CANVAS|SVG|IMG|VIDEO)$/i.test(el.tagName);
    const ownBackground = background(el) && background(el) !== background(el.parentElement ?? body);
    const border = parseFloat(s.borderBottomWidth) > 0 || parseFloat(s.borderTopWidth) > 0;
    if (!media && !ownBackground && !border) continue;
    const c = clipOf(el);
    const top = Math.max(r.top, c.top), bottom = Math.min(r.bottom, c.bottom);
    if (bottom > top) painted.push({ top, bottom, left: Math.max(r.left, c.left), right: Math.min(r.right, c.right), el });
  }
  const lines = [];
  const paintedBoxes = new Set();
  const boxOf = (el) => { let e = el; while (e && e !== body && getComputedStyle(e).display === "inline") e = e.parentElement; return e ?? el; };
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent;
    const el = node.parentElement;
    if (!text || !text.trim() || !el || !visible(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((q) => q.width > 0 && q.height > 0);
    const c = clipOf(el);
    // Text occupies its line boxes, not just its glyphs: the box that holds it.
    const holder = boxOf(el);
    if (!paintedBoxes.has(holder)) {
      paintedBoxes.add(holder);
      const q = holder.getBoundingClientRect();
      const top = Math.max(q.top, c.top), bottom = Math.min(q.bottom, c.bottom);
      if (bottom > top) painted.push({ top, bottom, left: q.left, right: q.right, el: holder });
    }
    // The text of each line box, for the word that starts the next one.
    const pieces = [];
    let start = 0, lastTop = null;
    const one = document.createRange();
    for (let i = 0; i < text.length && i < 4000; i++) {
      one.setStart(node, i); one.setEnd(node, i + 1);
      const q = [...one.getClientRects()].find((r) => r.width > 0 || r.height > 0);
      if (!q) continue;
      if (lastTop !== null && Math.abs(q.top - lastTop) > 2) { pieces.push(text.slice(start, i)); start = i; }
      lastTop = q.top;
    }
    pieces.push(text.slice(start));
    rects.forEach((q, i) => lines.push({ left: q.left, right: q.right, top: q.top, bottom: q.bottom, text: pieces[i] ?? "", el, clip: c }));
  }

  // Bottom: the outermost box that clips or scrolls content, and the empty band under it.
  const overflowsY = (el) => {
    const s = getComputedStyle(el);
    return s.overflowY !== "visible" && el.scrollHeight > el.clientHeight + 1 && el.getBoundingClientRect().height >= cellH * 3;
  };
  const outermost = all.filter((el) => {
    if (!overflowsY(el)) return false;
    for (let e = el.parentElement; e && e !== body; e = e.parentElement) if (overflowsY(e)) return false;
    return true;
  });
  // Only a band down to the footer counts: space between it and something
  // drawn below it is the layout's spacing.
  const gaps = outermost.map((el) => {
    const r = el.getBoundingClientRect();
    const bottom = Math.min(r.bottom, clipOf(el).bottom);
    const below = painted.filter((p) => !el.contains(p.el) && !p.el.contains(el) && p.top >= bottom - 0.5 && p.left < r.right && p.right > r.left);
    return { gap: below.length > 0 ? 0 : round(footerTop - bottom), path: path(el) };
  }).sort((a, b) => b.gap - a.gap);
  // Content a few pixels taller than the box that clips it: a box counted in
  // 18 px rows around a header or bar the page draws 20 px tall.
  // A box that scrolls shows the rest by scrolling; only one that clips loses it.
  const clips = (s) => s.overflowY === "hidden" || s.overflowY === "clip";
  const clipped = all.filter((el) => {
    const s = getComputedStyle(el);
    if (!clips(s) || el.getBoundingClientRect().height < cellH * 3) return false;
    // Whole pixels: a box a fraction of a pixel short rounds to 1 either way.
    const over = el.scrollHeight - el.clientHeight;
    if (over < 2 || over > 4) return false;
    // Only when what it cuts off draws something: a glyph, a picture, a fill.
    const bottom = el.getBoundingClientRect().bottom;
    return [...el.querySelectorAll("*")].some((child) => {
      const r = child.getBoundingClientRect();
      if (r.bottom <= bottom + 0.5 || r.height <= 0) return false;
      if (/^(CANVAS|SVG|IMG)$/i.test(child.tagName)) return true;
      if ([...child.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())) {
        const range = document.createRange();
        range.selectNodeContents(child);
        return [...range.getClientRects()].some((q) => q.height > 0 && q.bottom > bottom + 0.5);
      }
      return false;
    });
  }).map((el) => ({ px: el.scrollHeight - el.clientHeight, path: path(el) }));
  // A chart drawn for more rows than its box has: the box cuts its foot off.
  const overrun = [...body.querySelectorAll("[data-gloom-role=composite-chart]")].filter(visible).flatMap((chart) => {
    const r = chart.getBoundingClientRect();
    for (let e = chart.parentElement; e && e !== body.parentElement; e = e.parentElement) {
      const style = getComputedStyle(e);
      if (style.overflowY === "visible") continue;
      if (!clips(style)) return [];
      const over = r.bottom - e.getBoundingClientRect().bottom;
      return over > 0.5 ? [{ px: round(over), path: path(chart) }] : [];
    }
    return [];
  });

  // Right: the edge text may use.
  const probe = document.createElement("canvas").getContext("2d");
  const widthOf = (str, el) => { probe.font = getComputedStyle(el).font; return probe.measureText(str).width; };
  // Text cut short in code (an ellipsis in the string) with room left after it
  // on its line: cut at a count of columns rather than where its box ends.
  const cut = [];
  for (const l of lines) {
    if (!/(\\.\\.\\.|\\u2026)$/.test(l.text.trimEnd()) || l.el.closest("input, textarea, [data-gloom-role=spinner], [data-gloom-ui=spinner]")) continue;
    const row = l.el.closest("button, [role=button], [data-gloom-interactive=true]") ?? boxOf(l.el.parentElement ?? l.el);
    const after = lines.filter((m) => m !== l && Math.abs(m.top - l.top) < 2 && m.left >= l.right - 1 && row.contains(m.el));
    const edge = after.length ? Math.min(...after.map((m) => m.left)) : Math.min(row.getBoundingClientRect().right, l.clip.right);
    const room = edge - l.right;
    if (room >= widthOf("000", l.el)) cut.push({ room: round(room), text: l.text.trimEnd().slice(-30), whole: (l.el.textContent ?? "").trim().slice(0, 400), path: path(l.el) });
  }
  const scrollerOf = (el) => { for (let e = el; e && e !== body; e = e.parentElement) { if (/(auto|scroll)/.test(getComputedStyle(e).overflowY)) return e; } return body; };
  const innerRightOf = (el) => {
    const sc = scrollerOf(el);
    const r = sc.getBoundingClientRect();
    const s = getComputedStyle(sc);
    let right = sc === body ? B.right : r.left + sc.clientLeft + sc.clientWidth - (parseFloat(s.paddingRight) || 0);
    for (let e = el.parentElement; e && e !== sc; e = e.parentElement) {
      const cs = getComputedStyle(e);
      // A box's own inset (a padded column) is not width the text could use.
      // A box given a fixed width in pixels is what is measured, not an edge.
      if (!e.style?.width?.endsWith("px")) {
        right = Math.min(right, e.getBoundingClientRect().right - (parseFloat(cs.paddingRight) || 0) - (parseFloat(cs.borderRightWidth) || 0));
      }
      // A deliberate reading measure, set in CSS as a max-width, is the edge text wraps at.
      if (cs.maxWidth !== "none") break;
    }
    return right;
  };
  const inTable = (el) => !!el.closest("[data-gloom-role^=data-table], [data-gloom-role=chat-message-row], [role=grid], table, input, textarea");
  const usable = lines.filter((l) => !inTable(l.el) && l.text.trim() && l.bottom > l.clip.top && l.top < l.clip.bottom);
  usable.sort((a, b) => a.top - b.top || a.left - b.left);
  const adjacent = (a, b) => { const pitch = b.top - a.top; return pitch > 2 && pitch <= Math.max(cellH, a.bottom - a.top) * 1.45; };
  // A line with other text before it on the same row starts something new: a list item after its marker, a value after its label.
  const startsAfterText = (l) => lines.some((m) => m !== l && Math.abs(m.top - l.top) < 2 && m.right <= l.left + 2 && m.right > l.left - 400);
  const blocks = [];
  const used = new Set();
  for (let i = 0; i < usable.length; i++) {
    if (used.has(i)) continue;
    const group = [usable[i]];
    used.add(i);
    let cur = usable[i];
    for (let j = i + 1; j < usable.length; j++) {
      const m = usable[j];
      if (used.has(j)) continue;
      if (Math.abs(m.left - cur.left) <= 1.5 && adjacent(cur, m) && scrollerOf(m.el) === scrollerOf(cur.el)) { group.push(m); used.add(j); cur = m; }
      else if (m.top - cur.top > Math.max(cellH, cur.bottom - cur.top) * 1.6) break;
    }
    if (group.length < 2) continue;
    const innerRight = innerRightOf(group[0].el);
    const tolerance = widthOf("0", group[0].el) + 1;
    let candidates = 0, premature = 0;
    const breaks = [];
    for (let k = 0; k + 1 < group.length; k++) {
      const l = group[k], next = group[k + 1];
      if (l.right - l.left < (innerRight - l.left) * 0.75) continue;
      // A line that ends a sentence and the next that starts one are two lines on purpose.
      if (/[.!?:]["')]?$/.test(l.text.trimEnd())) continue;
      if (/[…]$/.test(l.text.trimEnd())) continue;
      if (startsAfterText(next)) continue;
      // Each row of a list of actions is its own line.
      const itemOf = (el) => el.closest("button, [role=button], [data-gloom-interactive=true]");
      if (itemOf(l.el) !== itemOf(next.el)) continue;
      // A heading over its text, or a title over its summary, breaks on purpose.
      const a = getComputedStyle(l.el), b = getComputedStyle(next.el);
      if (a.fontWeight !== b.fontWeight || a.fontSize !== b.fontSize || a.color !== b.color) continue;
      const nextText = next.text.replace(/^\\s+/, "");
      if (/^([-*•·▸>#]|\\d+[.)]\\s|\\[)/.test(nextText)) continue;
      const word = nextText.split(/\\s+/)[0] ?? "";
      if (!word) continue;
      candidates += 1;
      if (innerRight - l.right - tolerance >= widthOf(" " + word, next.el)) {
        premature += 1;
        breaks.push(l.text.trimEnd().slice(-24) + " / " + word);
      }
    }
    const columnWrapped = premature >= 2 && premature >= candidates * 0.5;
    if (candidates === 0 && !columnWrapped) continue;
    blocks.push({ lines: group.length, candidates, premature, columnWrapped, rightGap: round(innerRight - Math.max(...group.map((g) => g.right))), tolerance: round(tolerance), sample: group[0].text.slice(0, 50), breaks: breaks.slice(0, 3), path: path(group[0].el) });
  }
  // Text that wraps inside a box given a fixed width in pixels (a count of
  // cells, in this renderer): that box should reach the edge the text may
  // use. Boxes the browser sizes (flex, grid, percentages) follow by themselves.
  // Inline runs (a bold word, a link) wrap inside the box that holds them.
  const fixedOf = (el) => { const sc = scrollerOf(el); for (let e = el; e && e !== sc && e !== body; e = e.parentElement) if (e.style?.width?.endsWith("px")) return e; return null; };
  const wrapped = [];
  const seen = new Set();
  for (const l of usable) {
    const box = boxOf(l.el);
    if (seen.has(box)) continue;
    seen.add(box);
    const rows = new Set(usable.filter((m) => box.contains(m.el)).map((m) => Math.round(m.top))).size;
    if (rows < 2) continue;
    const fixed = fixedOf(box);
    if (!fixed) continue;
    const innerRight = innerRightOf(box);
    wrapped.push({ rightGap: round(innerRight - fixed.getBoundingClientRect().right), tolerance: round(widthOf("0", box) + 1), lines: rows, path: path(fixed) });
  }
  wrapped.sort((a, b) => b.rightGap - a.rightGap);

  const snapped = [];
  const isMultiple = (v, u) => Math.abs(v / u - Math.round(v / u)) < 0.01;
  for (const el of all) {
    const st = el.style;
    // A size given in whole cells that the box really has: a fill that overrides it in CSS does not count.
    const rect = el.getBoundingClientRect();
    const w = st.width?.endsWith("px") && Math.abs(parseFloat(st.width) - rect.width) < 0.5 ? parseFloat(st.width) : null;
    const h = st.height?.endsWith("px") && Math.abs(parseFloat(st.height) - rect.height) < 0.5 ? parseFloat(st.height) : null;
    if (w != null && w >= B.width * 0.75 && isMultiple(w, cellW) && !isMultiple(B.width, cellW) && B.width - w > 0.5 && B.width - w < cellW * 3) snapped.push({ axis: "x", px: w, body: round(B.width), short: round(B.width - w), path: path(el) });
    if (h != null && h >= B.height * 0.6 && isMultiple(h, cellH) && !isMultiple(B.height, cellH) && B.height - h > 0.5 && B.height - h < cellH * 3) snapped.push({ axis: "y", px: h, body: round(B.height), short: round(B.height - h), path: path(el) });
  }
  return {
    body: { width: round(B.width), height: round(B.height) },
    cell: { width: cellW, height: cellH },
    footerGap: round(footerTop - B.bottom),
    bottomGap: gaps[0] ?? null,
    blocks: blocks.sort((a, b) => Number(b.columnWrapped) - Number(a.columnWrapped) || b.rightGap - a.rightGap),
    wrapped,
    snapped,
    clipped,
    overrun,
    cut,
    detailOpen: !!pane.querySelector("[data-gloom-role=page-stack-detail]"),
    text: (body.innerText || "").slice(0, 160),
  };
})()`;

/** What fails a pane: content short of the footer, or text short of its width. Empty when it passes. */
export function layoutFailures(measure: LayoutMeasure): string[] {
  const failures: string[] = [];
  if (measure.footerGap > 1) failures.push(`the body ends ${measure.footerGap}px above the footer`);
  if (measure.bottomGap && measure.bottomGap.gap > 1) failures.push(`${measure.bottomGap.path} stops ${measure.bottomGap.gap}px above the footer`);
  for (const block of measure.blocks.filter((entry) => entry.columnWrapped)) {
    failures.push(`text wrapped at a column count, ${block.rightGap}px short of its width ("${block.sample}", ${block.path})`);
  }
  for (const entry of measure.clipped ?? []) failures.push(`content ${entry.px}px taller than the box that clips it (${entry.path})`);
  for (const entry of measure.overrun ?? []) failures.push(`a chart runs ${entry.px}px past the box that clips it (${entry.path})`);
  for (const entry of measure.cut ?? []) failures.push(`text cut at a column count with ${entry.room}px left after it ("${entry.text}", ${entry.path})`);
  for (const entry of measure.wrapped.filter((item) => item.rightGap > item.tolerance)) {
    failures.push(`text wraps in a fixed-width box ${entry.rightGap}px short of its width (${entry.path})`);
  }
  return failures;
}
