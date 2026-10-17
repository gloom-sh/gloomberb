/**
 * What the UI audit (ui-audit.ts) reads from one view in the page.
 *
 * - `texts`: every visible run of text with its computed type and colour,
 *   where it sits against the edge of the box it belongs to (the pane body,
 *   header or footer, a dialog, the app's header or status bar), and which
 *   component drew it.
 * - `elements`: every element of a family the design system names (buttons,
 *   tabs, chips, fields, toggles, links, table and list rows, key-value rows,
 *   section headings, cards, dividers, empty/loading/error/locked states, the
 *   pane's title bar, footer, tab bar, back row and toolbar, dialogs, menus,
 *   tooltips, chart chrome) with its shape (size, padding, border, radius,
 *   shadow, type) and colours. Elements of one family with the same shape
 *   are one variant; `sample` is where the first one in view is, so the audit
 *   can picture it.
 *
 * Runs and elements are grouped by everything recorded about them except
 * position, so a table of 400 cells is one run counted 400 times. Roles and
 * colour names are not decided here: the report (ui-audit-report.ts) reads
 * them from the recorded DOM roles, components and the theme, so a better
 * reading needs no new sweep.
 *
 * Components are read from React's fibers, so the page has to be built with
 * names kept (`bun scripts/build-web.ts --keep-names`).
 */

export interface AuditTextRun {
  /** pane-header, pane-body, pane-footer, dialog, command-bar, menu, toast, app-header, status-bar or shell. */
  region: string;
  /** DOM roles (data-gloom-role, data-gloom-ui, gloom-* classes) from the text up to its region, nearest first. */
  roles: string;
  /** Semantic elements around it: button, a, input, label, th, td, h1..h6, li, role=tab, role=option. */
  tags: string;
  /** The nearest component that is not a primitive (Text, Box, a Web* host), with ReaderText's variant. */
  component: string;
  /** Up to eight named components, nearest first. */
  chain: string;
  fontSize: number;
  /** In px; 0 when the computed value is `normal`. */
  lineHeight: number;
  fontWeight: number;
  fontFamily: string;
  italic: boolean;
  uppercase: boolean;
  letterSpacing: number;
  underline: boolean;
  color: string;
  /** The background the text sits on (its own or the nearest painted ancestor's). */
  background: string;
  count: number;
  chars: number;
  /** Lines the text wraps to, at most, in one element. */
  lines: number;
  /** Least distance from the region's left edge to the text, px. */
  left: number;
  /** Least distance from the text's right end to the region's right edge, px. */
  rightGap: number;
  /** Least distance from the region's top to the text, px. */
  top: number;
  sample: string;
}

/** One family member's look: the shape (what makes a variant) and its colours. */
export interface AuditElement {
  family: string;
  region: string;
  component: string;
  chain: string;
  roles: string;
  /** Selected, pressed, checked, current, disabled, from ARIA and data attributes. */
  state: string;
  /** Shape: everything but colour, as `key=value` pairs. Equal shapes in one family are one variant. */
  shape: string;
  /** Colours: text, background, border, as computed. */
  color: string;
  background: string;
  borderColor: string;
  count: number;
  /** The first one in view, in page coordinates, for a picture. */
  sample: { x: number; y: number; width: number; height: number } | null;
  text: string;
}

interface AuditRow {
  kind: string;
  component: string;
  height: number;
  count: number;
}

export interface AuditMeasure {
  missing?: boolean;
  /** The box the view's insets are measured against: the pane body, or the viewport for a shell view. */
  edge: { width: number; height: number };
  /** Least distance from the pane body's edges to visible text in it, px; null when the body shows no text. */
  inset: { left: number; right: number; top: number } | null;
  /** Width of the vertical scrollbar of the body's main scroller, px. */
  scrollbar: number;
  /** A capped reading column in the body (a CSS max-width): its width and left edge. */
  column: { width: number; left: number } | null;
  /** The theme's colours as the page has them (`--gloom-*`), for naming the colours recorded. */
  palette: Record<string, string>;
  texts: AuditTextRun[];
  elements: AuditElement[];
  rows: AuditRow[];
  /** Charts, maps and pictures over 40 px, which carry their own type. */
  media: number;
  /** A sign-in wall, gate or Pro lock is showing. */
  gated: boolean;
  detailOpen: boolean;
  text: string;
}

