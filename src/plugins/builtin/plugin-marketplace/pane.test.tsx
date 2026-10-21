import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { getCurrentPluginTarget, setCurrentPluginTarget } from "../../current-target";
import type { InstalledPlugin } from "../../marketplace/model";
import type { AppNotificationRequest } from "../../../types/plugin";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { applyPluginToggles } from "../../ownership";
import { PLUGIN_MARKETPLACE_PANE_ID } from "../../marketplace/ids";
import { PluginMarketplacePane } from "./pane";
import { PACK_PLUGIN_IDS } from "../../marketplace/packs";
import { setMarketplaceHost, setPluginManager, type MarketplaceHost, type PluginManager } from "../../marketplace/store";

const tui = createOpenTuiTestHarness();
const originalTarget = getCurrentPluginTarget();

afterEach(() => {
  setMarketplaceHost(null);
  setPluginManager(null);
  setCurrentPluginTarget(originalTarget);
  setHttpFetchTransport(null);
});

/**
 * The pane over the research built-ins and one other, with a host that keeps
 * `disabledPlugins` in app state the way the app's does, and records every
 * switch it is asked for.
 */
async function mount(options: { installed?: InstalledPlugin[]; remoteHeads?: PluginManager["remoteHeads"] } = {}) {
  setCurrentPluginTarget("tui");
  let installed = options.installed;
  if (options.remoteHeads) setPluginManager({
    remoteHeads: options.remoteHeads,
    install: async () => ({ ok: false, error: "Unused" }),
    update: async () => ({ ok: false, error: "Unused" }),
    remove: async () => ({ ok: false, error: "Unused" }),
    load: async () => null,
  });
  setHttpFetchTransport(async () => Response.json({ version: 1, generatedAt: "", plugins: [] }));
  const id = PLUGIN_MARKETPLACE_PANE_ID;
  const initial = createInitialState(createTestPaneConfig(":memory:", { instanceId: id, paneId: id }));
  initial.config.disabledPlugins = ["news"];
  const stateRef: { current: AppState } = { current: initial };
  const switches: Array<Record<string, boolean>> = [];
  const notes: AppNotificationRequest[] = [];
  let setState: (state: AppState) => void = () => {};
  // Pane state (the selected row) and switches both land in app state.
  const dispatch = (action: AppAction) => {
    stateRef.current = appReducer(stateRef.current, action);
    setState(stateRef.current);
  };
  const setDisabled = (changes: Record<string, boolean>) => {
    switches.push(changes);
    const next = applyPluginToggles(stateRef.current.config.disabledPlugins, changes);
    if (next) dispatch({ type: "SET_DISABLED_PLUGINS", disabledPlugins: next });
  };
  setMarketplaceHost({
    listInstalled: () => installed ?? [...PACK_PLUGIN_IDS, "news"].map((pluginId) => ({
      id: pluginId,
      name: pluginId === "ticker-core" ? "Ticker Research" : pluginId,
      version: "1.0.0",
      toggleable: true,
      enabled: !stateRef.current.config.disabledPlugins.includes(pluginId),
      source: "builtin" as const,
    })),
    setPluginEnabled: (pluginId, enabled) => setDisabled({ [pluginId]: enabled }),
    setPluginsEnabled: setDisabled,
    contributions: () => ({ panes: [], templates: [], commands: [], capabilities: 0, broker: false }),
    activate: async () => {},
    deactivate: async () => {},
    notify: () => {},
  } satisfies MarketplaceHost);
  const runtime = createStatefulTestPluginRuntime({ notify: (note) => { notes.push(note); } });

  function Harness() {
    const [state, update] = useState(initial);
    setState = update;
    return (
      <TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId="application" runtime={runtime} width={110} height={30}>
        {(body) => <PluginMarketplacePane paneId={id} paneType={id} focused {...body} />}
      </TestPaneFrame>
    );
  }
  await act(async () => { await tui.render(<Harness />, { width: 110, height: 30 }); });
  await settleFrame(tui.setup(), 8);
  const press = async (name: string, sequence = name) => {
    // As the app delivers keys: one handler that takes a key stops the rest.
    await tui.emitKeypress({ name, sequence }, { trackPropagation: true });
    await settleFrame(tui.setup(), 6);
  };
  return {
    stateRef, switches, notes, press,
    setInstalled: async (next: InstalledPlugin[]) => {
      installed = next;
      await act(async () => {
        dispatch({ type: "SET_DISABLED_PLUGINS", disabledPlugins: [...stateRef.current.config.disabledPlugins] });
      });
      await settleFrame(tui.setup(), 3);
    },
  };
}

