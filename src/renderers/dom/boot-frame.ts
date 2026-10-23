/**
 * The layout a launch draws before the app is up.
 *
 * Loading the app's script and starting it takes a second or more, and the
 * page used to say "Loading Gloomberb..." for that time. Instead the app keeps
 * a copy of its own frame: the header, every pane's chrome with its title and
 * tabs, the dividers and the status bar, with each pane's body and footer
 * left empty. The page draws that copy before its script loads, over the
 * root the app renders into, and the app takes it down the first frame it
 * has drawn its own layout. The copy is redrawn only from the same build, in
 * a window of the same size: anything else could put panes where the app
 * will not. The page's side, the stored format and the script that draws
 * it, is boot-frame-page.ts.
 *
 * Each host keeps the copy where its page can read it before any script has
 * loaded: the web app in localStorage, the desktop app beside the remembered
 * window frame, handed to the window as it opens.
 */

import {
  BOOT_FRAME_BUILD_GLOBAL,
  BOOT_FRAME_ELEMENT_ID,
  BOOT_FRAME_SCROLL_ATTRIBUTE,
  MAX_BOOT_FRAME_CHARS,
  scrubBootFrame,
  type BootFrame,
} from "./boot-frame-page";

/** What a frame keeps: these elements, and the elements on the way to them. */
const FRAME_ROLES = ["app-header", "pane-window", "dock-divider", "status-bar"];
const FRAME_SELECTOR = FRAME_ROLES.map((role) => `[data-gloom-role="${role}"]`).join(", ");
/**
 * Kept empty: pane bodies and footers are most of the page and are the data
 * the app fills from its cache as it starts. The market state and SPY quote in
 * the header, an update status said last session ("Restart to update") and
 * the status bar's widgets (an unread count, the account) are not true at the
 * next launch.
 */
const EMPTIED_SELECTOR = [
  "pane-body",
  "pane-footer",
  "header-market",
  "header-update-status",
  "status-widgets",
].map((role) => `[data-gloom-role="${role}"]`).join(", ");

/** The build this page says it is, or null where no frame script ran (tests, other pages). */
function currentBootFrameBuild(win: Window = window): string | null {
  const build = (win as unknown as Record<string, unknown>)[BOOT_FRAME_BUILD_GLOBAL];
  return typeof build === "string" && build ? build : null;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * Copies what the frame keeps of `node`: frame elements whole but for their
 * data, and the elements on the way to them bare. Walks the live tree rather
 * than cloning it all, so pane bodies (most of the page) are never copied.
 */
function copyFrame(node: Node, insideFrame: boolean): Node | null {
  if (node.nodeType === TEXT_NODE) return insideFrame ? node.cloneNode(false) : null;
  if (node.nodeType !== ELEMENT_NODE) return null;
  const element = node as Element;
  const isFrame = insideFrame || element.matches(FRAME_SELECTOR);
  if (!isFrame && element.querySelector(FRAME_SELECTOR) === null) return null;
  const copy = element.cloneNode(false) as Element;
  if (isFrame && element.matches(EMPTIED_SELECTOR)) return copy;
  // A box scrolled by a pixel of overflow (the shell is) is drawn scrolled too.
  if (element.scrollTop || element.scrollLeft) {
    copy.setAttribute(BOOT_FRAME_SCROLL_ATTRIBUTE, `${Math.round(element.scrollTop)},${Math.round(element.scrollLeft)}`);
  }
  for (const child of element.childNodes) {
    const childCopy = copyFrame(child, isFrame);
    if (childCopy) copy.appendChild(childCopy);
  }
  return copy;
}

/**
 * The app's frame as it is drawn now, or null when there is none to keep: no
 * layout drawn yet, or a frame too large to store. A layout with every pane
 * closed is kept as it is, so the next launch does not draw panes the user
 * closed.
 */
export function captureBootFrame(doc: Document, root: Element, build: string): BootFrame | null {
  const view = doc.defaultView;
  if (!view || !root.querySelector('[data-gloom-role="pane-window"], [data-gloom-role="status-bar"]')) return null;
  const copy = copyFrame(root, false) as Element | null;
  if (copy) scrubBootFrame(copy);
  const html = copy?.innerHTML ?? "";
  if (!html || html.length > MAX_BOOT_FRAME_CHARS) return null;
  return {
    build,
    width: view.innerWidth,
    height: view.innerHeight,
    rootStyle: doc.documentElement.getAttribute("style") ?? "",
    bodyStyle: doc.body.getAttribute("style") ?? "",
    html,
  };
}

/** The status bar's text but its widgets', which the frame leaves empty: a new unread count is not a new layout. */
function statusBarLabels(statusBar: Element): string {
  return Array.from(statusBar.children)
    .filter((child) => child.getAttribute("data-gloom-role") !== "status-widgets")
    .map((child) => child.textContent ?? "")
    .join("");
}

/**
 * What would make a new frame differ from the last: the window, the theme
 * and where each pane is and what it is called. Cheap enough to read every
 * few seconds; the frame itself is only copied when this changes.
 */
export function bootFrameSignature(doc: Document, root: Element): string {
  const view = doc.defaultView;
  const parts: string[] = [
    `${view?.innerWidth ?? 0}x${view?.innerHeight ?? 0}`,
    doc.documentElement.getAttribute("style") ?? "",
    doc.body.getAttribute("style") ?? "",
  ];
  for (const element of root.querySelectorAll(
    '[data-gloom-role="pane-window"], [data-gloom-role="dock-divider"], [data-gloom-role="status-bar"]',
  )) {
    const rect = element.getBoundingClientRect();
    const role = element.getAttribute("data-gloom-role");
    parts.push([
      role,
      Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height),
      element.getAttribute("data-focused") ?? "",
      role === "status-bar" ? statusBarLabels(element) : element.querySelector('[data-gloom-role="pane-header"]')?.textContent ?? "",
    ].join(":"));
  }
  return parts.join("|");
}

