import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createInitialState, type AppAction } from "../core/state/app/state";
import * as configStore from "../data/config/store";
import { createDefaultConfig, type AppConfig } from "../types/config";
import type { OtherWindowTab } from "../types/desktop-window";
import { coreConfigSyncContributor } from "./core-contributors";
import { changesOtherWindowTabs, createSyncConfigDispatch, withOtherWindowTabs, withoutOtherWindowTabs } from "./other-window-tabs";

/** Home, Monitor and Macro with ids; another window holds Monitor, the main window shows Macro. */
function setup() {
  const base = createDefaultConfig("/tmp/gloom-other-window-tabs");
  const all = base.layouts.map((entry) => ({ ...entry, id: `tab:${entry.name.toLowerCase()}` }));
  const others: OtherWindowTab[] = [{ at: 1, tab: all[1]! }];
  const main: AppConfig = { ...base, layouts: [all[0]!, all[2]!], activeLayoutIndex: 1, layout: all[2]!.layout };
  return { all, others, state: createInitialState(main) };
}

describe("cloud sync in the main desktop window", () => {
  test("a push carries every window's tabs at their places, with the main window's tab active", async () => {
    const { others, state } = setup();
    const payload = await coreConfigSyncContributor.collect({ state: withOtherWindowTabs(state, others), baselinePayload: null }) as {
      layouts: Array<{ name: string }>;
      activeLayoutIndex: number;
    };
    expect(payload.layouts.map((entry) => entry.name)).toEqual(["Home", "Monitor", "Macro"]);
    expect(payload.activeLayoutIndex).toBe(2);
    // One window: the state itself.
    expect(withOtherWindowTabs(state, [])).toBe(state);
  });

  test("a pulled config lands in the main window without the other windows' tabs, on the tab it shows", () => {
    const { all, others, state } = setup();
    const pulled: AppConfig = {
      ...state.config,
      layouts: [all[0]!, { ...all[1]!, name: "Desk" }, { ...all[2]!, name: "Rates" }],
      // The other device was on the tab another window holds here.
      activeLayoutIndex: 1,
      layout: all[1]!.layout,
    };
    // The change to the other window's tab goes to the backend whole; one to the main window's own tabs only does not.
    expect(changesOtherWindowTabs(pulled, others)).toBe(true);
    expect(changesOtherWindowTabs({ ...pulled, layouts: [all[0]!, all[1]!, { ...all[2]!, name: "Rates" }] }, others)).toBe(false);
    const landed = withoutOtherWindowTabs(pulled, others, state.config);
    expect(landed.layouts.map((entry) => entry.name)).toEqual(["Home", "Rates"]);
    expect(landed.activeLayoutIndex).toBe(1);
    expect(landed.layout).toBe(all[2]!.layout);
  });

  test("a pulled change to another window's tab that cannot be saved is said, and the main window still takes its part", async () => {
    const { all, others, state } = setup();
    const save = spyOn(configStore, "saveConfig").mockRejectedValue(new Error("disk full"));
    const dispatched: AppAction[] = [];
    const failed = Promise.withResolvers<void>();
    const dispatch = createSyncConfigDispatch({
      dispatch: (action) => dispatched.push(action),
      otherWindowTabs: () => others,
      currentConfig: () => state.config,
      onSaveFailure: () => failed.resolve(),
    });
    const pulled: AppConfig = { ...state.config, layouts: [all[0]!, { ...all[1]!, name: "Desk" }, all[2]!] };
    dispatch({ type: "SET_CONFIG", config: pulled });
    await failed.promise;
    expect(save).toHaveBeenCalledWith(pulled);
    expect(dispatched.map((action) => action.type === "SET_CONFIG" && action.config.layouts.map((entry) => entry.name))).toEqual([["Home", "Macro"]]);
  });
});

afterEach(() => {
  mock.restore();
});
