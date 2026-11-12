/** @jsxImportSource react */
import { expect, test } from "bun:test";
import type { Element as DomElement } from "happy-dom";
import { act } from "react";
import { WebDialogHostProvider } from "../../../renderers/dom/dialog-host";
import { createDomUiHost } from "../../../renderers/dom/dom-ui-host";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { UiHostProvider } from "../../../ui";
import { useDialog, type DialogApi } from "../../../ui/dialog";
import { endTrialAfterWarning } from "./trial-cancel";

// The app's own DOM host: the note is a real input that holds the DOM focus.
const { window: testWindow, render } = createDomTestHarness({ withUi: false });

let dialog: DialogApi | null = null;
function Capture() {
  dialog = useDialog();
  return null;
}

// The browser types into whatever input has the focus, so a note the dialog
// has left must let go of it: Enter and `y` are the dialog's again.
test("on the desktop the note lets go of the focus when left, and a clicked reason clears on a second click", async () => {
  await render(
    <UiHostProvider ui={createDomUiHost("darwin")} renderer={noopRendererHost}>
      <WebInputHostProvider><WebDialogHostProvider><Capture /></WebDialogHostProvider></WebInputHostProvider>
    </UiHostProvider>,
  );
  const ended: unknown[] = [];
  let flow: Promise<{ endedNow: boolean } | null> = Promise.resolve(null);
  await act(async () => {
    flow = endTrialAfterWarning(dialog!, { isTrialActive: true, trialEndsAt: null }, async (feedback) => {
      ended.push(feedback);
      return { endedNow: true };
    });
  });
  const document = testWindow.document;
  const surface = document.querySelector(".gloom-dialog")!;
  const note = surface.querySelector('input[aria-label="Anything else? (optional)"]')!;
  const reason = (label: string) => [...surface.querySelectorAll('[role="option"]')].find((row) => row.textContent === label)!;
  const press = (target: DomElement, key: string) => act(async () => {
    target.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  const noteFocused = () => document.activeElement === note;
  const click = (target: DomElement) => act(async () => {
    target.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });

  await click(reason("Too expensive"));
  expect(reason("Too expensive").getAttribute("aria-selected")).toBe("true");
  await click(reason("Too expensive"));
  expect(reason("Too expensive").getAttribute("aria-selected")).toBe("false");

  await press(document.body, "Tab");
  expect(noteFocused()).toBe(true);
  await press(note, "y");
  await press(note, "Tab");
  expect(noteFocused()).toBe(false);
  expect(ended).toEqual([]);

  // Back in the note and out of it with Enter, then Enter again keeps the trial.
  await press(document.body, "Tab");
  expect(noteFocused()).toBe(true);
  await press(note, "Enter");
  expect(noteFocused()).toBe(false);
  expect(document.querySelector(".gloom-dialog")).not.toBeNull();
  await press(document.body, "Enter");
  expect(await flow).toBeNull();
  expect(ended).toEqual([]);
});
