/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { WebDialogHostProvider } from "../renderers/dom/dialog-host";
import { WebInputHostProvider } from "../renderers/dom/input-host";
import { createDomTestHarness } from "../renderers/dom/test-utils";
import { useDialog, type DialogApi } from "../ui/dialog";
import { sharePaneLink } from "./flow";
import { restoreShareApiAfterEach, SHARE_LINK, shareFlowFixture } from "./test-harness";

restoreShareApiAfterEach();
const { window: testWindow, render } = createDomTestHarness();

let dialog: DialogApi | null = null;
function DialogCapture() {
  dialog = useDialog();
  return null;
}

const question = () => testWindow.document.querySelector(".gloom-dialog")?.textContent ?? null;

async function press(key: string, repeat = false) {
  await act(async () => {
    const target = testWindow.document.activeElement ?? testWindow.document.body;
    target.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key, repeat, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("a pane of the person's own data asks once on the desktop: Enter, Esc and a held Enter make no link, y copies it", async () => {
  await render(<WebInputHostProvider><WebDialogHostProvider><DialogCapture /></WebDialogHostProvider></WebInputHostProvider>);
  const f = shareFlowFixture({ personalData: "holdings" });
  f.host.promptDialog = (prompt) => dialog!.prompt(prompt);
  const answer = async (keys: Array<[key: string, repeat?: boolean]>) => {
    let share: Promise<void> = Promise.resolve();
    await act(async () => {
      share = sharePaneLink(f.host, "test:1");
      // The dialog takes the focus a frame after it opens.
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(question()).toContain("Copy a public link?");
    expect(question()).toContain("This shows your holdings.");
    for (const [key, repeat] of keys) await press(key, repeat);
    await act(() => share);
    expect(question()).toBeNull();
  };

  await answer([["Enter"]]);
  await answer([["Escape"]]);
  // The Enter that chose Share in a menu, still held as the question opens.
  await answer([["Enter", true], ["Enter", true]]);
  expect(f.created).toEqual([]);
  expect(f.copied).toEqual([]);

  await answer([["y"]]);
  expect(f.copied).toEqual([SHARE_LINK]);
  expect(f.toasts).toEqual([{ body: "Link copied", type: "success" }]);
});
