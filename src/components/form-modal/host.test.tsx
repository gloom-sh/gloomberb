import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { PluginRegistry } from "../../plugins/registry";
import type { AppContextStoreValue } from "../../state/app/context";
import type { BrokerAdapter } from "../../types/broker";
import { CommandBarHarness } from "../command-bar/surface/test-harness";
import { openFormModal } from "./request";
import { ENTER, createFormModalTestSession, registerCommand } from "./test-harness";

const session = createFormModalTestSession();
const { frame, press, render, renderForm, settle, type, waitForForm, waitForFrameToContain } = session;

afterEach(() => session.cleanup());

describe("form modal host", () => {
  test("a form from the bar closes the bar and takes the keyboard, and Enter on the last field sends it", async () => {
    const submitted: unknown[] = [];
    await render(
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
    await session.setup.renderOnce();
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
    const queued: boolean[] = [];
    await renderForm((registry) => registerCommand(registry, {
      id: "save-note",
      wizard: [{ key: "title", label: "Title", type: "text", defaultValue: "Draft" }],
      execute: async () => { queued.push(openFormModal({ kind: "builtin", actionId: "new-layout" })); },
    }), { kind: "plugin-command", commandId: "save-note" });
    await waitForForm("Draft");

    await press(ENTER);
    await waitForForm("Layout Name");
    expect(queued).toEqual([true]);
    expect(frame()).not.toContain("Draft");
  });

  // The host mounts once, and the marketplace installs brokers into the map it read.
  test("New Portfolio lists a broker installed after the app started", async () => {
    let registry: PluginRegistry | null = null;
    await render(
      <CommandBarHarness
        query=""
        live
        configureState={(state) => ({ ...state, commandBarOpen: false })}
        configurePluginRegistry={(value) => { registry = value; }}
      />,
      { width: 90, height: 30 },
    );
    await session.setup.renderOnce();
    (registry!.brokers as Map<string, BrokerAdapter>).set("demo", {
      id: "demo",
      name: "Demo Broker",
      configSchema: [{ key: "token", label: "Token", type: "text" }],
    } as unknown as BrokerAdapter);

    await act(async () => {
      expect(openFormModal({ kind: "builtin", actionId: "new-portfolio" })).toBe(true);
    });
    await waitForForm("Portfolio Source");
    await press(ENTER);
    await waitForFrameToContain("Demo Broker");
  });
});
