import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { PluginRegistry } from "../../plugins/registry";
import { testRender } from "../../renderers/opentui/test-utils";
import { createRemoteUiRegistry } from "../../remote/semantic-tree";
import type { AppContextStoreValue } from "../../state/app/context";
import { createTestTicker } from "../../test-support/ticker";
import { AmbiguousTickerError } from "../../tickers/search";
import type { CommandDef, PaneTemplateCreateOptions, WizardStep } from "../../types/plugin";
import {
  CommandBarHarness,
  createCommandBarTestControls,
  emitKeypress,
} from "../command-bar/surface/test-harness";
import { openConfirmModal, openFormModal, type ConfirmModalOptions } from "./index";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  testSetup?.renderer.destroy();
  testSetup = undefined;
});

const { waitForFrameToContain } = createCommandBarTestControls(() => testSetup!);

const ENTER = { name: "return", sequence: "\r" };
const ESC = { name: "escape", sequence: "\x1b" };

/**
 * One key at a time, with the propagation the real input host tracks, and a
 * frame after the commit so a row the key added or removed is laid out.
 */
async function press(...keys: Array<{ name: string; sequence?: string; shift?: boolean; ctrl?: boolean }>) {
  for (const key of keys) {
    await emitKeypress(testSetup!, key, { frames: 2, afterCommit: true, trackPropagation: true });
  }
}

async function type(text: string) {
  await act(async () => {
    await testSetup!.mockInput.typeText(text);
    await testSetup!.renderOnce();
  });
}

async function settle() {
  await act(async () => {
    await Bun.sleep(5);
    await testSetup!.renderOnce();
  });
  await testSetup!.renderOnce();
}

/** The first frame with the form can come before its key handler is bound. */
async function waitForForm(text: string): Promise<void> {
  await waitForFrameToContain(text);
  await settle();
}

function frame(): string {
  return testSetup!.captureCharFrame();
}

function registerCommand(registry: PluginRegistry, command: Partial<CommandDef> & { id: string; wizard: WizardStep[] }) {
  (registry.commands as Map<string, CommandDef>).set(command.id, {
    label: "Save Note",
    keywords: ["note"],
    category: "data",
    execute: async () => {},
    ...command,
  } as CommandDef);
}

/** Opens a form with the bar closed, as a pane or a menu does. */
async function renderForm(
  configure: (registry: PluginRegistry) => void,
  request: Parameters<typeof openFormModal>[0],
  options: { notes?: Array<{ body: string; type?: string }>; storeRef?: { current: AppContextStoreValue | null }; remoteRegistry?: ReturnType<typeof createRemoteUiRegistry> } = {},
) {
  testSetup = await testRender(
    <CommandBarHarness
      query=""
      live
      storeRef={options.storeRef}
      remoteRegistry={options.remoteRegistry}
      configureState={(state) => ({ ...state, commandBarOpen: false })}
      configurePluginRegistry={(registry) => {
        registry.notify = (notification) => { options.notes?.push({ body: notification.body ?? "", type: notification.type }); };
        configure(registry);
      }}
    />,
    { width: 90, height: 30 },
  );
  await act(async () => {
    expect(openFormModal(request)).toBe(true);
  });
}