/**
 * The measuring script for one view. `scope` is a pane's instance id, or null
 * for the whole window (the shell, the command bar, a dialog).
 */
export const UI_AUDIT_MEASURE = (scope: string | null) => `(() => {
  const scopeEl = ${scope ? `document.querySelector(${JSON.stringify(`[data-gloom-pane-id="${scope}"]`)})` : "document.body"};
  if (!scopeEl) return { missing: true };
  const body = ${scope ? `scopeEl.querySelector("[data-gloom-role=pane-body]")` : "null"};
  ${scope ? "if (!body) return { missing: true };" : ""}
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
  const B = body ? body.getBoundingClientRect() : viewport;
  const round = (v) => Math.round(v * 100) / 100;
  const px = (v) => Math.round((parseFloat(v) || 0) * 10) / 10;
  const styleCache = new Map();
  const css = (el) => { let s = styleCache.get(el); if (!s) { s = getComputedStyle(el); styleCache.set(el, s); } return s; };
  const visibleCache = new Map();
  const visible = (el) => {
    if (!el || el === document.documentElement) return true;
    if (visibleCache.has(el)) return visibleCache.get(el);
    const s = css(el);
    const v = !(s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) <= 0.01) && visible(el.parentElement);
    visibleCache.set(el, v);
    return v;
  };
  const transparent = (c) => !c || c === "transparent" || /rgba\\([^)]*,\\s*0\\)$/.test(c);
  const backgroundOf = (el) => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) { const c = css(e).backgroundColor; if (!transparent(c)) return c; } return css(document.body).backgroundColor; };

  // Components, from React's fibers.
  const fiberKey = (el) => { for (const k in el) if (k.startsWith("__reactFiber$")) return k; return null; };
  const PRIMITIVE = /^(Web[A-Z]\\w*|Text|Box|ScrollBox|Span|TextLines|Fragment|Suspense|StrictMode|AsciiText|ThemeProvider|.*Provider|.*Context|.*Boundary|PaneRenderTrace|PluginSlot)$/;
  const nameOf = (f) => {
    const t = f.type;
    if (typeof t === "function") return t.displayName || t.name || "";
    if (t && typeof t === "object") {
      const inner = t.render || t.type;
      if (typeof inner === "function") return inner.displayName || inner.name || "";
    }
    return "";
  };
  const componentCache = new Map();
  const componentsOf = (el) => {
    if (componentCache.has(el)) return componentCache.get(el);
    const k = fiberKey(el);
    let f = k ? el[k] : null;
    const names = [];
    let first = "";
    for (let depth = 0; f && depth < 80 && names.length < 8; depth++, f = f.return) {
      const n = nameOf(f);
      if (!n || n === names[names.length - 1]) continue;
      let label = n;
      if (n === "ReaderText" && f.memoizedProps?.variant) label = "ReaderText:" + f.memoizedProps.variant;
      if (!first && !PRIMITIVE.test(n)) first = label;
      names.push(label);
    }
    const value = { component: first || names[0] || "", chain: names.join("<") };
    componentCache.set(el, value);
    return value;
  };

  // Where an element is, and the box its insets are measured against.
  const REGIONS = [
    ["pane-header", "[data-gloom-role=pane-header]"],
    ["pane-footer", "[data-gloom-role=pane-footer]"],
    ["pane-body", "[data-gloom-role=pane-body]"],
    ["dialog", "[role=dialog], .gloom-dialog, [data-gloom-role=onboarding-modal]"],
    ["command-bar", "[data-gloom-role=command-bar-panel]"],
    ["menu", ".gloom-menu, .gloom-popover, [role=menu]"],
    ["toast", ".gloom-toast"],
    ["app-header", "[data-gloom-role=app-header]"],
    ["status-bar", "[data-gloom-role=status-bar]"],
  ];
  const regionOf = (el) => {
    let best = null;
    for (const [name, selector] of REGIONS) {
      const box = el.closest(selector);
      if (box && (!best || best.box.contains(box))) best = { name, box };
    }
    return best ?? { name: "shell", box: document.body };
  };
  const roleOf = (e) => e.getAttribute("data-gloom-role") ?? e.getAttribute("data-gloom-ui") ?? (([...e.classList].find((c) => c.startsWith("gloom-")) ?? "").replace(/^gloom-/, ".") || null);
  const rolesOf = (el, stop) => {
    const out = [];
    for (let e = el; e && e !== stop && out.length < 8; e = e.parentElement) { const role = roleOf(e); if (role) out.push(role); }
    return out.join("<");
  };
  const tagsOf = (el, stop) => {
    const out = [];
    for (let e = el; e && e !== stop && out.length < 6; e = e.parentElement) {
      const tag = e.tagName.toLowerCase();
      const role = e.getAttribute("role");
      if (/^(button|a|input|textarea|select|label|th|td|h[1-6]|li|summary|code|pre)$/.test(tag)) out.push(tag);
      if (role && /^(button|tab|option|row|gridcell|columnheader|link|menuitem|heading|checkbox|switch|radio|textbox)$/.test(role)) out.push("role=" + role);
    }
    return [...new Set(out)].join(",");
  };
  const clipCache = new Map();
  const clipOf = (el) => {
    const parent = el.parentElement;
    if (!parent || parent === document.documentElement) return { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
    if (clipCache.has(parent)) return clipCache.get(parent);
    let r = clipOf(parent);
    const s = css(parent);
    if (s.overflowY !== "visible" || s.overflowX !== "visible") {
      const q = parent.getBoundingClientRect();
      r = { top: Math.max(r.top, q.top), bottom: Math.min(r.bottom, q.bottom), left: Math.max(r.left, q.left), right: Math.min(r.right, q.right) };
    }
    clipCache.set(parent, r);
    return r;
  };
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const c = clipOf(el);
    const x = Math.max(r.left, c.left), y = Math.max(r.top, c.top), right = Math.min(r.right, c.right), bottom = Math.min(r.bottom, c.bottom);
    if (right - x < 2 || bottom - y < 2) return null;
    return { x: round(x), y: round(y), width: round(right - x), height: round(bottom - y), whole: right - x >= r.width - 1 && bottom - y >= r.height - 1 };
  };

  // Text.
  const groups = new Map();
  const seen = new Set();
  const walker = document.createTreeWalker(scopeEl, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent;
    const el = node.parentElement;
    if (!text || !text.trim() || !el || el.closest("script, style, noscript")) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const clip = clipOf(el);
    const rects = [...range.getClientRects()].filter((q) => q.width > 0 && q.height > 0 && q.bottom > clip.top + 1 && q.top < clip.bottom - 1 && q.right > clip.left + 1 && q.left < clip.right - 1);
    if (!rects.length || !visible(el)) continue;
    const region = regionOf(el);
    const R = region.name === "pane-body" && body ? B : region.box.getBoundingClientRect();
    const s = css(el);
    const fontSize = round(parseFloat(s.fontSize));
    const lineHeight = s.lineHeight === "normal" ? 0 : round(parseFloat(s.lineHeight));
    const { component, chain } = componentsOf(el);
    const roles = rolesOf(el, region.box);
    const tags = tagsOf(el, region.box);
    const fontFamily = (s.fontFamily.split(",")[0] ?? "").replace(/["']/g, "").trim();
    const background = backgroundOf(el);
    const uppercase = s.textTransform === "uppercase";
    const letterSpacing = s.letterSpacing === "normal" ? 0 : px(s.letterSpacing);
    const underline = /underline/.test(s.textDecorationLine);
    const groupKey = [region.name, roles, tags, component, chain, fontSize, lineHeight, s.fontWeight, fontFamily, s.fontStyle, uppercase, letterSpacing, underline, s.color, background].join("|");
    // The right end of the box the text fills (a paragraph, a cell), not of its ragged last word.
    let block = el;
    while (block.parentElement && block !== region.box && /^(inline|contents)$/.test(css(block).display)) block = block.parentElement;
    const bs = css(block), br = block.getBoundingClientRect();
    const contentRight = Math.min(clip.right, br.right - (parseFloat(bs.paddingRight) || 0) - (parseFloat(bs.borderRightWidth) || 0));
    const left = Math.max(clip.left, Math.min(...rects.map((q) => q.left))), right = Math.max(contentRight, Math.min(clip.right, Math.max(...rects.map((q) => q.right)))), top = Math.min(...rects.map((q) => q.top));
    const lines = new Set(rects.map((q) => Math.round(q.top))).size;
    let g = groups.get(groupKey);
    if (!g) {
      g = { region: region.name, roles, tags, component, chain, fontSize, lineHeight, fontWeight: parseInt(s.fontWeight, 10) || 400, fontFamily, italic: s.fontStyle === "italic", uppercase, letterSpacing, underline, color: s.color, background, count: 0, chars: 0, lines: 0, left: Infinity, rightGap: Infinity, top: Infinity, sample: text.trim().slice(0, 60) };
      groups.set(groupKey, g);
    }
    if (!seen.has(el)) { seen.add(el); g.count += 1; }
    g.chars += text.trim().length;
    g.lines = Math.max(g.lines, lines);
    g.left = Math.min(g.left, round(left - R.left));
    g.rightGap = Math.min(g.rightGap, round(R.right - right));
    g.top = Math.min(g.top, round(top - R.top));
  }
  const texts = [...groups.values()];

  // Families. The first rule an element meets names its family.
  // The component an element is the outermost element of: its first host node. An inner span of a badge is not a badge.
  const rootOf = (el, primitives = false) => {
    const k = fiberKey(el);
    for (let f = k ? el[k].return : null; f; f = f.return) {
      if (f.tag === 5) return "";
      const n = nameOf(f);
      if (n && (primitives || !PRIMITIVE.test(n))) return n;
    }
    return "";
  };
  const nearest = (el) => rootOf(el);
  const has = (el, re) => re.test(rootOf(el));
  const role = (el) => el.getAttribute("data-gloom-role") ?? el.getAttribute("data-gloom-ui") ?? "";
  const R = (...names) => (el) => names.includes(role(el));
  const drawsMark = (el) => { const s = css(el); return !transparent(s.backgroundColor) || ["Top", "Right", "Bottom", "Left"].some((side) => px(s["border" + side + "Width"]) > 0); };
  const FAMILY_RULES = [
    ["pane-title-bar", R("pane-header")],
    ["pane-footer", R("pane-footer")],
    ["pane-hint", R("pane-hint")],
    ["app-header", R("app-header")],
    ["status-bar", R("status-bar")],
    ["back-row", R("page-stack-header")],
    ["tab-bar", (el) => el.getAttribute("role") === "tablist" || R("tab-list", "tab-strip", "pane-header-tabs")(el)],
    ["tab", (el) => el.getAttribute("role") === "tab"],
    ["toolbar", (el) => R("query-bar", "inline-quick-add")(el) || el.classList.contains("gloom-qb-filters") || el.classList.contains("gloom-qb-search")],
    ["dialog", (el) => el.getAttribute("role") === "dialog" || el.classList.contains("gloom-dialog") || R("onboarding-modal")(el)],
    ["menu", (el) => el.getAttribute("role") === "menu" || el.classList.contains("gloom-menu") || R("menu")(el)],
    ["menu-item", (el) => el.getAttribute("role") === "menuitem" || el.classList.contains("gloom-menu-item")],
    ["tooltip", (el) => el.getAttribute("role") === "tooltip" || el.classList.contains("gloom-popover") || /tooltip/.test(role(el))],
    ["toast", (el) => el.classList.contains("gloom-toast")],
    ["state-locked", (el) => R("sign-in-wall", "sign-in-gate", "pro-lock", "wall-teaser", "trial-offer", "pane-lock")(el)],
    ["state-empty", (el) => R("empty-state")(el)],
    ["state-loading", (el) => R("spinner")(el) || el.getAttribute("data-gloom-ui") === "spinner"],
    ["state-notice", (el) => R("notice", "pane-status")(el)],
    ["table-header-row", R("data-table-header-row")],
    ["table-header-cell", R("data-table-header-cell")],
    ["table-section-row", R("data-table-section-header")],
    ["table-row", (el) => R("data-table-row")(el) || el.getAttribute("role") === "row" || el.tagName === "TR"],
    ["sort-indicator", R("data-table-sort-marker")],
    ["list-row", (el) => R("desktop-list-row", "pane-sidebar-item", "layout-gallery-row")(el) || el.getAttribute("role") === "option"],
    ["kv-row", R("key-value-row", "field-grid-row", "stat-grid-row", "pane-setting-row")],
    ["section-heading", (el) => R("section-heading")(el) || /^H[1-6]$/.test(el.tagName) || el.getAttribute("role") === "heading"],
    ["divider", (el) => R("divider")(el) || el.tagName === "HR"],
    ["segmented", (el) => nearest(el) === "SegmentedControl"],
    ["field-label", (el) => nearest(el) === "FieldLabel"],
    ["state-loading", (el) => /^(Spinner|LoadingState|Skeleton)/.test(nearest(el))],
    ["state-empty", (el) => /^(EmptyState|PaneStatusBody)$/.test(nearest(el))],
    ["state-notice", (el) => nearest(el) === "Notice"],
    ["input", (el) => (el.tagName === "INPUT" && !/^(checkbox|radio|range|button|submit)$/.test(el.type)) || el.tagName === "TEXTAREA" || el.getAttribute("contenteditable") === "true"],
    ["select", (el) => el.tagName === "SELECT" || /^(SelectButton|SelectField|MultiSelectDialogButton)$/.test(nearest(el)) || el.getAttribute("role") === "combobox" || el.getAttribute("aria-haspopup") === "listbox"],
    ["toggle", (el) => /^(Checkbox|Toggle|Switch)$/.test(nearest(el)) || /^(switch|checkbox|radio)$/.test(el.getAttribute("role") ?? "") || (el.tagName === "INPUT" && /^(checkbox|radio)$/.test(el.type))],
    ["link", (el) => el.tagName === "A" || el.getAttribute("role") === "link"],
    ["keycap", (el) => /^(WebKeycap|Keycap|Kbd)$/.test(rootOf(el, true)) || el.tagName === "KBD" || el.classList.contains("gloom-qb-kbd")],
    // A chip is a mark: the box that draws a fill or a border. The box around one, or a word
    // a component happens to call a chip (a status bar item, a query bar segment), is not one.
    // A chip that opens something (a ticker) is still a chip: this comes before buttons.
    ["chip", (el) => (has(el, /^\\w*(Badge|Chip|Pill|Tag|Pip)$/) || /chip|badge/.test(role(el))) && drawsMark(el)],
    ["button", (el) => el.tagName === "BUTTON" || el.getAttribute("role") === "button" || R("desktop-button", "icon-button", "pane-action", "pane-close", "pane-restore", "data-table-section-action", "pane-sidebar-action")(el)],
    ["legend", (el) => /legend/.test(role(el))],
    ["axis", (el) => /axis/.test(role(el))],
  ];
  const familyOf = (el) => { for (const [name, test] of FAMILY_RULES) if (test(el)) return name; return null; };
  const borderOf = (s) => {
    const w = [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].map(px);
    const st = [s.borderTopStyle, s.borderRightStyle, s.borderBottomStyle, s.borderLeftStyle];
    const on = w.map((v, i) => v > 0 && st[i] !== "none" && st[i] !== "hidden" ? v : 0);
    const label = on.every((v) => v === on[0]) ? String(on[0]) : on.join("/");
    const colour = [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor].find((c, i) => on[i] > 0) ?? "";
    return { label, colour };
  };
  const firstTextStyle = (el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.trim() && n.parentElement && visible(n.parentElement)) return { s: css(n.parentElement), text: n.textContent.trim() };
    return null;
  };
  const stateOf = (el) => {
    const out = [];
    for (const [attr, name] of [["aria-selected", "selected"], ["aria-pressed", "pressed"], ["aria-checked", "checked"], ["aria-current", "current"], ["aria-expanded", "expanded"], ["data-selected", "selected"], ["data-active", "active"], ["data-focused", "focused"], ["aria-disabled", "disabled"]]) {
      const v = el.getAttribute(attr);
      if (v && v !== "false") out.push(name);
    }
    if (el.disabled) out.push("disabled");
    const status = el.getAttribute("data-gloom-status");
    if (status) out.push(status);
    return [...new Set(out)].join(",");
  };
  const elementGroups = new Map();
  for (const el of [scopeEl, ...scopeEl.querySelectorAll("*")]) {
    if (el.closest("svg") && el.tagName !== "svg") continue;
    const family = familyOf(el);
    if (!family) continue;
    if (!visible(el)) continue;
    const view = inView(el);
    if (!view) continue;
    const s = css(el);
    const r = el.getBoundingClientRect();
    const t = firstTextStyle(el);
    const border = borderOf(s);
    const radius = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map(px);
    const iconOnly = (el.textContent ?? "").trim().length <= 2;
    const shape = [
      "h=" + Math.round(r.height),
      ["button", "chip", "keycap", "tab", "input", "select", "toggle"].includes(family) ? "w=" + (iconOnly ? Math.round(r.width) : "auto") : "",
      "pad=" + [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(px).join(" "),
      "border=" + border.label,
      "radius=" + (radius.every((v) => v === radius[0]) ? radius[0] : radius.join(" ")),
      s.boxShadow !== "none" ? "shadow=" + s.boxShadow.replace(/rgba?\\([^)]*\\)/g, "c").slice(0, 60) : "",
      parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== "none" ? "outline=" + px(s.outlineWidth) : "",
      t ? "font=" + px(t.s.fontSize) + "/" + t.s.fontWeight + (t.s.textTransform === "uppercase" ? "/upper" : "") + (/underline/.test(t.s.textDecorationLine) ? "/underline" : "") + (t.s.fontStyle === "italic" ? "/italic" : "") : "font=none",
      iconOnly ? "icon" : "",
      transparent(s.backgroundColor) ? "fill=none" : "fill=own",
    ].filter(Boolean).join(" ");
    const { component, chain } = componentsOf(el);
    const region = regionOf(el).name;
    const state = stateOf(el);
    const colour = t ? t.s.color : s.color;
    const background = transparent(s.backgroundColor) ? "" : s.backgroundColor;
    const k = [family, region, component, state, shape, colour, background, border.colour].join("|");
    const g = elementGroups.get(k) ?? { family, region, component, chain, roles: rolesOf(el, document.body).split("<").slice(0, 4).join("<"), state, shape, color: colour, background, borderColor: border.colour, count: 0, sample: null, text: (t?.text ?? "").slice(0, 40) };
    g.count += 1;
    if (!g.sample && view.whole && view.width <= innerWidth && view.height <= innerHeight) g.sample = { x: view.x, y: view.y, width: view.width, height: view.height };
    elementGroups.set(k, g);
  }

  // Cards: boxes with a frame or a fill of their own that no family above names.
  const named = new Set();
  for (const el of scopeEl.querySelectorAll("*")) if (familyOf(el)) named.add(el);
  for (const el of scopeEl.querySelectorAll("div, section, article")) {
    if (named.has(el) || el.closest("svg")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 28 || r.width > B.width * 0.98 || !visible(el)) continue;
    const s = css(el);
    const border = borderOf(s);
    const framed = border.label.split("/").filter((v) => parseFloat(v) > 0).length >= 3 || (border.label !== "0" && !border.label.includes("/"));
    const filled = !transparent(s.backgroundColor) && s.backgroundColor !== backgroundOf(el.parentElement ?? document.body) && px(s.borderTopLeftRadius) > 0;
    if (!framed && !filled) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 1) || !el.textContent.trim()) continue;
    const view = inView(el);
    if (!view) continue;
    const t = firstTextStyle(el);
    const radius = px(s.borderTopLeftRadius);
    const shape = ["pad=" + [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(px).join(" "), "border=" + border.label, "radius=" + radius, s.boxShadow !== "none" ? "shadow" : "", t ? "font=" + px(t.s.fontSize) : ""].filter(Boolean).join(" ");
    const { component, chain } = componentsOf(el);
    const region = regionOf(el).name;
    const background = transparent(s.backgroundColor) ? "" : s.backgroundColor;
    const k = ["card", region, component, shape, background, border.colour].join("|");
    const g = elementGroups.get(k) ?? { family: "card", region, component, chain, roles: rolesOf(el, document.body).split("<").slice(0, 4).join("<"), state: "", shape, color: t?.s.color ?? "", background, borderColor: border.colour, count: 0, sample: null, text: (t?.text ?? "").slice(0, 40) };
    g.count += 1;
    if (!g.sample && view.whole && view.width <= innerWidth && view.height <= innerHeight) g.sample = { x: view.x, y: view.y, width: view.width, height: view.height };
    elementGroups.set(k, g);
  }

  // Rows of tables and lists, by the role or component that draws them.
  const ROW_SELECTOR = "[data-gloom-role=data-table-row], [data-gloom-role=data-table-header-row], [data-gloom-role=data-table-section-header], [data-gloom-role=desktop-list-row], [data-gloom-role=pane-sidebar-item], [data-gloom-role=key-value-row], [data-gloom-role=field-grid-row], [data-gloom-role=stat-grid-row], [data-gloom-role=pane-setting-row], [role=tab], [role=option], [role=row], [role=menuitem], .gloom-menu-item";
  const rowGroups = new Map();
  for (const el of scopeEl.querySelectorAll(ROW_SELECTOR)) {
    if (!inView(el) || !visible(el)) continue;
    const kind = el.getAttribute("data-gloom-role") ?? (el.getAttribute("role") ? "role=" + el.getAttribute("role") : [...el.classList].find((c) => c.startsWith("gloom-")) ?? el.tagName.toLowerCase());
    const { component } = componentsOf(el);
    const height = round(el.getBoundingClientRect().height);
    const k = kind + "|" + component + "|" + height;
    const g = rowGroups.get(k) ?? { kind, component, height, count: 0 };
    g.count += 1;
    rowGroups.set(k, g);
  }

  const media = [...scopeEl.querySelectorAll("canvas, svg, img, video")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 40; }).length;
  const bodyTexts = texts.filter((t) => t.region === "pane-body");
  const inset = body && bodyTexts.length ? {
    left: Math.min(...bodyTexts.map((t) => t.left)),
    right: Math.min(...bodyTexts.map((t) => t.rightGap)),
    top: Math.min(...bodyTexts.map((t) => t.top)),
  } : null;
  let scrollbar = 0;
  let column = null;
  if (body) {
    const scrollers = [...body.querySelectorAll("*")].filter((el) => /(auto|scroll)/.test(css(el).overflowY) && el.scrollHeight > el.clientHeight + 1 && el.getBoundingClientRect().width >= B.width * 0.5);
    if (scrollers[0]) scrollbar = round(scrollers[0].offsetWidth - scrollers[0].clientWidth - (parseFloat(css(scrollers[0]).borderLeftWidth) || 0) - (parseFloat(css(scrollers[0]).borderRightWidth) || 0));
    const capped = [...body.querySelectorAll("*")].find((el) => css(el).maxWidth !== "none" && el.getBoundingClientRect().width > B.width * 0.3 && el.getBoundingClientRect().width < B.width - 4 && el.textContent.trim().length > 200);
    if (capped) { const r = capped.getBoundingClientRect(); column = { width: round(r.width), left: round(r.left - B.left) }; }
  }
  const palette = {};
  const rootStyle = getComputedStyle(document.documentElement);
  const probe = document.createElement("span");
  document.body.appendChild(probe);
  for (const name of ["bg", "panel", "border", "border-focused", "text", "text-dim", "text-bright", "text-muted", "positive", "negative", "neutral", "warning", "header", "header-text", "selected", "selected-text", "command-bg", "command-border", "hover-bg"]) {
    const value = rootStyle.getPropertyValue("--gloom-" + name).trim();
    if (!value) continue;
    probe.style.color = value;
    palette[name] = getComputedStyle(probe).color;
  }
  probe.remove();
  return {
    edge: { width: round(B.width), height: round(B.height) },
    inset,
    scrollbar,
    column,
    palette,
    texts,
    elements: [...elementGroups.values()],
    rows: [...rowGroups.values()],
    media,
    gated: !!scopeEl.querySelector(["sign-in-wall", "sign-in-gate", "pro-lock", "wall-teaser"].map((name) => "[data-gloom-role=" + name + "], [data-gloom-ui=" + name + "]").join(", ")),
    detailOpen: !!scopeEl.querySelector("[data-gloom-role=page-stack-detail]"),
    text: ((body ?? scopeEl).innerText || "").slice(0, 160),
  };
})()`;