test("Ticker Research asks before it goes off, and nothing switches on cancel", async () => {
  const { switches, press, stateRef } = await mount();
  expect(tui.frame()).toContain("Ticker Research");

  await press("e");
  expect(tui.frame()).toContain("DES, G and the research pane stop working");
  await press("escape", "\u001b");
  expect(switches).toEqual([]);

  await press("e");
  await press("return", "\r");
  expect(switches).toEqual([{ "ticker-core": false }]);
  expect(stateRef.current.config.disabledPlugins).toEqual(["news", "ticker-core"]);
});

test("a pack chosen from the research heading says what it switches, applies once, only research plugins, and Undo puts the old set back", async () => {
  const { switches, notes, press, stateRef } = await mount();
  expect(tui.frame()).toContain("Everything pack");

  await tui.clickFrameText("Everything pack");
  await settleFrame(tui.setup(), 6);
  // Each pack with what it would switch from here; the one on now is current.
  const chooser = tui.frame();
  expect(chooser).toContain("Apply a starter pack");
  expect(chooser).toMatch(/Everything\s+current/);
  expect(chooser).toMatch(/Options desk\s+8 off/);

  await press("down", "\u001b[B");
  await press("down", "\u001b[B");
  await press("return", "\r");
  expect(tui.frame()).toContain("Apply Options desk?");
  expect(switches).toEqual([]);
  await press("return", "\r");

  expect(switches).toHaveLength(1);
  expect(Object.keys(switches[0]!).every((pluginId) => PACK_PLUGIN_IDS.includes(pluginId))).toBe(true);
  expect(stateRef.current.config.disabledPlugins).toContain("news");
  expect(stateRef.current.config.disabledPlugins).toContain("credit");
  expect(await tui.waitForFrameToContain("Options desk pack")).not.toContain("Everything pack");

  await act(async () => { notes.at(-1)?.action?.onClick(); });
  expect([...stateRef.current.config.disabledPlugins].sort()).toEqual(["news"]);
  await tui.waitForFrameToContain("Everything pack");
});

test("a research plugin switched by hand makes the set custom, and a pack from there counts from what is on", async () => {
  const { switches, press, stateRef } = await mount();

  // From Ticker Research down to Options & Volatility, and off.
  await press("down", "\u001b[B");
  await press("e");
  expect(stateRef.current.config.disabledPlugins).toEqual(["news", "options-volatility"]);
  expect(await tui.waitForFrameToContain("Custom set")).not.toContain("Everything pack");

  await press("a");
  const chooser = tui.frame();
  expect(chooser).not.toContain("current");
  expect(chooser).toMatch(/Everything\s+1 on/);
  expect(chooser).toMatch(/Options desk\s+1 on, 8 off/);

  await press("return", "\r");
  await press("return", "\r");
  expect(switches.at(-1)).toEqual({ "options-volatility": true });
  expect(stateRef.current.config.disabledPlugins).toEqual(["news"]);
  await tui.waitForFrameToContain("Everything pack");
});


const externalPlugin = (id: string): InstalledPlugin => ({
  id, name: `${id} plugin`, version: "1.0.0", enabled: true, toggleable: true,
  source: "external", directory: id, commit: "1111111aaa",
});

