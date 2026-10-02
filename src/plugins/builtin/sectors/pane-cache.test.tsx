import { expect, test } from "bun:test";
import { act, useReducer } from "react";
import { createOpenTuiTestHarness, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { blockExternalNetwork } from "../../../test-support/network-guard";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { sectorsModule } from "./index";

blockExternalNetwork();

const Pane = sectorsModule.panes![0]!.component;
const tui = createOpenTuiTestHarness();

for (const version of ["v3", "v4"]) test(`opening without a provider handles the ${version} computed-row cache`, async () => {
  const config = createTestPaneConfig("/tmp/gloomberb-sector-cache-test", {
    instanceId: "sector-cache", paneId: "sectors", settings: { industryEtfs: ["GDX"] },
  });
  config.refreshIntervalMinutes = 0;
  const state = createInitialState(config);
  state.focusedPaneId = "sector-cache";
  state.paneState["sector-cache"] = { pluginState: { "market-overview": {
    activeCollectionId: "industries", selectedEtf: "GDX",
    [`rowsByCollection:${version}`]: { sectors: [], industries: [{
      name: "Gold Miners", etf: "GDX", price: version === "v3" ? 150 : 110, currency: "USD", changePercent: 0,
      return1M: version === "v3" ? 50 : 10, return1Y: version === "v3" ? 50 : 10,
      returnAsOfDate: "2026-09-10", return1MStartDate: version === "v3" ? "2026-08-07" : "2026-08-10",
      return1YStartDate: version === "v3" ? "2025-09-09" : "2025-09-10", loading: false,
    }] },
  } } };
  const runtime = createTestPluginRuntime(); // No provider is connected during reopening.
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneProvider state={current} dispatch={dispatch} paneId="sector-cache" pluginId="market-overview" runtime={runtime}>
      <Pane paneId="sector-cache" paneType="sectors" focused width={82} height={10} />
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 82, height: 10 }); });
  for (let index = 0; index < 4; index++) await act(async () => { await tui.setup().renderOnce(); });
  const frame = tui.frame();
  await exportPaneTable("sector-cache", `${version}.csv`);
  const csv = takeSavedTextFile()!.text;
  expect(frame).toContain("GDX");
  expect(csv).not.toContain("50.00");
  expect(frame).not.toContain("+50.00%");
  expect(csv.includes(",10.00,10.00")).toBe(version === "v4");
  expect(frame.includes("+10.00%")).toBe(version === "v4");
});
