import { expect } from "bun:test";
import type { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { PluginRegistry } from "../../plugins/registry";
import type { createRemoteUiRegistry } from "../../remote/semantic-tree";
import { testRender } from "../../renderers/opentui/test-utils";
import type { AppContextStoreValue } from "../../state/app/context";
import type { DataProvider } from "../../types/data-provider";
import type { CommandDef, WizardStep } from "../../types/plugin";
import {
  CommandBarHarness,
  createCommandBarTestControls,
  emitKeypress,
} from "../command-bar/surface/test-harness";
import { openFormModal } from "./request";

type TestSetup = Awaited<ReturnType<typeof testRender>>;

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
 * as it does in production. `cleanup` goes in the suite's `afterEach`.
 */
export function createFormModalTestSession() {
  let setup: TestSetup | undefined;
  let spies: Array<{ mockRestore(): void }> = [];
  const current = () => setup!;
  const { waitForFrameToContain } = createCommandBarTestControls(current);

  /**
   * One key at a time, with the propagation the real input host tracks, and a
   * frame after the commit so a row the key added or removed is laid out.
   */
  async function press(...keys: TestKey[]) {
    for (const key of keys) {
      await emitKeypress(current(), key, { frames: 2, afterCommit: true, trackPropagation: true });
    }
  }

  async function type(text: string) {
    await act(async () => {
      await current().mockInput.typeText(text);
      await current().renderOnce();
    });
  }

  async function settle() {
    await act(async () => {
      await Bun.sleep(5);
      await current().renderOnce();
    });
    await current().renderOnce();
  }

  /** The first frame with the form can come before its key handler is bound. */
  async function waitForForm(text: string): Promise<void> {
    await waitForFrameToContain(text);
    await settle();
  }

  function frame(): string {
    return current().captureCharFrame();
  }

  async function render(element: ReactNode, size: { width: number; height: number } = { width: 90, height: 30 }) {
    setup = await testRender(element, size);
    return setup;
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
    } = {},
  ) {
    await render(
      <CommandBarHarness
        query=""
        live
        dataProvider={options.dataProvider}
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
    get setup(): TestSetup {
      return current();
    },
    /** Restores the spy once the test ends. */
    spy(spy: { mockRestore(): void }) {
      spies.push(spy);
    },
    cleanup() {
      setup?.renderer.destroy();
      setup = undefined;
      for (const spy of spies) spy.mockRestore();
      spies = [];
    },
    frame,
    press,
    render,
    renderForm,
    settle,
    type,
    waitForForm,
    waitForFrameToContain,
  };
}
