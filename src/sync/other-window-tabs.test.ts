import { describe, expect, test } from "bun:test";
import { createInitialState } from "../core/state/app/state";
import { createDefaultConfig, type AppConfig } from "../types/config";
import type { OtherWindowTab } from "../types/desktop-window";
import { coreConfigSyncContributor } from "./core-contributors";
import { changesOtherWindowTabs, withOtherWindowTabs, withoutOtherWindowTabs } from "./other-window-tabs";

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
});
