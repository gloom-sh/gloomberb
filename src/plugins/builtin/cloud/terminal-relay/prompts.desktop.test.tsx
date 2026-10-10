/** @jsxImportSource react */
import { expect, jest, test } from "bun:test";
import { act } from "react";
import { WebDialogHostProvider } from "../../../../renderers/dom/dialog-host";
import { createDomUiHost } from "../../../../renderers/dom/dom-ui-host";
import { WebInputHostProvider } from "../../../../renderers/dom/input-host";
import { createDomTestHarness } from "../../../../renderers/dom/test-utils";
import { noopRendererHost } from "../../../../test-support/renderer-host";
import { UiHostProvider } from "../../../../ui";
import { useDialog, type DialogApi, type PromptContext } from "../../../../ui/dialog";
import type { ConfirmationAnswer } from "./engine";
import { CallConfirmationDialog } from "./prompts";

// The app's own DOM host, so the dialog frame and its action row are the desktop's.
const { window: testWindow, render } = createDomTestHarness({ withUi: false });
const caller = { id: "key:k1", name: "Desk assistant" };
const summary = { title: "placeOrder with Example Broker", lines: [{ label: "Symbol", value: "NVDA" }] };

let dialog: DialogApi | null = null;
function Capture() {
  dialog = useDialog();
  return null;
}

// The desktop says the keys on the buttons and counts the answer window down
// beside them; the terminal's key line is not drawn there.
test("on the desktop the call confirmation puts y and n on its buttons and counts down its window", async () => {
  let answer: Promise<ConfirmationAnswer | undefined> | null = null;
  const surface = () => testWindow.document.querySelector(".gloom-dialog")!;
  const button = (name: string) => surface().querySelector(`button[aria-label="${name}"]`)!;

  jest.useFakeTimers();
  try {
    await render(
      <UiHostProvider ui={createDomUiHost("darwin")} renderer={noopRendererHost}>
        <WebInputHostProvider><WebDialogHostProvider><Capture /></WebDialogHostProvider></WebInputHostProvider>
      </UiHostProvider>,
    );
    await act(async () => {
      answer = dialog!.prompt<ConfirmationAnswer>({
        content: (context: PromptContext<ConfirmationAnswer>) => (
          <CallConfirmationDialog {...context} caller={caller} summary={summary} signal={new AbortController().signal} keyGraceMs={0} />
        ),
      });
    });

    expect(surface().textContent).not.toContain("Y allow");
    expect(button("Allow").getAttribute("aria-keyshortcuts")).toBe("y");
    expect(button("Deny").getAttribute("aria-keyshortcuts")).toBe("n");
    expect(surface().textContent).toContain("Denied in 60 s");

    await act(async () => { jest.advanceTimersByTime(15_000); });
    expect(surface().textContent).toContain("Denied in 45 s");
  } finally {
    // The DOM harness tears down on real timers.
    jest.useRealTimers();
  }

  await act(async () => {
    testWindow.document.body.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "y", bubbles: true, cancelable: true }));
  });
  expect(await answer!).toBe("allow");
});
