import { expect, test } from "bun:test";
import { resolveRegistryPaneQuickSettings, resolveRegistryPaneSettings } from "../../registry/pane-settings";
import { createTestPaneConfig } from "../../../test-support/pane";
import { realizedVolModule } from "./index";

// The pane draws the current ATM IV until it is turned off. Read from the
// unset setting, its header control said "Current ATM IV: off" over a chart
// that showed it, and its first press changed nothing on screen.
test("the IV control reads on until it is turned off, as the pane draws it", () => {
  const pane = realizedVolModule.panes![0]!;
  const quick = (settings: Record<string, unknown>) => {
    const config = createTestPaneConfig(":memory:", { instanceId: pane.id, paneId: pane.id, settings });
    const resolved = resolveRegistryPaneSettings({
      config,
      getConfigState: () => null,
      getPaneRuntimeState: () => ({}),
      layout: config.layout,
      paneDefs: new Map([[pane.id, pane]]),
      paneOwners: new Map(),
      resolvePaneTarget: () => pane.id,
      requestedPaneId: pane.id,
    });
    return resolveRegistryPaneQuickSettings(resolved).find((setting) => setting.key === "showIv");
  };
  expect(quick({})).toMatchObject({ value: true, nextValue: false });
  expect(quick({ showIv: false })).toMatchObject({ value: false, nextValue: true });
});
