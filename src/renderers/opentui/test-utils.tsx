import { createTestRenderer } from "@opentui/core/testing";
import { createRoot as openTuiCreateRoot, useRenderer } from "@opentui/react";
import { testRender as openTuiTestRender } from "@opentui/react/test-utils";
import { afterEach } from "bun:test";
import { act, useMemo, type ReactNode } from "react";
import { UiHostProvider, type NativeRendererHost, type RendererHost } from "../../ui";
import { ToastHostProvider } from "../../ui/toast";
import { OpenTuiDialogHostProvider } from "./dialog-host";
import { OpenTuiInputHostProvider } from "./input-host";
import { provideKittyServices } from "./kitty-services";
import { openTuiToastHost } from "./toast-host";
import { openTuiUiHost } from "./ui-host";

export interface TestKeyEvent {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  super?: boolean;
  shift?: boolean;
  alt?: boolean;
  option?: boolean;
  defaultPrevented?: boolean;
  propagationStopped?: boolean;
  repeated?: boolean;
}

/** Batch keys in one React update; keep each suite's frame and propagation semantics. */
export async function emitKeypress(
  setup: Awaited<ReturnType<typeof testRender>>,
  events: TestKeyEvent | TestKeyEvent[],
  { frames = 1, afterCommit = false, trackPropagation = false } = {},
) {
  let lastEvent;
  await act(async () => {
    for (const event of Array.isArray(events) ? events : [events]) {
      let defaultPrevented = event.defaultPrevented === true;
      let propagationStopped = event.propagationStopped === true;
      lastEvent = {
        ctrl: false, alt: false, meta: false, option: false, shift: false,
        eventType: "press", repeated: false,
        ...event,
        get defaultPrevented() { return defaultPrevented; },
        get propagationStopped() { return propagationStopped; },
        preventDefault() { if (trackPropagation) defaultPrevented = true; },
        stopPropagation() { if (trackPropagation) propagationStopped = true; },
      };
      setup.renderer.keyInput.emit("keypress", lastEvent as any);
    }
    for (let index = 0; index < frames; index++) await setup.renderOnce();
  });
  if (afterCommit) await setup.renderOnce();
  return lastEvent!;
}

let lastSavedTextFile: { name: string; text: string } | null = null;

/** Returns the most recent file written through the test renderer's `saveTextFile`. */
export function takeSavedTextFile(): { name: string; text: string } | null {
  const saved = lastSavedTextFile;
  lastSavedTextFile = null;
  return saved;
}

export function TestDialogProvider({ children }: { children: ReactNode }) {
  return (
    <OpenTuiDialogHostProvider>
      {children}
    </OpenTuiDialogHostProvider>
  );
}

function createTestNativeRendererHost(renderer: any): NativeRendererHost {
  if (typeof renderer.write !== "function") {
    renderer.write = (data: string | Uint8Array) => {
      if (renderer.isDestroyed) return false;
      const writer = renderer.writeOut;
      if (typeof writer !== "function") return false;
      writer.call(renderer, data);
      return true;
    };
  }
  return provideKittyServices(renderer as NativeRendererHost);
}

function OpenTuiTestProviders({ children }: { children: ReactNode }) {
  const renderer = useRenderer();
  const rendererHost = useMemo<RendererHost>(() => ({
    requestExit: () => renderer.destroy?.(),
    openExternal: async () => {},
    copyText: async () => {},
    readText: async () => "",
    notify: () => {},
    saveTextFile: async ({ name, text }) => {
      lastSavedTextFile = { name, text };
      return `~/Downloads/${name}`;
    },
  }), [renderer]);
  const nativeRenderer = useMemo(() => createTestNativeRendererHost(renderer), [renderer]);

  return (
    <UiHostProvider ui={openTuiUiHost} renderer={rendererHost} nativeRenderer={nativeRenderer}>
      <OpenTuiInputHostProvider>
        <ToastHostProvider host={openTuiToastHost}>
          <OpenTuiDialogHostProvider>
            {children}
          </OpenTuiDialogHostProvider>
        </ToastHostProvider>
      </OpenTuiInputHostProvider>
    </UiHostProvider>
  );
}

function withOpenTuiTestProviders(node: ReactNode): ReactNode {
  return <OpenTuiTestProviders>{node}</OpenTuiTestProviders>;
}

export function testRender(
  node: ReactNode,
  options?: Parameters<typeof openTuiTestRender>[1],
): ReturnType<typeof openTuiTestRender> {
  return openTuiTestRender(withOpenTuiTestProviders(node), options ?? {});
}

