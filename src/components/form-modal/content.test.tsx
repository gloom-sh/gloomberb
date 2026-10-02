import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { PluginRegistry } from "../../plugins/registry";
import { formSnapshot } from "../../remote/form";
import { createRemoteUiRegistry } from "../../remote/semantic-tree";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { AmbiguousTickerError } from "../../tickers/search";
import type { PaneTemplateCreateOptions } from "../../types/plugin";
import { dismissTopmostDialog, isDialogOpen } from "../../ui/dialog-stack";
import { CTRL_S, ENTER, ESC, createFormModalTestSession, registerCommand } from "./test-harness";

const session = createFormModalTestSession();
const { frame, press, renderForm, settle, type, waitForForm, waitForFrameToContain } = session;

describe("form modal", () => {
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
        await session.setup.mockMouse.click(lines[row]!.indexOf(text) + 1, row);
        await session.setup.renderOnce();
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

  test("Tab shows a field exactly as tall as the body", async () => {
    // At 17 rows the body is 7 rows, as tall as a textarea with its label.
    const fields = Array.from({ length: 3 }, (_, index) => ({
      id: `f${index + 1}`,
      label: `Field ${index + 1}`,
      type: "textarea" as const,
    }));
    await renderForm(() => {}, {
      kind: "route",
      route: {
        kind: "workflow",
        workflowId: "plugin-command:notes",
        title: "Notes",
        fields,
        values: Object.fromEntries(fields.map((field) => [field.id, ""])),
        activeFieldId: "f1",
        submitLabel: "Save",
        pending: false,
        error: null,
        payload: { kind: "plugin-command", actionId: "notes" },
      },
    }, { size: { width: 90, height: 17 } });
    await waitForForm("Field 1");

    await press({ name: "tab" });
    await settle();
    await type("LAST");
    await settle();
    expect(frame()).toContain("Field 2");
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
    const form = formSnapshot(remoteRegistry.snapshot(), isDialogOpen());
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
    expect(formSnapshot(remoteRegistry.snapshot(), isDialogOpen())).toEqual({ open: false });
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
      registry.createPaneFromTemplateAsync = async (_templateId, options) => {
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
      registry.createPaneFromTemplateAsync = async (_templateId, options) => {
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

  test("remote control sees the listing picker over the form and closes it before the form", async () => {
    const remoteRegistry = createRemoteUiRegistry();
    await renderForm((registry) => {
      registerCompareTemplate(registry);
      registry.createPaneFromTemplateAsync = async () => { throw COST; };
    }, { kind: "pane-template", templateId: "compare-pane" }, { remoteRegistry });
    await waitForForm("Tickers");

    await type("COST");
    await press(CTRL_S);
    await waitForFrameToContain("Choose listing for COST");
    expect(formSnapshot(remoteRegistry.snapshot(), isDialogOpen())).toMatchObject({ open: true, covered: true });

    await act(async () => { expect(dismissTopmostDialog()).toBe(true); });
    await settle();
    expect(frame()).not.toContain("Choose listing for COST");
    const form = formSnapshot(remoteRegistry.snapshot(), isDialogOpen());
    expect(form).toMatchObject({ open: true, title: "Compare" });
    expect(form).not.toHaveProperty("covered");

    await act(async () => { expect(dismissTopmostDialog()).toBe(true); });
    await settle();
    expect(formSnapshot(remoteRegistry.snapshot(), isDialogOpen())).toEqual({ open: false });
    expect(dismissTopmostDialog()).toBe(false);
  });

  test("a pane template form keeps the options its caller passed, as createPaneFromTemplate does", async () => {
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];
    await renderForm((registry) => {
      registerCompareTemplate(registry);
      registry.createPaneFromTemplateAsync = async (templateId, options) => {
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
