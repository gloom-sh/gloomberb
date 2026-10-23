import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { bootFrameSignature, captureBootFrame, releaseBootFrameWhenDrawn, startBootFrameRecorder } from "./boot-frame";
import { BOOT_FRAME_BUILD_GLOBAL, BOOT_FRAME_ELEMENT_ID, bootFrameScript, type BootFrame } from "./boot-frame-page";

const windows: Window[] = [];
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

function page(width = 1200, height = 800) {
  const window = new Window({ width, height });
  windows.push(window);
  window.document.body.innerHTML = '<div id="root"></div>';
  return { window, document: window.document as unknown as Document, root: window.document.getElementById("root") as unknown as HTMLElement };
}

/** Runs the inline frame script the way the page does, before the app's script. */
function runFrameScript(window: Window, script: string, globals: Record<string, unknown> = {}) {
  Object.assign(window, globals);
  new Function("window", "document", "localStorage", script)(window, window.document, window.localStorage);
}

const APP_LAYOUT = `
  <div style="display: flex">
    <div data-gloom-role="app-header" onclick="steal()"><span>Search or run a command</span><div data-gloom-role="header-update-status">Restart to update</div></div>
    <div data-gloom-role="pane-window" data-gloom-pane-id="portfolio:main" id="pane-1" tabindex="0">
      <div data-gloom-role="pane-header"><span data-gloom-role="pane-title">Main Portfolio</span></div>
      <div data-gloom-role="pane-body"><table><tr><td>AAPL</td><td>187.30</td></tr></table><canvas></canvas></div>
      <div data-gloom-role="pane-footer">as of 16:00</div>
    </div>
    <div data-gloom-role="dock-divider" data-axis="horizontal"></div>
    <div class="gloom-popover">An open menu</div>
    <div data-gloom-role="status-bar"><span>Home</span></div>
  </div>`;

test("a launch frame keeps the layout's chrome and none of its data", () => {
  const { document, root } = page();
  root.innerHTML = APP_LAYOUT;
  document.documentElement.setAttribute("style", "--gloom-bg: #000;");

  const frame = captureBootFrame(document, root, "build-1")!;

  expect(frame).toMatchObject({ build: "build-1", width: 1200, height: 800, rootStyle: "--gloom-bg: #000;" });
  const copy = document.createElement("div");
  copy.innerHTML = frame.html;
  expect(copy.querySelector('[data-gloom-role="pane-title"]')?.textContent).toBe("Main Portfolio");
  expect(copy.querySelector('[data-gloom-role="status-bar"]')?.textContent).toBe("Home");
  expect(copy.querySelector('[data-gloom-role="dock-divider"]')).not.toBeNull();
  // Pane data and a stale update notice are left out; so is anything that is not layout chrome.
  expect(copy.querySelector('[data-gloom-role="pane-body"]')?.childNodes.length).toBe(0);
  expect(copy.querySelector('[data-gloom-role="pane-footer"]')?.textContent).toBe("");
  expect(copy.querySelector('[data-gloom-role="header-update-status"]')?.textContent).toBe("");
  expect(frame.html).not.toContain("187.30");
  expect(frame.html).not.toContain("gloom-popover");
  // Nothing in it can run, take focus or be found as the app's own pane.
  expect(frame.html).not.toContain("onclick");
  expect(frame.html).not.toContain("tabindex");
  expect(frame.html).not.toContain("data-gloom-pane-id");
  expect(frame.html).not.toContain('id="pane-1"');
});

test("there is no frame to keep before a pane is drawn", () => {
  const { document, root } = page();
  root.innerHTML = '<div data-gloom-role="status-bar">Home</div>';
  expect(captureBootFrame(document, root, "build-1")).toBeNull();
});