describe("form modal", () => {
  test("a form from the bar closes the bar and takes the keyboard, and Enter on the last field sends it", async () => {
    const submitted: unknown[] = [];
    testSetup = await testRender(
      <CommandBarHarness
        query="note"
        live
        configurePluginRegistry={(registry) => registerCommand(registry, {
          id: "save-note",
          wizard: [
            { key: "title", label: "Title", type: "text" },
            { key: "tag", label: "Tag", type: "text", required: false },
          ],
          execute: async (values) => { submitted.push(values); },
        })}
      />,
      { width: 90, height: 30 },
    );
    await testSetup.renderOnce();
    await press(ENTER);
    await waitForFrameToContain("Title");
    expect(frame()).toContain("bar:closed");

    await type("Q3 review");
    await press(ENTER);
    await type("earnings");
    expect(frame()).toContain("Q3 review");
    await press(ENTER);
    await settle();

    expect(submitted).toEqual([{ title: "Q3 review", tag: "earnings" }]);
    expect(frame()).not.toContain("Title");
  });

  test("a required field stops the submit and says which one", async () => {
    const submitted: unknown[] = [];
    await renderForm((registry) => registerCommand(registry, {
      id: "save-note",
      wizard: [{ key: "title", label: "Title", type: "text" }],
      execute: async (values) => { submitted.push(values); },
    }), { kind: "plugin-command", commandId: "save-note" });
    await waitForForm("Title");

    await press({ name: "s", ctrl: true, sequence: "\x13" });
    await waitForFrameToContain("Title is required.");
    expect(submitted).toEqual([]);

    // Esc closes it from a focused text field too.
    await press(ESC);
    expect(frame()).not.toContain("Title is required.");
  });

  test("while a submit runs the form ignores Enter; a failure stays in the form", async () => {
    let calls = 0;
    let fail: (error: Error) => void = () => {};
    await renderForm((registry) => registerCommand(registry, {
      id: "save-note",
      wizard: [
        { key: "title", label: "Title", type: "text", defaultValue: "Draft" },
        { key: "_validate", label: "Saving", type: "info", body: ["Saving note…"] },
      ],
      execute: () => {
        calls += 1;
        return new Promise<void>((_resolve, reject) => { fail = reject; });
      },
    }), { kind: "plugin-command", commandId: "save-note" });
    await waitForForm("Draft");

    await press(ENTER);
    await waitForFrameToContain("Saving note…");
    await press(ENTER, { name: "s", ctrl: true, sequence: "\x13" });
    expect(calls).toBe(1);

    await act(async () => { fail(new Error("Notes are read-only.")); });
    await waitForFrameToContain("Notes are read-only.");
    expect(frame()).toContain("Draft");
  });

  test("Esc closes the form even while it runs, and a late failure becomes a toast", async () => {
    const notes: Array<{ body: string; type?: string }> = [];
    let fail: (error: Error) => void = () => {};
    await renderForm((registry) => registerCommand(registry, {
      id: "save-note",
      wizard: [{ key: "title", label: "Title", type: "text", defaultValue: "Draft" }],
      execute: () => new Promise<void>((_resolve, reject) => { fail = reject; }),
    }), { kind: "plugin-command", commandId: "save-note" }, { notes });
    await waitForForm("Draft");

    await press(ENTER, ESC);
    expect(frame()).not.toContain("Draft");
    await act(async () => { fail(new Error("Notes are read-only.")); });
    await settle();
    expect(notes).toEqual([{ body: "Notes are read-only.", type: "error" }]);
  });

  test("a select opens a stacked picker; a pick reveals its fields and clears the ones it resets", async () => {
    const submitted: unknown[] = [];
    await renderForm((registry) => registerCommand(registry, {
      id: "connect",
      label: "Connect",
      wizard: [
        {
          key: "mode",
          label: "Mode",
          type: "select",
          clearOnChange: ["account"],
          options: [{ label: "Paper", value: "paper" }, { label: "Live", value: "live" }],
        },
        { key: "account", label: "Account", type: "text", dependsOn: { key: "mode", value: "live" } },
      ],
      execute: async (values) => { submitted.push(values); },
    }), { kind: "plugin-command", commandId: "connect" });
    await waitForForm("Paper");
    expect(frame()).not.toContain("Account");

    // Esc leaves the picker and nothing else.
    await press(ENTER);
    await waitForFrameToContain("▸ Paper");
    await press(ESC);
    expect(frame()).not.toContain("▸ Paper");
    expect(frame()).toContain("Mode");

    await press(ENTER, { name: "down" }, ENTER);
    await waitForFrameToContain("Account");
    // The pick moved on to the field it revealed.
    await type("DU123");
    expect(frame()).toContain("DU123");

    await press({ name: "tab", shift: true }, ENTER, { name: "up" }, ENTER);
    expect(frame()).not.toContain("DU123");
    await press({ name: "tab", shift: true }, ENTER, { name: "down" }, ENTER);
    await waitForFrameToContain("Account");
    expect(frame()).not.toContain("DU123");

    // Tab from the last field reaches the button, where Enter sends.
    await type("DU9");
    await press({ name: "tab" }, ENTER);
    await settle();
    expect(submitted).toEqual([{ mode: "live", account: "DU9" }]);
  });

  test("the button says what the chosen option will do", async () => {
    await renderForm(() => {}, {
      kind: "route",
      route: {
        kind: "workflow",
        workflowId: "plugin-command:connect",
        title: "Add Account",
        fields: [{
          id: "method",
          label: "Method",
          type: "select",
          options: [{ label: "Sign in", value: "signed-in" }, { label: "On this device", value: "device" }],
        }],
        values: { method: "device" },
        activeFieldId: "method",
        submitLabel: "Add Account",
        submitLabels: [{ dependsOn: [{ key: "method", value: "signed-in" }], label: "Connect" }],
        pending: false,
        error: null,
        payload: { kind: "plugin-command", actionId: "connect" },
      },
    });
    await waitForForm("On this device");
    expect(frame()).not.toContain("Connect");
    await press(ENTER, { name: "up" }, ENTER);
    await waitForFrameToContain("Connect");
  });

  test("a textarea keeps Enter for new lines, gives Tab back to the form, and sends on Ctrl+S", async () => {
    const submitted: Array<Record<string, string> | undefined> = [];
    await renderForm((registry) => registerCommand(registry, {
      id: "screen",
      label: "Run Screen",
      wizard: [
        { key: "prompt", label: "Prompt", type: "textarea" },
        { key: "limit", label: "Limit", type: "number", defaultValue: "20" },
      ],
      execute: async (values) => { submitted.push(values); },
    }), { kind: "plugin-command", commandId: "screen" });
    await waitForForm("Prompt");

    await type("cheap");
    await press(ENTER);
    await type("quality");
    await press({ name: "tab" });
    await type("5");
    await press({ name: "s", ctrl: true, sequence: "\x13" });
    await settle();

    expect(submitted).toEqual([{ prompt: "cheap\nquality", limit: "205" }]);
  });

  test("the bar opening over a form closes the form", async () => {
    const storeRef: { current: AppContextStoreValue | null } = { current: null };
    await renderForm((registry) => registerCommand(registry, {
      id: "save-note",
      wizard: [{ key: "title", label: "Title", type: "text" }],
    }), { kind: "plugin-command", commandId: "save-note" }, { storeRef });
    await waitForForm("Title");

    // A second form waits for the first.
    expect(openFormModal({ kind: "builtin", actionId: "new-layout" })).toBe(false);
    await act(async () => {
      storeRef.current!.dispatch({ type: "SET_COMMAND_BAR", open: true, query: "" });
    });
    await waitForFrameToContain("bar:open");
    await settle();
    expect(frame()).not.toContain("Title");
  });

  test("remote control sees each field and sets a select without opening it", async () => {
    const remoteRegistry = createRemoteUiRegistry();
    const submitted: unknown[] = [];
    await renderForm((registry) => registerCommand(registry, {
      id: "connect",
      label: "Connect Account",
      wizard: [
        { key: "mode", label: "Mode", type: "select", options: [{ label: "Paper", value: "paper" }, { label: "Live", value: "live" }] },
        { key: "account", label: "Account", type: "text" },
      ],
      execute: async (values) => { submitted.push(values); },
    }), { kind: "plugin-command", commandId: "connect" }, { remoteRegistry });
    await waitForForm("Account");

    const fieldNode = (fieldId: string) => remoteRegistry.snapshot()
      .find((node) => node.role === "form-field" && node.metadata?.fieldId === fieldId)!;
    expect(fieldNode("mode").metadata).toMatchObject({ scope: "form", value: "paper", fieldType: "select" });
    await expect(remoteRegistry.invoke(fieldNode("mode").id, "setValue", "demo")).rejects.toThrow("not an option");
    await act(async () => {
      await remoteRegistry.invoke(fieldNode("mode").id, "setValue", "live");
      await remoteRegistry.invoke(fieldNode("account").id, "setValue", "DU1");
    });
    await act(async () => {
      await remoteRegistry.invoke(fieldNode("account").id, "submit");
    });
    await settle();
    expect(submitted).toEqual([{ mode: "live", account: "DU1" }]);
  });

  test("an ambiguous ticker asks for the listing over the form, then sends once with the pick", async () => {
    const created: PaneTemplateCreateOptions[] = [];
    await renderForm((registry) => {
      (registry.paneTemplates as Map<string, unknown>).set("compare-pane", {
        id: "compare-pane",
        paneId: "quote-monitor",
        label: "Compare",
        shortcut: { prefix: "CMP", argPlaceholder: "tickers", argKind: "ticker-list" },
      });
      registry.createPaneFromTemplateAsyncFn = async (_templateId, options) => {
        created.push(options ?? {});
        if (created.length === 1) {
          throw new AmbiguousTickerError("COST", ["COST:XNAS", "COST:XLON"], {
            "COST:XNAS": "Costco Wholesale",
            "COST:XLON": "Costain Group",
          });
        }
      };
    }, { kind: "pane-template", templateId: "compare-pane" });
    await waitForForm("Tickers");

    await type("MSFT, COST");
    await press(ENTER);
    await waitForFrameToContain("Choose listing for COST");
    await press({ name: "down" }, ENTER);
    await settle();

    expect(created.map((options) => options.arg)).toEqual(["MSFT, COST", "MSFT, COST:XLON"]);
    expect(frame()).not.toContain("Tickers");
  });
});

