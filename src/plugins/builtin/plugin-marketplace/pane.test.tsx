import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { AppNotificationRequest } from "../../../types/plugin";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { applyPluginToggles } from "../../ownership";
import { PLUGIN_MARKETPLACE_PANE_ID } from "../../marketplace/ids";
import { PluginMarketplacePane } from "./pane";
import { PACK_PLUGIN_IDS } from "../../marketplace/packs";
import { setMarketplaceHost, type MarketplaceHost } from "./store";

const tui = createOpenTuiTestHarness();

afterEach(() => {
  setMarketplaceHost(null);
  setHttpFetchTransport(null);
});

/**
 * The pane over the research built-ins and one other, with a host that keeps
 * `disabledPlugins` in app state the way the app's does, and records every
 * switch it is asked for.
 */
async function mount() {
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
    listInstalled: () => [...PACK_PLUGIN_IDS, "news"].map((pluginId) => ({
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
  return { stateRef, switches, notes, press };
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