const runningRecorders = new Set<() => void>();

/**
 * Stops every recorder on the page for good, before the data is reset: a
 * frame saved after the reset, as the page closes, would draw the old layout
 * at the next launch.
 */
export function stopBootFrameRecorders(): void {
  for (const stop of [...runningRecorders]) stop();
}

interface BootFrameRecorderOptions {
  doc: Document;
  root: Element;
  save(frame: BootFrame): void;
  /** How often the layout is checked for a change. */
  intervalMs?: number;
}

/**
 * Keeps the stored frame current: shortly after the app is up, whenever the
 * layout settles into something new, and as the page is hidden or closed.
 * Does nothing on a page that drew no frame script, which is how a desktop
 * pop-out window, a test or a share page stays out of it.
 */
export function startBootFrameRecorder({
  doc,
  root,
  save,
  intervalMs = 10_000,
}: BootFrameRecorderOptions): () => void {
  const view = doc.defaultView;
  const build = view ? currentBootFrameBuild(view) : null;
  if (!view || !build) return () => {};
  let lastSignature = "";
  let stopped = false;
  const record = () => {
    if (stopped) return;
    const signature = bootFrameSignature(doc, root);
    if (signature === lastSignature) return;
    const frame = captureBootFrame(doc, root, build);
    if (!frame) return;
    lastSignature = signature;
    save(frame);
  };
  const recordWhenIdle = () => {
    if (doc.visibilityState === "hidden") return;
    const idle = (view as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle.call(view, record, { timeout: 2_000 });
    else record();
  };
  const onHidden = () => {
    if (doc.visibilityState === "hidden") record();
  };
  const first = view.setTimeout(recordWhenIdle, 3_000);
  const interval = view.setInterval(recordWhenIdle, intervalMs);
  doc.addEventListener("visibilitychange", onHidden);
  view.addEventListener("pagehide", record);
  const stop = () => {
    stopped = true;
    runningRecorders.delete(stop);
    view.clearTimeout(first);
    view.clearInterval(interval);
    doc.removeEventListener("visibilitychange", onHidden);
    view.removeEventListener("pagehide", record);
  };
  runningRecorders.add(stop);
  return stop;
}

/**
 * Takes the launch frame down as the app draws its own layout, or a failure
 * screen, in `root`. Until then the frame covers the app, so the user never
 * sees it half built. Mutation observers run before the page paints, so the
 * frame goes in the paint that shows the layout, not a frame after it.
 * Returns a function that takes the frame down now, for a page that gives
 * up on starting.
 */
export function releaseBootFrameWhenDrawn(doc: Document, root: Element): () => void {
  const view = doc.defaultView;
  const frame = doc.getElementById(BOOT_FRAME_ELEMENT_ID);
  if (!view || !frame) return () => {};
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    observer.disconnect();
    frame.remove();
  };
  const drawn = () => root.querySelector(
    '[data-gloom-role="pane-window"], [data-gloom-role="status-bar"], .gloom-fatal',
  ) !== null;
  const observer = new view.MutationObserver(() => {
    if (drawn()) release();
  });
  observer.observe(root, { childList: true, subtree: true });
  if (drawn()) release();
  return release;
}