describe("confirm modal", () => {
  function confirmRequest(overrides: Partial<ConfirmModalOptions>): Parameters<typeof openFormModal>[0] {
    return {
      kind: "confirm",
      confirm: {
        confirmId: "reset-layout",
        title: "Reset Current Layout",
        body: ["Reset the current layout to the default two-pane arrangement?"],
        confirmLabel: "Reset Layout",
        cancelLabel: "Back",
        onConfirm: () => {},
        ...overrides,
      },
    };
  }

  test("a confirm from a bar picker acts on the config as it is when confirmed", async () => {
    const storeRef: { current: AppContextStoreValue | null } = { current: null };
    testSetup = await testRender(
      <CommandBarHarness
        query="Delete Portfolio"
        live
        storeRef={storeRef}
        configureConfig={(config) => ({ ...config, portfolios: [{ id: "research", name: "Research", currency: "USD" }] })}
        extraTickers={[createTestTicker("NVDA", "NVIDIA Corp.", { portfolios: ["research"] })]}
      />,
      { width: 90, height: 30 },
    );
    await testSetup.renderOnce();
    await press(ENTER, ENTER);
    await waitForForm('Delete "Research"?');
    expect(frame()).toContain("bar:closed");
    expect(frame()).toContain("Cancel");
    expect(frame()).not.toContain("Back");

    // The config moves on while the confirm is open.
    const store = storeRef.current!;
    await act(async () => {
      store.dispatch({ type: "SET_CONFIG", config: { ...store.getState().config, baseCurrency: "EUR" } });
    });
    await press(ENTER);
    await settle();

    expect(store.getState().config.portfolios.map((portfolio) => portfolio.id)).not.toContain("research");
    expect(store.getState().config.baseCurrency).toBe("EUR");
    expect(frame()).not.toContain('Delete "Research"?');
  });

  test("n cancels a confirm from a bar picker and leaves nothing open", async () => {
    testSetup = await testRender(
      <CommandBarHarness
        query="Delete Watchlist"
        live
        configureConfig={(config) => ({ ...config, watchlists: [{ id: "tech", name: "Tech" }] })}
      />,
      { width: 90, height: 30 },
    );
    await testSetup.renderOnce();
    await press(ENTER, ENTER);
    await waitForForm('Delete "Tech"?');
    await press({ name: "n", sequence: "n" });
    await settle();
    expect(frame()).not.toContain('Delete "Tech"?');
    expect(frame()).toContain("bar:closed");
  });

  test("a held Enter runs the action once; a failure stays in the confirm and y tries again", async () => {
    let calls = 0;
    let settleCall: { resolve: () => void; reject: (error: Error) => void } | null = null;
    await renderForm(() => {}, confirmRequest({
      onConfirm: () => {
        calls += 1;
        return new Promise<void>((resolve, reject) => { settleCall = { resolve, reject }; });
      },
    }));
    await waitForForm("Reset Layout");

    await press(ENTER, ENTER, { name: "n", sequence: "n" });
    await waitForFrameToContain("Working…");
    expect(calls).toBe(1);

    await act(async () => { settleCall!.reject(new Error("Layout is locked.")); });
    await waitForFrameToContain("Layout is locked.");

    await press({ name: "y", sequence: "y" });
    expect(calls).toBe(2);
    await act(async () => { settleCall!.resolve(); });
    await settle();
    expect(frame()).not.toContain("Reset Layout");
  });

  test("Esc closes a running confirm, and a late failure becomes a toast", async () => {
    const notes: Array<{ body: string; type?: string }> = [];
    let fail: (error: Error) => void = () => {};
    await renderForm(() => {}, confirmRequest({
      onConfirm: () => new Promise<void>((_resolve, reject) => { fail = reject; }),
    }), { notes });
    await waitForForm("Reset Layout");

    await press(ENTER, ESC);
    expect(frame()).not.toContain("Reset Layout");
    await act(async () => { fail(new Error("Layout is locked.")); });
    await settle();
    expect(notes).toEqual([{ body: "Layout is locked.", type: "error" }]);
    // The confirm is gone, so another can open.
    expect(openConfirmModal(confirmRequest({}).confirm)).toBe(true);
  });
});

