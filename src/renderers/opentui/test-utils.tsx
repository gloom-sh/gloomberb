import { createRoot as openTuiCreateRoot, useRenderer } from "@opentui/react";
import { testRender as openTuiTestRender } from "@opentui/react/test-utils";
import { act, useMemo, type ReactNode } from "react";
import { colors } from "../../theme/colors";
import { UiHostProvider, type NativeRendererHost, type RendererHost } from "../../ui";
import { ToastHostProvider } from "../../ui/toast";
import { OpenTuiDialogHostProvider } from "./dialog-host";
import { OpenTuiInputHostProvider } from "./input-host";
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
    <OpenTuiDialogHostProvider
      dialogOptions={{
        style: {
          backgroundColor: colors.bg,
          borderColor: colors.borderFocused,
          borderStyle: "single",
        },
      }}
    >
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
  return renderer as NativeRendererHost;
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
          <OpenTuiDialogHostProvider
            dialogOptions={{
              style: {
                backgroundColor: colors.bg,
                borderColor: colors.borderFocused,
                borderStyle: "single",
              },
            }}
          >
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
  return openTuiTestRender(withOpenTuiTestProviders(node), options);
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
  const waitForFrameToContain = async (text: string, attempts = 12, delayMs = 50): Promise<string> => {
    const renderer = getRenderer();
    for (let attempt = 0; attempt < attempts; attempt++) {
      const frame = renderer.captureCharFrame();
      if (frame.includes(text)) {
        return frame;
      }
      await settleFrame(renderer, delayMs);
    }
    throw new Error(`Timed out waiting for frame to contain "${text}".\n${renderer.captureCharFrame()}`);
  };

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
    clickFrameText,
    renderFrames,
  };
}
