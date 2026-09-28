import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient, type AuthUser } from "../../api-client";
import { ApiRequestError } from "../../api-client/errors";
import type { SignedInBroker } from "../../brokers/signed-in/client";
import { SIGNED_IN_BROKER_TYPE } from "../../brokers/signed-in/profile";
import { chatController } from "../../plugins/builtin/chat/controller";
import type { PluginRegistry } from "../../plugins/registry";
import { testRender } from "../../renderers/opentui/test-utils";
import { formSnapshot } from "../../remote/form";
import { createRemoteUiRegistry } from "../../remote/semantic-tree";
import type { AppContextStoreValue } from "../../state/app/context";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { createTestTicker } from "../../test-support/ticker";
import { AmbiguousTickerError } from "../../tickers/search";
import type { BrokerAdapter } from "../../types/broker";
import type { BrokerInstanceConfig } from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type { CommandDef, PaneTemplateCreateOptions, WizardStep } from "../../types/plugin";
import { buildBrokerWorkflowRoute } from "../command-bar/workflow/broker";
import {
  CommandBarHarness,
  createCommandBarTestControls,
  emitKeypress,
} from "../command-bar/surface/test-harness";
import { openConfirmModal, openFormModal, type ConfirmModalOptions } from "./index";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  testSetup?.renderer.destroy();
  testSetup = undefined;
  for (const spy of spies) spy.mockRestore();
  spies = [];
});

const { waitForFrameToContain } = createCommandBarTestControls(() => testSetup!);