export function createOpenTuiTestRoot(
  renderer: Parameters<typeof openTuiCreateRoot>[0],
): ReturnType<typeof openTuiCreateRoot> {
  const root = openTuiCreateRoot(renderer);
  return new Proxy(root, {
    get(target, property, receiver) {
      if (property === "render") {
        return (node: ReactNode) => target.render(withOpenTuiTestProviders(node));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Advances one polling step: sleeps, then renders. Both happen inside `act` so
 * that anything a resolving promise queued during the sleep is flushed before
 * the next frame is captured. Polling outside `act` leaves the update to
 * React's scheduler, which is why a loaded CI box could time out waiting for a
 * frame the app had already produced.
 */
export async function settleFrame(
  renderer: Awaited<ReturnType<typeof testRender>>,
  delayMs = 50,
): Promise<void> {
  await act(async () => {
    await Bun.sleep(delayMs);
  });
  // Paint after React has committed the updates collected by act.
  await renderer.renderOnce();
}

export function createTestControls(
  getRenderer: () => Awaited<ReturnType<typeof testRender>>,
) {
  const waitForFrame = async (
    matches: (frame: string) => boolean,
    description: string,
    attempts: number,
    delayMs: number,
  ): Promise<string> => {
    const renderer = getRenderer();
    for (let attempt = 0; attempt < attempts; attempt++) {
      const frame = renderer.captureCharFrame();
      if (matches(frame)) {
        return frame;
      }
      await settleFrame(renderer, delayMs);
    }
    throw new Error(`Timed out waiting for frame to ${description}.\n${renderer.captureCharFrame()}`);
  };

  const waitForFrameToContain = (text: string, attempts = 12, delayMs = 50): Promise<string> => (
    waitForFrame((frame) => frame.includes(text), `contain "${text}"`, attempts, delayMs)
  );

  const waitForFrameToExclude = (text: string, attempts = 12, delayMs = 50): Promise<string> => (
    waitForFrame((frame) => !frame.includes(text), `drop "${text}"`, attempts, delayMs)
  );

  const clickFrameText = async (text: string): Promise<void> => {
    const renderer = getRenderer();
    const frame = renderer.captureCharFrame();
    const rows = frame.split("\n");
    const row = rows.findIndex((line) => line.includes(text));
    const col = row >= 0 ? rows[row]!.indexOf(text) : -1;

    if (row < 0 || col < 0) throw new Error(`No frame text "${text}".\n${frame}`);

    await act(async () => {
      await renderer.mockMouse.click(col + 1, row);
      await renderer.renderOnce();
    });
  };

  const renderFrames = async (count = 2): Promise<void> => {
    const renderer = getRenderer();
    for (let index = 0; index < count; index += 1) {
      await act(async () => {
        await renderer.renderOnce();
      });
    }
  };

  return {
    waitForFrameToContain,
    waitForFrameToExclude,
    clickFrameText,
    renderFrames,
  };
}

export type OpenTuiTestSetup = Awaited<ReturnType<typeof testRender>>;
export type OpenTuiTestRoot = ReturnType<typeof createOpenTuiTestRoot>;
export type OpenTuiTestRenderOptions = NonNullable<Parameters<typeof openTuiTestRender>[1]>;

/**
 * One OpenTUI renderer per test, torn down after every test even when an
 * assertion fails. Call it once per suite (at module level, or inside the
 * `describe` whose own `afterEach` resets have to run after the renderer is
 * gone), then `render` in each test. The teardown is registered here, so it
 * runs before any `afterEach` the suite registers after this call.
 */
export function createOpenTuiTestHarness(defaults: OpenTuiTestRenderOptions = {}) {
  let current: OpenTuiTestSetup | undefined;
  let currentRoot: OpenTuiTestRoot | undefined;

  const setup = (): OpenTuiTestSetup => {
    if (!current) throw new Error("No OpenTUI test renderer is mounted. Call render() first.");
    return current;
  };

  /** Unmounts and destroys the current renderer. Safe to call when nothing is mounted. */
  const destroy = async (): Promise<void> => {
    const mounted = current;
    const root = currentRoot;
    current = undefined;
    currentRoot = undefined;
    if (!mounted) return;
    if (root) {
      await act(async () => {
        root.unmount();
      });
      mounted.renderer.destroy();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
      return;
    }
    await act(async () => {
      mounted.renderer.destroy();
    });
  };

  afterEach(destroy);

  /**
   * `testRender`, replacing any renderer this test already mounted. The first
   * commit happens inside `act`; updates that effects schedule after it land on
   * later frames. Wrap the call in `act` to flush them before it returns.
   */
  const render = async (node: ReactNode, options?: OpenTuiTestRenderOptions): Promise<OpenTuiTestSetup> => {
    await destroy();
    current = await testRender(node, { ...defaults, ...options });
    return current;
  };

  /**
   * For a suite that has to configure the renderer (terminal capabilities,
   * pixel resolution) before anything mounts: creates the renderer and an empty
   * root, and leaves rendering into it to the test.
   */
  const createRoot = async (
    options?: OpenTuiTestRenderOptions,
  ): Promise<{ setup: OpenTuiTestSetup; root: OpenTuiTestRoot }> => {
    await destroy();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    current = await createTestRenderer({ ...defaults, ...options });
    currentRoot = createOpenTuiTestRoot(current.renderer);
    return { setup: current, root: currentRoot };
  };

  return {
    render,
    createRoot,
    destroy,
    setup,
    isMounted: (): boolean => current !== undefined,
    frame: (): string => setup().captureCharFrame(),
    emitKeypress: (events: TestKeyEvent | TestKeyEvent[], options?: Parameters<typeof emitKeypress>[2]) => (
      emitKeypress(setup(), events, options)
    ),
    ...createTestControls(setup),
  };
}

export type OpenTuiTestHarness = ReturnType<typeof createOpenTuiTestHarness>;
