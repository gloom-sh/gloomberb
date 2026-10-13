import { drag, evaluate, frames, mouse, waitFor, type Cdp, type Point } from "./browser";

/**
 * Text selection on the desktop and the web, with real pointer and key input
 * (GLO-668). The app is chrome, not a document: pressing Ctrl+A, double or
 * triple clicking a label and dragging across panes selects nothing, while the
 * text people copy by hand (reader and markdown text, a chat message, a field)
 * still selects.
 *
 * Chrome reads the plain `user-select`; WebKit, the macOS app's WKWebView,
 * reads only `-webkit-user-select`, so a rule written with one spelling passes
 * here and fails there. `selection-style.test.ts` keeps both spellings in the
 * stylesheet and the host; the native WebKit view is not driven by this runner.
 */

interface SelectionStep {
  name: string;
  scenario: string;
  run(cdp: Cdp): Promise<void>;
}

interface Target extends Point { text: string; userSelect: string }

/** What opts text in: fields, and the marker a block of copyable text carries. */
const SELECTABLE = "input, textarea, select, [contenteditable]:not([contenteditable=false]), [data-gloom-selectable=true]";

const SELECTION_HELPERS = `
window.__select = {
  text() { return window.getSelection()?.toString() ?? ''; },
  clear() { window.getSelection()?.removeAllRanges(); },
  /** Where each run of visible interface text is, in the page, evenly sampled to \`limit\`. */
  targets(limit) {
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || !node.nodeValue.trim() || element.closest('script, style, ${SELECTABLE}')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width < 6 || r.height < 6 || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) continue;
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(element.contains(hit) || hit.contains(element))) continue;
      found.push({ x, y, text: node.nodeValue.trim().slice(0, 28), userSelect: getComputedStyle(element).userSelect });
    }
    const step = Math.max(1, Math.floor(found.length / limit));
    return found.filter((_, index) => index % step === 0).slice(0, limit);
  },
  /** The middle of the first run of at least \`min\` characters under \`selector\`, with the text of the element it sits in. */
  copyable(selector, min) {
    for (const root of document.querySelectorAll(selector)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeValue.trim().length < min) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const r = range.getBoundingClientRect();
        if (r.width < 6 || r.top < 0 || r.bottom > innerHeight) continue;
        return { x: r.x + Math.min(r.width / 2, 60), y: r.y + r.height / 2, text: node.nodeValue.trim() };
      }
    }
    return null;
  },
  paneText(role) {
    return [...document.querySelectorAll('[data-gloom-role=' + role + ']')].map((element) => element.innerText.trim()).filter(Boolean);
  },
};
`;

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`);
}

const selectedText = (cdp: Cdp) => evaluate<string>(cdp, "__select.text()");

/** Ctrl+A as the keyboard sends it: the key, and the editing command the browser binds to it. */
async function pressSelectAll(cdp: Cdp): Promise<void> {
  const key = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key, commands: ["selectAll"] });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  await frames(cdp, 2);
}

/** Press and release `count` times at `at`: 2 is a double click, 3 a triple click. */
async function multiClick(cdp: Cdp, at: Point, count: number): Promise<void> {
  await mouse(cdp, "mouseMoved", at.x, at.y, false);
  for (let clickCount = 1; clickCount <= count; clickCount += 1) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount });
  }
  await frames(cdp, 2);
}

async function ready(cdp: Cdp): Promise<void> {
  await evaluate(cdp, SELECTION_HELPERS);
  // The panes settle (fonts, the chart's first frame) over a few frames.
  await frames(cdp, 20);
}

/** Nothing of the interface is selected by any of the ways a person could select it. */
async function expectInterfaceUnselectable(cdp: Cdp, minTargets: number): Promise<void> {
  await ready(cdp);
  const targets = await evaluate<Target[]>(cdp, "__select.targets(14)");
  if (targets.length < minTargets) fail(`the fixture shows only ${targets.length} runs of interface text, too few to check`, targets);

  // The computed value, for a message that names the culprit.
  const open = targets.filter((target) => target.userSelect !== "none");
  if (open.length > 0) fail("interface text that is not user-select: none", open.map((target) => target.text));

  await pressSelectAll(cdp);
  const keyed = await selectedText(cdp);
  if (keyed) fail("Ctrl+A selected interface text", keyed.slice(0, 160));
  await evaluate(cdp, "__select.clear()");

  // Edit > Select All in the desktop menu runs the same command without a key.
  await evaluate(cdp, "document.execCommand('selectAll')");
  const menu = await selectedText(cdp);
  if (menu) fail("Select All selected interface text", menu.slice(0, 160));
  await evaluate(cdp, "__select.clear()");

  for (const target of targets.slice(0, 8)) {
    await multiClick(cdp, target, 2);
    const word = await selectedText(cdp);
    if (word) fail(`a double click on "${target.text}" selected text`, word.slice(0, 80));
    await multiClick(cdp, target, 3);
    const line = await selectedText(cdp);
    if (line) fail(`a triple click on "${target.text}" selected text`, line.slice(0, 80));
    await evaluate(cdp, "__select.clear()");
  }

  // From the first run of text to the last, across headers, tabs, labels and bodies.
  const first = targets[0]!;
  const last = targets[targets.length - 1]!;
  await mouse(cdp, "mouseMoved", first.x, first.y, false);
  await mouse(cdp, "mousePressed", first.x, first.y, true);
  let during = "";
  for (let step = 1; step <= 16; step += 1) {
    await mouse(cdp, "mouseMoved", first.x + ((last.x - first.x) * step) / 16, first.y + ((last.y - first.y) * step) / 16, true);
    if (step % 4 === 0) await frames(cdp);
    during ||= await selectedText(cdp);
  }
  await mouse(cdp, "mouseReleased", last.x, last.y, false);
  await frames(cdp, 2);
  const dragged = during || await selectedText(cdp);
  if (dragged) fail("dragging across the interface selected text", dragged.slice(0, 160));
}

const INTERFACE: Array<{ scenario: string; label: string; minTargets: number }> = [
  { scenario: "cmp&chart=readout", label: "a chart pane: its axis labels, legend, toolbar and tabs", minTargets: 8 },
  { scenario: "docked", label: "docked panes: their headers, tabs and footers", minTargets: 8 },
];

/** Text people copy by hand, and what stays out of the selection beside it. */
async function expectCopyable(cdp: Cdp, selector: string, outside: string[]): Promise<void> {
  await ready(cdp);
  const spot = await waitFor<{ x: number; y: number; text: string } | null>(cdp, `__select.copyable(${JSON.stringify(selector)}, 24)`, 8_000)
    ?? fail(`no copyable text under ${selector}`);

  await multiClick(cdp, spot, 2);
  const word = (await selectedText(cdp)).trim();
  if (!word || !spot.text.includes(word)) fail("a double click on copyable text did not select a word of it", { word, text: spot.text.slice(0, 80) });
  await evaluate(cdp, "__select.clear()");

  await multiClick(cdp, spot, 3);
  const paragraph = (await selectedText(cdp)).trim();
  if (paragraph.length <= word.length) fail("a triple click on copyable text did not select more than a word", { word, paragraph });
  await evaluate(cdp, "__select.clear()");

  await pressSelectAll(cdp);
  const all = await selectedText(cdp);
  if (!all.includes(paragraph.slice(0, 20))) fail("Ctrl+A did not select the copyable text", all.slice(0, 160));
  const leaked = (await evaluate<string[]>(cdp, `(${JSON.stringify(outside)}).flatMap((role) => __select.paneText(role))`)).filter((text) => all.includes(text));
  if (leaked.length > 0) fail("Ctrl+A also selected the interface around the copyable text", leaked);

  // Dragging from inside it out over the chrome selects the text it crossed, nothing of the chrome.
  await evaluate(cdp, "__select.clear()");
  await drag(cdp, spot, [{ x: spot.x + 40, y: spot.y + 30 }], 6);
  if (!await selectedText(cdp)) fail("dragging across copyable text selected nothing");
  await evaluate(cdp, "__select.clear()");
}

export const selectionSteps: SelectionStep[] = [
  ...INTERFACE.map(({ scenario, label, minTargets }): SelectionStep => ({
    name: `selection: ${label} cannot be selected with Ctrl+A, Select All, a double or triple click, or a drag across`,
    scenario,
    run: (cdp) => expectInterfaceUnselectable(cdp, minTargets),
  })),
  {
    name: "selection: the article reader's text can be selected, and nothing around it",
    scenario: "layout&pane=reader&mode=dock",
    run: (cdp) => expectCopyable(cdp, "[data-gloom-ui=reader-column]", ["pane-header", "pane-footer"]),
  },
  {
    name: "selection: markdown can be selected, and nothing around it",
    scenario: "layout&pane=markdown&mode=dock",
    run: (cdp) => expectCopyable(cdp, "[data-gloom-selectable=true]", ["pane-header", "pane-footer"]),
  },
  {
    name: "selection: a chat message can be selected, and nothing around it",
    scenario: "chat",
    run: (cdp) => expectCopyable(cdp, "[data-gloom-role=chat-message-body]", ["pane-header", "pane-footer"]),
  },
  {
    name: "selection: a field takes typing, keeps its caret and selects its own text",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      const box = await waitFor<Point | null>(cdp, "(() => { const r = document.querySelector('textarea')?.getBoundingClientRect(); return r && { x: r.x + 24, y: r.y + r.height / 2 }; })()", 5_000)
        ?? fail("the chat fixture has no composer");
      await mouse(cdp, "mouseMoved", box.x, box.y, false);
      await mouse(cdp, "mousePressed", box.x, box.y, true);
      await mouse(cdp, "mouseReleased", box.x, box.y, false);
      await frames(cdp, 3);
      await cdp.send("Input.insertText", { text: "a draft I may want to copy" });
      await frames(cdp, 3);
      const typed = await evaluate<{ value: string; focused: boolean; caret: number }>(cdp, "(() => { const t = document.querySelector('textarea'); return { value: t.value, focused: document.activeElement === t, caret: t.selectionStart }; })()");
      if (!typed.focused || typed.value !== "a draft I may want to copy" || typed.caret !== typed.value.length) fail("typing into the field did not land with its caret at the end", typed);

      await pressSelectAll(cdp);
      const selected = await evaluate<{ start: number; end: number; length: number }>(cdp, "(() => { const t = document.querySelector('textarea'); return { start: t.selectionStart, end: t.selectionEnd, length: t.value.length }; })()");
      if (selected.start !== 0 || selected.end !== selected.length) fail("Ctrl+A in the field did not select its text", selected);
    },
  },
];
