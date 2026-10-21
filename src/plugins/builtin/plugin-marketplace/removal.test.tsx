import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { AppNotificationRequest } from "../../../types/plugin";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { PLUGIN_MARKETPLACE_PANE_ID } from "../../marketplace/ids";
import { setMarketplaceHost, setPluginManager } from "../../marketplace/store";
import { PluginMarketplacePane } from "./pane";

const tui = createOpenTuiTestHarness({ width: 110, height: 24 });

afterEach(() => {
  setMarketplaceHost(null);
  setPluginManager(null);
  setHttpFetchTransport(null);
});

async function mount(failure: "view" | "native" | "remove" | null, native = true) {
  setHttpFetchTransport(async () => Response.json({ version: 1, generatedAt: "", plugins: [] }));
  const id = PLUGIN_MARKETPLACE_PANE_ID;
  const initial = createInitialState(createTestPaneConfig(":memory:", { instanceId: id, paneId: id }));
  const stateRef = { current: initial };
  let updateState = (_state: AppState) => {};
  const calls: string[] = [];
  const notes: AppNotificationRequest[] = [];
  const active = { view: true, native, files: true };
  let reads = 0;
  const dispatch = (action: AppAction) => {
    stateRef.current = appReducer(stateRef.current, action);
    updateState(stateRef.current);
  };
  setMarketplaceHost({
    listInstalled: () => {
      reads++;
      return active.view ? [{ id: "fixture-plugin", name: "Fixture Plugin", version: "1.0.0", toggleable: true,
        enabled: true, source: "external", directory: "fixture-plugin", path: "/fixture/plugins/fixture-plugin" }] : [];
    },
    setPluginEnabled() {}, setPluginsEnabled() {},
    contributions: () => ({ panes: [], templates: [], commands: [], capabilities: 0, broker: false }),
    activate: async () => {},
    deactivate: async () => {
      calls.push("view.stop");
      if (failure === "view") throw new Error("View stop unavailable");
      active.view = false;
    },
    notify() {},
  });
  setPluginManager({
    install: async () => ({ ok: false, error: "Unused" }),
    update: async () => ({ ok: false, error: "Unused" }),
    load: async () => null,
    ...(native ? { deactivate: async () => {
      calls.push("native.stop");
      if (failure === "native") throw new Error("Native stop unavailable");
      active.native = false;
    } } : {}),
    remove: async (directory) => {
      calls.push("files.remove");
      if (failure === "remove") throw new Error("Removal request unavailable");
      active.files = false;
      return { ok: true, directory };
    },
  });
  const runtime = createStatefulTestPluginRuntime({ notify: (note) => { notes.push(note); } });
  function Harness() {
    const [state, update] = useState(initial);
    updateState = update;
    return <TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId="application" runtime={runtime} width={110} height={24}>
      {(body) => <PluginMarketplacePane paneId={id} paneType={id} focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />); });
  await tui.waitForFrameToContain("Fixture Plugin");
  const press = async (name: string, sequence = name) => {
    await tui.emitKeypress({ name, sequence }, { trackPropagation: true });
    await settleFrame(tui.setup(), 3);
  };
  const remove = async () => {
    await press("x");
    await tui.waitForFrameToContain("Remove Fixture Plugin?");
    await press("return", "\r");
  };
  return { active, calls, notes, remove, reads: () => reads, recover: () => { failure = null; } };
}

for (const failure of ["view", "native"] as const) {
  test(`a ${failure} stop rejection retains files, refreshes the row and allows a later successful stop`, async () => {
    const run = await mount(failure);
    const initialReads = run.reads();
    await run.remove();
    const frame = await tui.waitForFrameToContain("Restart Gloomberb");
    expect(frame).toContain("Plugin could not be stopped. Files kept.");
    expect(frame).not.toContain("removing Fixture Plugin");
    expect(frame).toContain("[x] remove");
    expect(run.calls).toEqual(failure === "native" ? ["native.stop"] : ["native.stop", "view.stop"]);
    expect(run.active).toEqual({ view: true, native: failure === "native", files: true });
    expect(run.reads()).toBeGreaterThan(initialReads);
    expect(run.notes.map((note) => note.type)).toEqual(["error"]);

    run.recover();
    await run.remove();
    await tui.waitForFrameToExclude("Fixture Plugin");
    expect(run.calls.slice(-3)).toEqual(["native.stop", "view.stop", "files.remove"]);
    expect(run.active).toEqual({ view: false, native: false, files: false });
    expect(run.notes.at(-1)).toMatchObject({ body: "Removed Fixture Plugin.", type: "success" });
    expect(tui.frame()).not.toContain("Restart Gloomberb");
  });
}

test("a thrown file-removal request clears the busy state and reports failure", async () => {
  const run = await mount("remove");
  await run.remove();
  const frame = await tui.waitForFrameToContain("Removal failed.");
  expect(frame).not.toContain("removing Fixture Plugin");
  expect(frame).not.toContain("Plugin could not be stopped");
  expect(run.active.files).toBe(true);
  expect(run.notes.map((note) => note.type)).toEqual(["error"]);
});

test("terminal removal works without a separate native host", async () => {
  const run = await mount(null, false);
  await run.remove();
  await tui.waitForFrameToExclude("Fixture Plugin");
  expect(run.calls).toEqual(["view.stop", "files.remove"]);
  expect(run.active.files).toBe(false);
  expect(run.notes.at(-1)?.type).toBe("success");
});
