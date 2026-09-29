/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { AppDialogBridge } from "../../app/dialog-bridge";
import type { PluginRegistry } from "../../plugins/registry";
import { WebDialogHostProvider } from "../../renderers/electrobun/view/dialog-host";
import { WebInputHostProvider } from "../../renderers/electrobun/view/input-host";
import { createDomTestHarness } from "../../renderers/electrobun/view/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createDefaultConfig } from "../../types/config";
import type { CommandBarWorkflowRoute } from "../command-bar/workflow/types";
import { FormModalHost } from "./host";
import { openFormModal } from "./request";
import { createDesktopFormControls, createSaveNoteRegistry } from "./test-harness";

const { window: testWindow, render } = createDomTestHarness();
const { press, activeInputValue } = createDesktopFormControls(testWindow);

/** The host as the desktop app mounts it: outside the dialog layer, bridged into it. */
async function renderHost(pluginRegistry: PluginRegistry) {
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

const route: CommandBarWorkflowRoute = {
  kind: "workflow",
  workflowId: "plugin-command:save-note",
  title: "Save Note",
  fields: [
    { id: "title", label: "Title", type: "text", required: true },
    { id: "pinned", label: "Pinned", type: "toggle" },
    { id: "tag", label: "Tag", type: "text" },
  ],
  values: { title: "Draft", pinned: false, tag: "" },
  activeFieldId: "title",
  submitLabel: "Save Note",
  pending: false,
  error: null,
  payload: { kind: "plugin-command", actionId: "save-note" },
};

// On the desktop a focused field takes Enter before the form hears it, and the
// dialog walks its own controls on Tab unless the form keeps the key.
test("on the desktop Enter moves on once, Tab stays in the form, and Esc closes it", async () => {
  const submitted: Array<Record<string, string> | undefined> = [];
  await renderHost(createSaveNoteRegistry((values) => submitted.push(values)));
  await act(async () => {
    expect(openFormModal({ kind: "route", route })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(activeInputValue()).toBe("Draft");

  // Enter lands on the toggle and must not also flip it.
  await press("Enter");
  expect(await press("Tab")).toBe(true);
  expect(activeInputValue()).toBe("");
  await press("s", { ctrlKey: true });
  expect(submitted).toEqual([{ title: "Draft", pinned: "false", tag: "" }]);

  await act(async () => {
    openFormModal({ kind: "route", route });
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(testWindow.document.querySelectorAll(".gloom-dialog")).toHaveLength(1);
  await press("Escape");
  expect(testWindow.document.querySelectorAll(".gloom-dialog")).toHaveLength(0);
});

// A pressed button or label takes the DOM focus without moving the form's, so
// the field has to ask for it back or typing goes nowhere.
test("on the desktop the active field takes the focus back after a click on the button or its label", async () => {
  const submitted: Array<Record<string, string> | undefined> = [];
  await renderHost(createSaveNoteRegistry((values) => submitted.push(values)));
  await act(async () => {
    openFormModal({ kind: "route", route: { ...route, values: { ...route.values, title: "" } } });
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(activeInputValue()).toBe("");

  const button = [...testWindow.document.querySelectorAll("button")]
    .find((element) => element.textContent?.includes("Save Note")) as unknown as HTMLButtonElement;
  await act(async () => {
    button.focus();
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(testWindow.document.body.textContent).toContain("Title is required.");
  expect(activeInputValue()).toBe("");
  expect(submitted).toEqual([]);

  const label = [...testWindow.document.querySelectorAll(".gloom-dialog *")]
    .find((element) => element.children.length === 0 && element.textContent === "Title") as unknown as HTMLElement;
  await act(async () => {
    (testWindow.document.querySelector(".gloom-dialog") as unknown as HTMLElement).focus();
    label.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, cancelable: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(activeInputValue()).toBe("");
});