test("the page redraws a frame only from its own build, in a window of the same size", () => {
  const { document, root } = page();
  root.innerHTML = APP_LAYOUT;
  const frame = captureBootFrame(document, root, "build-1")!;
  const script = bootFrameScript({ build: "build-1", source: "window.storedFrame", shellStyle: "--gloom-bg: #111;" });
  const drawn = (stored: BootFrame | null, size?: [number, number]) => {
    const next = page(...(size ?? [1200, 800]));
    runFrameScript(next.window, script, { storedFrame: stored });
    const overlay = next.document.getElementById(BOOT_FRAME_ELEMENT_ID);
    return {
      kind: overlay?.getAttribute("data-gloom-boot-frame"),
      html: overlay?.innerHTML,
      rootStyle: next.document.documentElement.getAttribute("style"),
      build: (next.window as unknown as Record<string, unknown>)[BOOT_FRAME_BUILD_GLOBAL],
    };
  };

  expect(drawn(frame)).toEqual({ kind: "layout", html: frame.html, rootStyle: frame.rootStyle || null, build: "build-1" });
  // Another build's markup may not fit this stylesheet, and another size puts panes elsewhere.
  expect(drawn({ ...frame, build: "build-0" }).kind).toBe("shell");
  expect(drawn(frame, [1000, 800]).kind).toBe("shell");
  expect(drawn(null)).toMatchObject({ kind: "shell", rootStyle: "--gloom-bg: #111;" });
});

test("a window that draws no frame, and a broken stored frame, leave the page as it was", () => {
  const skipped = page();
  runFrameScript(skipped.window, bootFrameScript({ build: "b", source: "window.storedFrame", skip: "window.storedFrame === undefined" }));
  expect(skipped.document.getElementById(BOOT_FRAME_ELEMENT_ID)).toBeNull();
  // The recorder still learns the build, so a later frame is stamped with it.
  expect((skipped.window as unknown as Record<string, unknown>)[BOOT_FRAME_BUILD_GLOBAL]).toBe("b");

  const broken = page();
  broken.window.localStorage.setItem("frame", "{not json");
  runFrameScript(broken.window, bootFrameScript({ build: "b", source: 'JSON.parse(localStorage.getItem("frame"))' }));
  expect(broken.document.getElementById(BOOT_FRAME_ELEMENT_ID)?.getAttribute("data-gloom-boot-frame")).toBe("shell");
});

test("the frame stays over the app until the app has drawn its layout", async () => {
  const { window, document, root } = page();
  runFrameScript(window, bootFrameScript({ build: "b", source: "null" }));
  releaseBootFrameWhenDrawn(document, root);
  const frameShown = () => document.getElementById(BOOT_FRAME_ELEMENT_ID) !== null;

  root.innerHTML = "<div>mounting</div>";
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  expect(frameShown()).toBe(true);

  root.innerHTML = APP_LAYOUT;
  for (let frames = 0; frames < 5 && frameShown(); frames += 1) {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  }
  expect(frameShown()).toBe(false);
});

test("the recorder saves a new frame only when the layout changed", async () => {
  const { window, document, root } = page();
  (window as unknown as Record<string, unknown>)[BOOT_FRAME_BUILD_GLOBAL] = "b";
  root.innerHTML = APP_LAYOUT;
  const saved: BootFrame[] = [];
  const stop = startBootFrameRecorder({ doc: document, root, save: (frame) => saved.push(frame) });
  const hide = () => window.dispatchEvent(new window.Event("pagehide"));

  hide();
  hide();
  expect(saved).toHaveLength(1);
  const before = bootFrameSignature(document, root);
  root.querySelector('[data-gloom-role="pane-title"]')!.textContent = "Watchlist";
  expect(bootFrameSignature(document, root)).not.toBe(before);
  hide();
  expect(saved).toHaveLength(2);
  expect(saved[1]!.html).toContain("Watchlist");
  stop();
  hide();
  expect(saved).toHaveLength(2);
});

test("a page with no frame script records nothing", () => {
  const { window, document, root } = page();
  root.innerHTML = APP_LAYOUT;
  const saved: BootFrame[] = [];
  startBootFrameRecorder({ doc: document, root, save: (frame) => saved.push(frame) });
  window.dispatchEvent(new window.Event("pagehide"));
  expect(saved).toHaveLength(0);
});
