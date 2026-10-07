import { afterEach, expect } from "bun:test";
import type { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { AppDialogBridge } from "../../app/dialog-bridge";
import type { PluginRegistry } from "../../plugins/registry";
import type { createRemoteUiRegistry } from "../../remote/semantic-tree";
import { WebDialogHostProvider } from "../../renderers/dom/dialog-host";
import { WebInputHostProvider } from "../../renderers/dom/input-host";
import { createOpenTuiTestHarness, type OpenTuiTestSetup } from "../../renderers/opentui/test-utils";
import { AppContext, createInitialState, type AppContextStoreValue } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createDefaultConfig } from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type { CommandDef, WizardStep } from "../../types/plugin";
import type { TickerRecord } from "../../types/ticker";
import { CommandBarHarness } from "../command-bar/surface/test-harness";
import { FormModalHost } from "./host";
import { openFormModal } from "./request";

export const ENTER = { name: "return", sequence: "\r" };
export const ESC = { name: "escape", sequence: "\x1b" };
export const CTRL_S = { name: "s", ctrl: true, sequence: "\x13" };

type TestKey = { name: string; sequence?: string; shift?: boolean; ctrl?: boolean };

export function registerCommand(registry: PluginRegistry, command: Partial<CommandDef> & { id: string; wizard: WizardStep[] }) {
  (registry.commands as Map<string, CommandDef>).set(command.id, {
    label: "Save Note",
    keywords: ["note"],
    category: "data",
    execute: async () => {},
    ...command,
  } as CommandDef);
}

/**
 * A registry with one plugin command, Save Note, for a form host rendered on
 * its own rather than in the command bar harness.
 */
export function createSaveNoteRegistry(execute: (values?: Record<string, string>) => void): PluginRegistry {
  return {
    brokers: new Map(),
    commands: new Map([["save-note", { id: "save-note", label: "Save Note", execute: async (values?: Record<string, string>) => execute(values) }]]),
    getCommandPluginId: () => undefined,
    allPlugins: new Map(),
    notify: () => {},
  } as unknown as PluginRegistry;
}

/**
 * The host as the desktop app mounts it: outside the dialog layer, bridged
 * into it. `render` is the suite's `createDomTestHarness` render.
 */
export async function renderDesktopFormHost(
  render: (node: ReactNode) => Promise<unknown>,
  pluginRegistry: PluginRegistry,
): Promise<void> {
  const store = createStaticAppStore(createInitialState(createDefaultConfig("/tmp/gloomberb-form-desktop")));
  await render(
    <WebInputHostProvider>
      <WebDialogHostProvider>
        <AppContext value={store}>
          <AppDialogBridge />
          <FormModalHost
            dataProvider={createTestDataProvider({ id: "test" })}
            pluginRegistry={pluginRegistry}
            tickerRepository={{} as never}
          />
        </AppContext>
      </WebDialogHostProvider>
    </WebInputHostProvider>,
  );
}

/**
 * Keys as the desktop view receives them, for a suite rendered with
 * `createDomTestHarness`: sent to the focused element, and whether the form
 * kept the key.
 */
export function createDesktopFormControls(testWindow: Window) {
  async function press(key: string, options: { ctrlKey?: boolean } = {}): Promise<boolean> {
    const event = new testWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
    const target = (testWindow.document.activeElement ?? testWindow.document.body) as unknown as EventTarget;
    await act(async () => {
      target.dispatchEvent(event as unknown as Event);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    return event.defaultPrevented;
  }

  /** The focused text input's value, or null when no input has the focus. */
  function activeInputValue(): string | null {
    const active = testWindow.document.activeElement as unknown as { tagName?: string; value?: string } | null;
    return active?.tagName === "INPUT" ? active.value ?? "" : null;
  }

  return { press, activeInputValue };
}

/**
 * One terminal render per test, in the command bar harness: the app's form
 * modal host is mounted there, and the dialog layer sits outside the app tree
 * as it does in production. The renderer goes after every test, then the
 * test's spies, so call it once per suite.
 */
export function createFormModalTestSession() {
  const tui = createOpenTuiTestHarness();
  let spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies = [];
  });
  const { waitForFrameToContain } = tui;

  /**
   * One key at a time, with the propagation the real input host tracks, and a
   * frame after the commit so a row the key added or removed is laid out.
   */
  async function press(...keys: TestKey[]) {
    for (const key of keys) {
      await tui.emitKeypress(key, { frames: 2, afterCommit: true, trackPropagation: true });
    }
  }

  async function type(text: string) {
    await act(async () => {
      await tui.setup().mockInput.typeText(text);
      await tui.setup().renderOnce();
    });
  }

  async function settle() {
    await act(async () => {
      await Bun.sleep(5);
      await tui.setup().renderOnce();
    });
    await tui.setup().renderOnce();
  }

  /** The first frame with the form can come before its key handler is bound. */
  async function waitForForm(text: string): Promise<void> {
    await waitForFrameToContain(text);
    await settle();
  }

  async function render(element: ReactNode, size: { width: number; height: number } = { width: 90, height: 30 }) {
    return tui.render(element, size);
  }

  /** Opens a form with the bar closed, as a pane or a menu does. */
  async function renderForm(
    configure: (registry: PluginRegistry) => void,
    request: Parameters<typeof openFormModal>[0],
    options: {
      notes?: Array<{ body: string; type?: string }>;
      storeRef?: { current: AppContextStoreValue | null };
      remoteRegistry?: ReturnType<typeof createRemoteUiRegistry>;
      dataProvider?: DataProvider;
      size?: { width: number; height: number };
      /** The focused pane's ticker, which a form can start from. */
      selectedTicker?: string;
      extraTickers?: TickerRecord[];
    } = {},
  ) {
    await render(
      <CommandBarHarness
        query=""
        live
        dataProvider={options.dataProvider}
        selectedTicker={options.selectedTicker}
        extraTickers={options.extraTickers}
        storeRef={options.storeRef}
        remoteRegistry={options.remoteRegistry}
        configureState={(state) => ({ ...state, commandBarOpen: false })}
        configurePluginRegistry={(registry) => {
          registry.notify = (notification) => { options.notes?.push({ body: notification.body ?? "", type: notification.type }); };
          configure(registry);
        }}
      />,
      options.size,
    );
    await act(async () => {
      expect(openFormModal(request)).toBe(true);
    });
  }

  return {
    get setup(): OpenTuiTestSetup {
      return tui.setup();
    },
    /** Restores the spy once the test ends. */
    spy(spy: { mockRestore(): void }) {
      spies.push(spy);
    },
    frame: tui.frame,
    press,
    render,
    renderForm,
    settle,
    type,
    waitForForm,
    waitForFrameToContain,
  };
}
