/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { createDomTestHarness } from "../../renderers/dom/test-utils";
import { openConfirmModal } from "./request";
import { createDesktopFormControls, createSaveNoteRegistry, renderDesktopFormHost } from "./test-harness";

const { window: testWindow, render } = createDomTestHarness();
const { press } = createDesktopFormControls(testWindow);

// The dialog itself holds the focus, so the confirm hears Enter and y itself;
// no button is focused to take Enter a second time.
test("on the desktop a confirm runs once on Enter and cancels on n", async () => {
  let calls = 0;
  await renderDesktopFormHost(render, createSaveNoteRegistry(() => {}));
  const confirm = {
    confirmId: "delete-note",
    title: "Delete Note",
    body: ["Delete this note?"],
    confirmLabel: "Delete",
    onConfirm: () => { calls += 1; },
  };
  await act(async () => {
    expect(openConfirmModal(confirm)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  await press("Enter");
  await press("Enter");
  expect(calls).toBe(1);
  expect(testWindow.document.querySelectorAll(".gloom-dialog")).toHaveLength(0);

  await act(async () => {
    openConfirmModal(confirm);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  await press("n");
  expect(testWindow.document.querySelectorAll(".gloom-dialog")).toHaveLength(0);
  expect(calls).toBe(1);
});

