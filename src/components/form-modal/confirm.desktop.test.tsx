/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { AppDialogBridge } from "../../app/dialog-bridge";
import { WebDialogHostProvider } from "../../renderers/electrobun/view/dialog-host";
import { WebInputHostProvider } from "../../renderers/electrobun/view/input-host";
import { createDomTestHarness } from "../../renderers/electrobun/view/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createDefaultConfig } from "../../types/config";
import { FormModalHost } from "./host";
import { openConfirmModal } from "./request";
import { createDesktopFormControls, createSaveNoteRegistry } from "./test-harness";

const { window: testWindow, render } = createDomTestHarness();
const { press } = createDesktopFormControls(testWindow);

// The dialog itself holds the focus, so the confirm hears Enter and y itself;
// no button is focused to take Enter a second time.
test("on the desktop a confirm runs once on Enter and cancels on n", async () => {
  let calls = 0;
  const store = createStaticAppStore(createInitialState(createDefaultConfig("/tmp/gloomberb-confirm-desktop")));
  await render(
    <WebInputHostProvider>
      <WebDialogHostProvider>
        <AppContext value={store}>
          <AppDialogBridge />
          <FormModalHost
            dataProvider={createTestDataProvider({ id: "test" })}
            pluginRegistry={createSaveNoteRegistry(() => {})}
            tickerRepository={{} as never}
          />
        </AppContext>
      </WebDialogHostProvider>
    </WebInputHostProvider>,
  );
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

