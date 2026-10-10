import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { AppNotificationRequest } from "../../../types/plugin";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { applyPluginToggles } from "../../ownership";
import { PLUGIN_MARKETPLACE_PANE_ID } from "./ids";
import { PluginMarketplacePane } from "./pane";
import { PACK_PLUGIN_IDS } from "./packs";
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
  const setDisabled = (changes: Record<string, boolean>) => {
    switches.push(changes);
    const next = applyPluginToggles(stateRef.current.config.disabledPlugins, changes);
    if (!next) return;
    stateRef.current = appReducer(stateRef.current, { type: "SET_DISABLED_PLUGINS", disabledPlugins: next });
    setState(stateRef.current);
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
      <TestPaneFrame state={state} dispatch={() => {}} paneId={id} pluginId="application" runtime={runtime} width={110} height={30}>
        {(body) => <PluginMarketplacePane paneId={id} paneType={id} focused {...body} />}
      </TestPaneFrame>
    );
  }
  await act(async () => { await tui.render(<Harness />, { width: 110, height: 30 }); });
  await settleFrame(tui.setup(), 8);
  const press = async (name: string, sequence = name) => {
    await tui.emitKeypress({ name, sequence });
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

test("a pack from the strip switches once, only research plugins, and Undo puts the old set back", async () => {
  const { switches, notes, press, stateRef } = await mount();

  await tui.clickFrameText("Options");
  await settleFrame(tui.setup(), 6);
  expect(tui.frame()).toContain("Switch to Options desk?");
  await press("return", "\r");

  expect(switches).toHaveLength(1);
  expect(Object.keys(switches[0]!).every((pluginId) => PACK_PLUGIN_IDS.includes(pluginId))).toBe(true);
  expect(stateRef.current.config.disabledPlugins).toContain("news");
  expect(stateRef.current.config.disabledPlugins).toContain("credit");

  await act(async () => { notes.at(-1)?.action?.onClick(); });
  expect([...stateRef.current.config.disabledPlugins].sort()).toEqual(["news"]);
});
