import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { AppContextStoreValue } from "../../state/app/context";
import { createTestTicker } from "../../test-support/ticker";
import { isDialogOpen } from "../../ui/dialog-stack";
import { CommandBarHarness } from "../command-bar/surface/test-harness";
import { openConfirmModal, openFormModal, type ConfirmModalOptions } from "./request";
import { ENTER, ESC, createFormModalTestSession } from "./test-harness";

const session = createFormModalTestSession();
const { frame, press, render, renderForm, settle, waitForForm, waitForFrameToContain } = session;

afterEach(() => session.cleanup());

describe("confirm modal", () => {
  function confirmRequest(overrides: Partial<ConfirmModalOptions>): Extract<Parameters<typeof openFormModal>[0], { kind: "confirm" }> {
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
    await render(
      <CommandBarHarness
        query="Delete Portfolio"
        live
        storeRef={storeRef}
        configureConfig={(config) => ({ ...config, portfolios: [{ id: "research", name: "Research", currency: "USD" }] })}
        extraTickers={[createTestTicker("NVDA", "NVIDIA Corp.", { portfolios: ["research"] })]}
      />,
      { width: 90, height: 30 },
    );
    await session.setup.renderOnce();
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
    await render(
      <CommandBarHarness
        query="Delete Watchlist"
        live
        configureConfig={(config) => ({ ...config, watchlists: [{ id: "tech", name: "Tech" }] })}
      />,
      { width: 90, height: 30 },
    );
    await session.setup.renderOnce();
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

  // The plugin install offer runs the typed code again once the plugin is in,
  // which opens the bar: that has to wait for the confirm to be gone.
  test("onSuccess runs once the confirm has closed, so it can open the bar", async () => {
    const storeRef: { current: AppContextStoreValue | null } = { current: null };
    const dialogOpenOnSuccess: boolean[] = [];
    await renderForm(() => {}, confirmRequest({
      tone: "default",
      onSuccess: () => {
        dialogOpenOnSuccess.push(isDialogOpen());
        storeRef.current!.dispatch({ type: "SET_COMMAND_BAR", open: true, query: "" });
      },
    }), { storeRef });
    await waitForForm("Reset Layout");

    await press({ name: "y", sequence: "y" });
    await waitForFrameToContain("bar:open");
    expect(dialogOpenOnSuccess).toEqual([false]);
    expect(frame()).not.toContain("Reset Current Layout");
  });

  // The install finishing after Esc must not open the bar over what came next:
  // the bar opening closes the form, and what was typed in it is lost.
  test("a confirm closed while it runs does not run onSuccess, so a form opened since stays", async () => {
    const storeRef: { current: AppContextStoreValue | null } = { current: null };
    let finish: () => void = () => {};
    await renderForm(() => {}, confirmRequest({
      tone: "default",
      onConfirm: () => new Promise<void>((resolve) => { finish = resolve; }),
      onSuccess: () => storeRef.current!.dispatch({ type: "SET_COMMAND_BAR", open: true, query: "" }),
    }), { storeRef });
    await waitForForm("Reset Layout");

    await press(ENTER);
    await waitForFrameToContain("Working…");
    await press(ESC);
    await act(async () => {
      expect(openFormModal({ kind: "builtin", actionId: "new-layout" })).toBe(true);
    });
    await waitForForm("Layout Name");
    await act(async () => { finish(); });
    await settle();

    expect(frame()).toContain("Layout Name");
    expect(frame()).toContain("bar:closed");
  });
});