const ENTER = { name: "return", sequence: "\r" };
const ESC = { name: "escape", sequence: "\x1b" };
const CTRL_S = { name: "s", ctrl: true, sequence: "\x13" };

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
  options: {
    notes?: Array<{ body: string; type?: string }>;
    storeRef?: { current: AppContextStoreValue | null };
    remoteRegistry?: ReturnType<typeof createRemoteUiRegistry>;
    dataProvider?: DataProvider;
  } = {},
) {
  testSetup = await testRender(
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

  test("Ctrl+N and Ctrl+P move between fields, as they move through the bar's lists", async () => {
    const submitted: unknown[] = [];
    await renderForm((registry) => registerCommand(registry, {
      id: "save-note",
      wizard: [
        { key: "title", label: "Title", type: "text" },
        { key: "tag", label: "Tag", type: "text", required: false },
      ],
      execute: async (values) => { submitted.push(values); },
    }), { kind: "plugin-command", commandId: "save-note" });
    await waitForForm("Title");

    await type("Q3");
    await press({ name: "n", ctrl: true, sequence: "\x0e" });
    await type("earnings");
    await press({ name: "p", ctrl: true, sequence: "\x10" });
    await type(" review");
    await press(CTRL_S);
    await settle();

    expect(submitted).toEqual([{ title: "Q3 review", tag: "earnings" }]);
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

  test("a click on a field's label or description leaves the keyboard in its input", async () => {
    const submitted: unknown[] = [];
    await renderForm((registry) => registerCommand(registry, {
      id: "save-note",
      wizard: [{ key: "title", label: "Title", type: "text" }],
      execute: async (values) => { submitted.push(values); },
    }), {
      kind: "route",
      route: {
        kind: "workflow",
        workflowId: "plugin-command:save-note",
        title: "Save Note",
        fields: [{ id: "title", label: "Title", type: "text", description: "Shown in the notes list." }],
        values: { title: "" },
        activeFieldId: "title",
        submitLabel: "Save Note",
        pending: false,
        error: null,
        payload: { kind: "plugin-command", actionId: "save-note" },
      },
    });
    await waitForForm("Shown in the notes list.");

    await type("Dr");
    for (const text of ["Shown in the notes list.", "Title"]) {
      const lines = frame().split("\n");
      const row = lines.findIndex((line) => line.includes(text) && !line.includes("Save Note"));
      await act(async () => {
        await testSetup!.mockMouse.click(lines[row]!.indexOf(text) + 1, row);
        await testSetup!.renderOnce();
      });
      await settle();
    }
    await type("aft");
    await press(ENTER);
    await settle();
    expect(submitted).toEqual([{ title: "Draft" }]);
  });

  // Each description fills the body's width, so once the scrollbar takes a
  // column it wraps to one more line than the text alone would say.
  test("Tab keeps the active field in view in a form that scrolls", async () => {
    const description = "word ".repeat(13).slice(0, 62);
    const fields = Array.from({ length: 8 }, (_, index) => ({
      id: `f${index + 1}`,
      label: `Field ${index + 1}`,
      type: "text" as const,
      ...(index < 7 ? { description } : {}),
    }));
    await renderForm(() => {}, {
      kind: "route",
      route: {
        kind: "workflow",
        workflowId: "plugin-command:long",
        title: "Long Form",
        fields,
        values: Object.fromEntries(fields.map((field) => [field.id, ""])),
        activeFieldId: "f1",
        submitLabel: "Save",
        pending: false,
        error: null,
        payload: { kind: "plugin-command", actionId: "long" },
      },
    });
    await waitForForm("Field 1");

    for (let index = 0; index < 7; index += 1) await press({ name: "tab" });
    await settle();
    await type("LAST");
    await settle();
    expect(frame()).toContain("Field 8");
    expect(frame()).toContain("LAST");
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

  test("Add Alert checks its symbol in the form, and a new symbol keeps the target the user typed", async () => {
    const quotes: Record<string, { price: number; name: string }> = {
      AMD: { price: 201.5, name: "Advanced Micro Devices" },
      NVDA: { price: 120.25, name: "NVIDIA Corp." },
    };
    const dataProvider = createTestDataProvider({
      getQuote: async (symbol) => {
        const quote = quotes[symbol];
        if (!quote) throw new Error(`No quote for ${symbol}.`);
        return createTestQuote({ symbol, ...quote });
      },
    });
    await renderForm((registry) => registerCommand(registry, {
      id: "set-alert",
      label: "Add Alert",
      wizard: [
        { key: "symbol", label: "Symbol", type: "text" },
        { key: "condition", label: "Condition", type: "select", options: [{ label: "Above", value: "above" }] },
        { key: "price", label: "Target Price", type: "number" },
      ],
    }), { kind: "plugin-command", commandId: "set-alert", values: { symbol: "AMD" } }, { dataProvider });
    await waitForFrameToContain("Advanced Micro Devices");
    await waitForForm("Current price 201.5; edit to set the target.");

    // A target of the user's own, then another symbol.
    await press({ name: "tab" }, { name: "tab" });
    for (let index = 0; index < "201.5".length; index++) await press({ name: "backspace" });
    await type("180");
    await press({ name: "tab", shift: true }, { name: "tab", shift: true });
    for (let index = 0; index < "AMD".length; index++) await press({ name: "backspace" });
    await type("NVDA");

    await waitForFrameToContain("NVIDIA Corp.");
    await waitForFrameToContain("Current price 120.25; edit to set the target.");
    expect(frame().split("\n").some((line) => /^\W*180\W*$/.test(line))).toBe(true);
  });

  test("the bar opening over a form closes the form", async () => {
    const storeRef: { current: AppContextStoreValue | null } = { current: null };
    await renderForm((registry) => registerCommand(registry, {
      id: "save-note",
      wizard: [{ key: "title", label: "Title", type: "text" }],
    }), { kind: "plugin-command", commandId: "save-note" }, { storeRef });
    await waitForForm("Title");

    // A second form waits for the first, and gives way to the bar with it.
    expect(openFormModal({ kind: "builtin", actionId: "new-layout" })).toBe(true);
    await act(async () => {
      storeRef.current!.dispatch({ type: "SET_COMMAND_BAR", open: true, query: "" });
    });
    await waitForFrameToContain("bar:open");
    await settle();
    expect(frame()).not.toContain("Title");
    expect(frame()).not.toContain("Layout Name");
  });

  // A command's execute can create a pane from a template with settings to ask.
  test("a form asked for while one submits opens once that one closes", async () => {
    let queued: boolean | null = null;
    await renderForm((registry) => registerCommand(registry, {
      id: "save-note",
      wizard: [{ key: "title", label: "Title", type: "text", defaultValue: "Draft" }],
      execute: async () => { queued = openFormModal({ kind: "builtin", actionId: "new-layout" }); },
    }), { kind: "plugin-command", commandId: "save-note" });
    await waitForForm("Draft");

    await press(ENTER);
    await waitForForm("Layout Name");
    expect(queued).toBe(true);
    expect(frame()).not.toContain("Draft");
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

    // The form as a whole, and its buttons, are marked as the form's.
    const form = formSnapshot(remoteRegistry.snapshot());
    expect(form).toMatchObject({
      open: true,
      kind: "form",
      title: "Connect Account",
      fields: [
        { id: "mode", type: "select", value: "live", visible: true, options: [{ value: "paper", label: "Paper" }, { value: "live", label: "Live" }] },
        { id: "account", type: "text", value: "DU1", visible: true },
      ],
      error: null,
      pending: false,
    });
    expect(remoteRegistry.snapshot().find((node) => node.role === "button" && node.label === "Cancel")?.metadata?.scope).toBe("form");
    await act(async () => {
      await remoteRegistry.invoke((form as { nodeId: string }).nodeId, "submit");
    });
    await settle();
    expect(submitted).toEqual([{ mode: "live", account: "DU1" }]);
    expect(formSnapshot(remoteRegistry.snapshot())).toEqual({ open: false });
  });

  function registerCompareTemplate(registry: PluginRegistry) {
    (registry.paneTemplates as Map<string, unknown>).set("compare-pane", {
      id: "compare-pane",
      paneId: "quote-monitor",
      label: "Compare",
      shortcut: { prefix: "CMP", argPlaceholder: "tickers", argKind: "ticker-list" },
      wizard: [
        { key: "tickers", label: "Tickers", type: "text" },
        { key: "range", label: "Range", type: "text", defaultValue: "1Y" },
      ],
    });
  }

  const COST = new AmbiguousTickerError("COST", ["COST:XNAS", "COST:XLON"], {
    "COST:XNAS": "Costco Wholesale",
    "COST:XLON": "Costain Group",
  });
  const BP = new AmbiguousTickerError("BP", ["BP:XNYS", "BP:XLON"], {
    "BP:XNYS": "BP ADR",
    "BP:XLON": "BP plc",
  });

  // The terminal textarea keeps its own buffer, which a value set from outside
  // has to replace, so the field's node is the only way in.
  test("remote control sets a textarea through its field, and typing goes on from that text", async () => {
    const remoteRegistry = createRemoteUiRegistry();
    const submitted: unknown[] = [];
    await renderForm((registry) => registerCommand(registry, {
      id: "screen",
      label: "Run Screen",
      wizard: [{ key: "prompt", label: "Prompt", type: "textarea" }],
      execute: async (values) => { submitted.push(values); },
    }), { kind: "plugin-command", commandId: "screen" }, { remoteRegistry });
    await waitForForm("Prompt");

    expect(remoteRegistry.snapshot().some((node) => node.role === "textarea")).toBe(false);
    const field = remoteRegistry.snapshot().find((node) => node.role === "form-field")!;
    await act(async () => {
      await remoteRegistry.invoke(field.id, "setValue", "cheap");
    });
    await settle();
    expect(frame()).toContain("cheap");
    await press({ name: "end" });
    await type(" stocks");
    await press(CTRL_S);
    await settle();
    expect(submitted).toEqual([{ prompt: "cheap stocks" }]);
  });

  test("ambiguous tickers ask for their listings one at a time over the form, sending again after each pick", async () => {
    const created: PaneTemplateCreateOptions[] = [];
    await renderForm((registry) => {
      registerCompareTemplate(registry);
      registry.createPaneFromTemplateAsyncFn = async (_templateId, options) => {
        created.push(options ?? {});
        if (!options?.arg?.includes("COST:")) throw COST;
        if (!options.arg.includes("BP:")) throw BP;
      };
    }, { kind: "pane-template", templateId: "compare-pane" });
    await waitForForm("Tickers");

    await type("MSFT, COST, BP");
    await press(ENTER);
    // Enter on the last field sends the form.
    await press(ENTER);
    await waitForFrameToContain("Choose listing for COST");
    await press({ name: "down" }, ENTER);
    await waitForFrameToContain("Choose listing for BP");
    expect(frame()).not.toContain("Choose listing for COST");
    await press(ENTER);
    await settle();

    expect(created.map((options) => options.arg)).toEqual([
      "MSFT, COST, BP",
      "MSFT, COST:XLON, BP",
      "MSFT, COST:XLON, BP:XNYS",
    ]);
    expect(frame()).not.toContain("Tickers");
  });

  test("Esc in the listing picker keeps the form as it was, and typing reaches its field again", async () => {
    const created: PaneTemplateCreateOptions[] = [];
    await renderForm((registry) => {
      registerCompareTemplate(registry);
      registry.createPaneFromTemplateAsyncFn = async (_templateId, options) => {
        created.push(options ?? {});
        throw COST;
      };
    }, { kind: "pane-template", templateId: "compare-pane" });
    await waitForForm("Tickers");

    await type("COST");
    await press({ name: "s", ctrl: true, sequence: "\x13" });
    await waitForFrameToContain("Choose listing for COST");
    await press(ESC);
    await settle();
    expect(frame()).not.toContain("Choose listing for COST");
    expect(created).toHaveLength(1);

    await type(", MSFT");
    expect(frame()).toContain("COST, MSFT");
  });

  test("a pane template form keeps the options its caller passed, as createPaneFromTemplate does", async () => {
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];
    await renderForm((registry) => {
      registerCompareTemplate(registry);
      registry.createPaneFromTemplateAsyncFn = async (templateId, options) => {
        created.push({ templateId, options });
      };
    }, { kind: "pane-template", templateId: "compare-pane", options: { symbol: "AAPL", symbols: ["AAPL"] } });
    await waitForForm("Tickers");

    await type("AAPL, MSFT");
    await press({ name: "s", ctrl: true, sequence: "\x13" });
    await settle();

    expect(created).toEqual([{
      templateId: "compare-pane",
      options: {
        symbol: "AAPL",
        symbols: ["AAPL"],
        arg: "AAPL, MSFT",
        values: { tickers: "AAPL, MSFT", range: "1Y" },
      },
    }]);
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

  // The host mounts once, and the marketplace installs brokers into the map it read.
  test("Add Broker lists a broker installed after the app started", async () => {
    let registry: PluginRegistry | null = null;
    testSetup = await testRender(
      <CommandBarHarness
        query=""
        live
        configureState={(state) => ({ ...state, commandBarOpen: false })}
        configurePluginRegistry={(value) => { registry = value; }}
      />,
      { width: 90, height: 30 },
    );
    await testSetup.renderOnce();
    (registry!.brokers as Map<string, BrokerAdapter>).set("demo", {
      id: "demo",
      name: "Demo Broker",
      configSchema: [{ key: "token", label: "Token", type: "text" }],
    } as unknown as BrokerAdapter);

    await act(async () => {
      expect(openFormModal({ kind: "builtin", actionId: "add-broker-account" })).toBe(true);
    });
    await waitForForm("Add Broker Account");
    expect(frame()).toContain("Demo Broker");
  });
});


describe("broker connect step", () => {
  const ROBINHOOD: SignedInBroker = {
    id: "robinhood",
    name: "Robinhood",
    capabilities: { history: true, executions: true, orders: false, singleConnection: true },
  };
  const DIRECTORY = [{ key: "robinhood", name: "Robinhood", methods: [{ kind: "signed-in" as const, broker: ROBINHOOD }] }];
  const PROFILE: BrokerInstanceConfig = {
    id: "rh-1",
    brokerType: SIGNED_IN_BROKER_TYPE,
    label: "Robinhood",
    connectionMode: "robinhood",
    config: { broker: "robinhood" },
  };

  function brokerRoute(kind: "add-broker" | "new-portfolio") {
    return kind === "add-broker"
      ? buildBrokerWorkflowRoute({
        directory: DIRECTORY,
        includeManualOption: false,
        selectorKey: "brokerType",
        submitLabel: "Connect Broker",
        subtitle: undefined,
        title: "Add Broker Account",
      })!
      : buildBrokerWorkflowRoute({
        directory: DIRECTORY,
        includeManualOption: true,
        selectorKey: "source",
        submitLabel: "Create Portfolio",
        subtitle: undefined,
        title: "New Portfolio",
      })!;
  }

  /**
   * Gloom Cloud for the connect: `connect` answers each code request, and the
   * connection reads connected from the first poll, two seconds in.
   */
  function fakeCloud({ signedIn, connect }: { signedIn: () => boolean; connect: () => unknown }) {
    spies.push(spyOn(apiClient, "isSignedIn").mockImplementation(signedIn));
    spies.push(spyOn(apiClient, "brokerRequest").mockImplementation((async (_broker: string, path: string) => (
      path === "/connect" ? connect() : { status: "connected" }
    )) as typeof apiClient.brokerRequest));
  }

  function codeFor(code: string) {
    return { connectUrl: `https://gloom.sh/connect/${code}`, code, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }

  /** Records the profile work, and gives the config the broker's tab once the profile exists. */
  function brokerRegistry(
    storeRef: { current: AppContextStoreValue | null },
    record: { created: string[]; synced: string[] },
    sync: () => Promise<void> = async () => {},
  ) {
    return (registry: PluginRegistry) => {
      registry.createBrokerInstanceFn = async (brokerType) => {
        record.created.push(brokerType);
        return PROFILE;
      };
      registry.syncBrokerInstanceFn = async (instanceId) => {
        record.synced.push(instanceId);
        await sync();
      };
      registry.getConfigFn = () => {
        const config = storeRef.current!.getState().config;
        return record.created.length === 0 ? config : {
          ...config,
          brokerInstances: [PROFILE],
          portfolios: [...config.portfolios, { id: "broker:rh-1", name: "Robinhood", currency: "USD", brokerInstanceId: "rh-1" }],
        };
      };
    };
  }

  test("connects in the form, signing in to Gloom over it and trying a fresh code when Gloom refused the session", async () => {
    const notes: Array<{ body: string; type?: string }> = [];
    const storeRef: { current: AppContextStoreValue | null } = { current: null };
    const record = { created: [] as string[], synced: [] as string[] };
    let codeRequests = 0;
    fakeCloud({
      signedIn: () => true,
      connect: () => {
        codeRequests += 1;
        if (codeRequests === 1) throw new ApiRequestError("Session expired.", 401);
        return codeFor("K7QM");
      },
    });
    const user = { id: "u1", name: "Vince", email: "vince@example.com", username: null, emailVerified: true, image: null } satisfies AuthUser;
    spies.push(spyOn(apiClient, "startDeviceSignIn").mockResolvedValue({
      deviceCode: "device-1",
      userCode: "GLM1-ABCD",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      verificationUri: "https://gloom.sh/link/GLM1-ABCD",
      pollIntervalMs: 1_000,
    }));
    spies.push(spyOn(apiClient, "pollDeviceSignIn").mockResolvedValue({ status: "approved", sessionToken: "session-2", user }));
    spies.push(spyOn(chatController, "adoptSession").mockImplementation(() => {}));
    spies.push(spyOn(chatController, "refreshSession").mockResolvedValue());

    await renderForm(brokerRegistry(storeRef, record), { kind: "route", route: brokerRoute("add-broker") }, { notes, storeRef });
    await waitForForm("Robinhood");
    await press(CTRL_S);

    // The first code request found the session gone: Gloom's sign-in opens over the form.
    await waitForFrameToContain("Approved as vince@example.com", 60);
    await press(ENTER);

    // A fresh attempt, with a controller of its own, asks for a new code.
    await waitForFrameToContain("K7QM");
    expect(frame()).toContain("Connect Robinhood");
    expect(frame()).toContain("Other AI apps linked to Robinhood get disconnected.");
    await waitForFrameToContain("Connected", 80);
    await press(ENTER);
    await settle();

    expect(codeRequests).toBe(2);
    expect(record).toEqual({ created: [SIGNED_IN_BROKER_TYPE], synced: ["rh-1"] });
    expect(notes).toEqual([{ body: "Connected! Positions will sync automatically.", type: "success" }]);
    expect(storeRef.current!.getState().paneState["portfolio-list:main"]?.collectionId).toBe("broker:rh-1");
    expect(frame()).not.toContain("Connect Robinhood");
  }, 15_000);

  test("backing out of Gloom's sign-in keeps the form; closing the connect step adds nothing", async () => {
    const notes: Array<{ body: string; type?: string }> = [];
    const storeRef: { current: AppContextStoreValue | null } = { current: null };
    const record = { created: [] as string[], synced: [] as string[] };
    let signedIn = false;
    fakeCloud({ signedIn: () => signedIn, connect: () => codeFor("K7QM") });
    spies.push(spyOn(apiClient, "startDeviceSignIn").mockImplementation(() => new Promise(() => {})));

    await renderForm(brokerRegistry(storeRef, record), { kind: "route", route: brokerRoute("new-portfolio") }, { notes, storeRef });
    await waitForForm("Portfolio Source");
    await press(ENTER);
    await waitForFrameToContain("▸ Manual");
    await press({ name: "down" }, ENTER);
    await waitForFrameToContain("Connect");
    // The pick moved on to the button, where Enter sends.
    await press(ENTER);
    await waitForFrameToContain("Sign in through your browser or scan the code");
    await press(ESC);
    await settle();
    expect(frame()).toContain("Portfolio Source");
    expect(frame()).toContain("Robinhood");
    expect(frame()).not.toContain("Connecting broker…");

    signedIn = true;
    await press(ENTER);
    await waitForFrameToContain("K7QM");
    await press(ESC);
    await settle();

    expect(frame()).not.toContain("K7QM");
    expect(frame()).not.toContain("Portfolio Source");
    expect(record.created).toEqual([]);
    expect(notes).toEqual([]);
    // The form is gone, so another can open.
    expect(openFormModal({ kind: "builtin", actionId: "new-layout" })).toBe(true);
  });

  test("a sync that fails once the broker connected stays in the form", async () => {
    const storeRef: { current: AppContextStoreValue | null } = { current: null };
    const record = { created: [] as string[], synced: [] as string[] };
    fakeCloud({ signedIn: () => true, connect: () => codeFor("K7QM") });

    await renderForm(brokerRegistry(storeRef, record, async () => {
      throw new Error("Robinhood did not answer.");
    }), { kind: "route", route: brokerRoute("add-broker") }, { storeRef });
    await waitForForm("Robinhood");
    await press(CTRL_S);
    await waitForFrameToContain("Connected", 80);
    await press(ENTER);

    await waitForFrameToContain("Robinhood did not answer.");
    expect(frame()).toContain("Add Broker Account");
    expect(record.synced).toEqual(["rh-1"]);
  }, 10_000);
});
