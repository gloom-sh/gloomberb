/**
 * What each pane shows on one frame, read the same way from the page (desktop
 * and web) and from the terminal's renderables:
 *
 * - `loading`: the pane's body shows the kit's loading marker (a Spinner or a
 *   loading PaneStatusBody, `data-gloom-status="loading"`) or a line of text
 *   that starts "Loading".
 * - `empty` / `error`: the body shows the kit's empty or failed state.
 * - `content`: anything else drawn in the body.
 * - `blank`: the pane frame is up and its body draws nothing yet.
 *
 * A pane's footer and title bar are not its body: a refresh running there
 * behind content is fine.
 */
export type PaneShownState = "blank" | "loading" | "empty" | "error" | "content";
export interface ProbeEntry { at: number; frame: number; panes: Record<string, PaneShownState> }

/** One pane's state changes over a launch: ms since the launch, and the frame they were seen on. */
export interface PaneTimeline {
  paneId: string;
  states: Array<{ at: number; frame: number; state: PaneShownState }>;
}

const LOADING_TEXT = /^\s*(?:Loading|Fetching)\b/;

/** The page probe reports frame changes out of band from the app's HTTP requests. */
export function domProbeSource(binding: string): string {
  return `(() => {
  if (window.__gloomWarmProbe) return;
  window.__gloomWarmProbe = true;
  const LOADING_TEXT = ${LOADING_TEXT.toString()};
  const last = new Map();
  let frame = 0;
  const shown = (element) => !!element && element.getClientRects().length > 0;
  const stateOf = (pane) => {
    const body = pane.querySelector("[data-gloom-role=pane-body]") || pane;
    const marked = (status) => [...body.querySelectorAll('[data-gloom-status="' + status + '"]')].some(shown);
    if (marked("loading")) return "loading";
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let text = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.nodeValue || "";
      if (!value.trim() || !shown(node.parentElement)) continue;
      if (LOADING_TEXT.test(value)) return "loading";
      text = true;
    }
    if (marked("error")) return "error";
    if (marked("empty") || [...body.querySelectorAll("[data-gloom-role=composite-chart-empty]")].some(shown)) return "empty";
    if (text || [...body.querySelectorAll("canvas,svg,img")].some(shown)) return "content";
    return "blank";
  };
  const tick = () => {
    frame += 1;
    const changed = {};
    let any = false;
    for (const pane of document.querySelectorAll("[data-gloom-role=pane-window][data-gloom-pane-id]")) {
      const id = pane.getAttribute("data-gloom-pane-id");
      const state = stateOf(pane);
      if (last.get(id) !== state) {
        last.set(id, state);
        changed[id] = state;
        any = true;
      }
    }
    if (any) {
      const body = JSON.stringify({ at: performance.timeOrigin + performance.now(), frame, panes: changed });
      window[${JSON.stringify(binding)}](body);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;
}

interface RenderableLike {
  [key: string]: unknown;
  visible?: boolean;
  width?: number;
  height?: number;
  plainText?: string;
  getChildren?: () => RenderableLike[];
}

/** The terminal's panes and what each shows on the frame just drawn, from the renderable tree. */
export function terminalPaneStates(root: RenderableLike): Map<string, PaneShownState> {
  const panes = new Map<string, PaneShownState>();
  type Scope = { marks: Set<string>; text: boolean; loadingText: boolean };
  const visit = (node: RenderableLike, pane: Scope | null, inBody: boolean) => {
    if (node.visible === false || node.width === 0 || node.height === 0) return;
    const id = node["data-gloom-pane-id"];
    if (node["data-gloom-role"] === "pane-window" && typeof id === "string") {
      const scope: Scope = { marks: new Set(), text: false, loadingText: false };
      for (const child of node.getChildren?.() ?? []) visit(child, scope, false);
      panes.set(id, foldState(scope));
      return;
    }
    const body = inBody || (pane !== null && node["data-gloom-role"] === "pane-body");
    if (pane && body) {
      const status = node["data-gloom-role"] === "composite-chart-empty" ? "empty" : node["data-gloom-status"];
      if (typeof status === "string") pane.marks.add(status);
      const text = typeof node.plainText === "string" ? node.plainText : "";
      if (text.trim()) {
        if (LOADING_TEXT.test(text)) pane.loadingText = true;
        else pane.text = true;
      }
    }
    for (const child of node.getChildren?.() ?? []) visit(child, pane, body);
  };
  visit(root, null, false);
  return panes;
}

function foldState(pane: { marks: Set<string>; text: boolean; loadingText: boolean }): PaneShownState {
  if (pane.marks.has("loading") || pane.loadingText) return "loading";
  if (pane.marks.has("error")) return "error";
  if (pane.marks.has("empty")) return "empty";
  return pane.text ? "content" : "blank";
}
