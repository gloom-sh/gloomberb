/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { useDialog, type AlertContext, type DialogApi } from "../../../ui/dialog";
import { WebDialogHostProvider } from "./dialog-host";
import { moveDialogFocus } from "./key-event";
import { createDomTestHarness } from "./test-utils";

const { window, render } = createDomTestHarness({ withUi: false });

let dialog: DialogApi | null = null;
function Capture() {
  dialog = useDialog();
  return null;
}

function Buttons({ names }: { names: string[] }) {
  return <div>{names.map((name) => <button key={name} type="button">{name}</button>)}</div>;
}

function tab(shiftKey = false) {
  return moveDialogFocus({ key: "Tab", shiftKey, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false });
}

function focusedText() {
  return window.document.activeElement?.textContent ?? null;
}

test("a dialog opened from a dialog stacks, and closing it returns to the first", async () => {
  await render(<WebDialogHostProvider><Capture /></WebDialogHostProvider>);
  let dismissInner: (() => void) | null = null;
  await act(async () => {
    void dialog!.alert({ content: <Buttons names={["Outer"]} /> });
  });
  await act(async () => {
    void dialog!.alert({
      content: (ctx: AlertContext) => {
        dismissInner = ctx.dismiss;
        return <Buttons names={["Inner"]} />;
      },
    });
  });
  const texts = () => [...window.document.querySelectorAll(".gloom-dialog")].map((node) => node.textContent);
  expect(texts()).toEqual(["Outer", "Inner"]);

  await act(async () => { dismissInner!(); });
  expect(texts()).toEqual(["Outer"]);
});

test("Tab walks the topmost dialog's controls and wraps", async () => {
  await render(<WebDialogHostProvider><Capture /></WebDialogHostProvider>);
  await act(async () => {
    void dialog!.alert({ content: <Buttons names={["Save", "Cancel"]} /> });
  });

  expect(tab()).toBe(true);
  expect(focusedText()).toBe("Save");
  tab();
  expect(focusedText()).toBe("Cancel");
  tab();
  expect(focusedText()).toBe("Save");
  tab(true);
  expect(focusedText()).toBe("Cancel");
});

test("Tab is left alone when no dialog is open or a handler already took it", async () => {
  await render(<WebDialogHostProvider><Capture /></WebDialogHostProvider>);
  expect(tab()).toBe(false);
  await act(async () => {
    void dialog!.alert({ content: <Buttons names={["Only"]} /> });
  });
  expect(moveDialogFocus({ key: "Tab", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: true })).toBe(false);
});