for (const failure of ["reject", "partial", "throw"] as const) {
  test(`known plugin updates survive a ${failure} check and refresh replaces answered versions`, async () => {
    let checks = 0;
    const requests: string[][] = [];
    const { press } = await mount({
      installed: [externalPlugin("alpha"), externalPlugin("beta")],
      remoteHeads: (directories) => {
        requests.push([...directories]);
        checks++;
        if (checks === 1) return Promise.resolve({ alpha: "2222222bbb", beta: "3333333ccc" });
        if (checks === 2) {
          if (failure === "partial") return Promise.resolve({ alpha: "1111111aaa", ignored: "4444444ddd" });
          if (failure === "throw") throw new Error("Invented private failure");
          return Promise.reject(new Error("Invented private failure"));
        }
        return Promise.resolve({ alpha: "1111111aaa", beta: "1111111aaa" });
      },
    });
    await tui.waitForFrameToContain("et update");
    // Local changes already recheck remotes on the baseline too.
    await press("e");
    expect(checks).toBe(2);
    const failed = tui.frame();
    expect(failed).toMatch(/beta plugin[^\n]*update/);
    if (failure === "partial") expect(failed).not.toMatch(/alpha plugin[^\n]*update/);
    else expect(failed).toMatch(/alpha plugin[^\n]*update/);
    expect(failed).toContain(failure === "partial" ? "Update check incomplete" : "Plugin update check failed");
    expect(failed).not.toContain("checking unlisted plugins");
    expect(failed).not.toContain("Invented private failure");
    await press("down", "\u001b[B");
    expect(tui.frame()).toContain("et update");
    await press("return", "\r");
    await tui.waitForFrameToContain("3333333");

    // Refresh retries even when the eligible folders did not change.
    if (failure === "partial") await tui.clickFrameText("efresh");
    else await press("r");
    await tui.waitForFrameToExclude("3333333");
    expect(checks).toBe(3);
    expect(requests).toEqual(Array.from({ length: 3 }, () => ["alpha", "beta"]));
    expect(tui.frame()).not.toContain("et update");
    expect(tui.frame()).not.toContain("Update check incomplete");
    expect(tui.frame()).not.toContain("Plugin update check failed");
  });
}

for (const obsolete of ["resolve", "reject"] as const) {
  test(`removed and ineligible plugins lose cached updates despite an obsolete ${obsolete}`, async () => {
    const pending = Promise.withResolvers<Record<string, string>>();
    const reinstalled = Promise.withResolvers<Record<string, string>>();
    let checks = 0;
    const plugin = externalPlugin("alpha");
    const { press, setInstalled } = await mount({
      installed: [plugin],
      remoteHeads: () => {
        checks++;
        if (checks === 1) return Promise.resolve({ alpha: "2222222bbb" });
        if (checks === 2) return pending.promise;
        return reinstalled.promise;
      },
    });
    await tui.waitForFrameToContain("et update");
    await press("e");
    await tui.waitForFrameToContain("checking unlisted plugins");
    await setInstalled([]);
    await tui.waitForFrameToExclude("alpha plugin");
    await act(async () => {
      if (obsolete === "resolve") pending.resolve({ alpha: "3333333ccc" });
      else pending.reject(new Error("Obsolete private failure"));
    });
    await settleFrame(tui.setup(), 3);
    expect(tui.frame()).not.toContain("checking unlisted plugins");
    expect(tui.frame()).not.toContain("Plugin update check failed");
    await setInstalled([{ ...plugin, linked: true }]);
    expect(checks).toBe(2);
    await setInstalled([plugin]);
    await tui.waitForFrameToContain("checking unlisted plugins");
    expect(checks).toBe(3);
    expect(tui.frame()).not.toContain("2222222");
    expect(tui.frame()).not.toContain("3333333");
    expect(tui.frame()).not.toContain("et update");
    await act(async () => { reinstalled.resolve({}); });
    await tui.waitForFrameToContain("Update check incomplete");
    await setInstalled([{ ...plugin, linked: true }]);
    await tui.waitForFrameToExclude("Update check incomplete");
    expect(checks).toBe(3);
  });
}
