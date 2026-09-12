import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { statsCache } from "./cache";
import { EconStatisticsPane } from "./pane";
import { STATS } from "./stats";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
  statsCache.reset();
});

test.each([
  { width: 48, partial: false },
  { width: 120, partial: false },
  { width: 48, partial: true },
])("selected source and basis remain reachable at $width columns with partial=$partial", async ({ width, partial }) => {
  // Hydrate the actual catalog loader without contacting a provider. Quarter and
  // month series need enough calendar observations for their real transforms.
  statsCache.hydrate(STATS.map((stat) => [stat.seriesId, partial && stat.seriesId === "CPIAUCNS" ? [] : Array.from({ length: 25 }, (_, index) => ({
    date: new Date(Date.UTC(2019, index * (stat.transform === "qoq-annualized" ? 3 : 1), 1)).toISOString().slice(0, 10),
    value: 100 + index,
  }))] as const));
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-ecst-scroll", {
    instanceId: "ecst:test", paneId: "econ-statistics", settings: { stat: "curve-spread" },
  }));
  await act(async () => {
    setup = await testRender(
      <TestPaneProvider state={state} paneId="ecst:test" pluginId="market-overview" runtime={createTestPluginRuntime()}>
        <Box width={width} height={36}>
          <EconStatisticsPane paneId="ecst:test" paneType="econ-statistics" width={width} height={36} focused />
        </Box>
      </TestPaneProvider>,
      { width, height: 36 },
    );
  });
  for (let frame = 0; frame < 4; frame++) await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup!.renderOnce();
  });
  expect(setup!.captureCharFrame()).toContain("2s10s");
  await act(async () => {
    for (let tick = 0; tick < 8; tick++) await setup!.mockMouse.scroll(width - 1, 34, "down");
    await setup!.renderOnce();
  });
  const scrolled = setup!.captureCharFrame();
  expect(scrolled).toContain("FRED T10Y2Y");
  expect(scrolled).toContain("10Y minus 2Y");
  expect(scrolled).toContain("High 124.00% 2021-01-01");
  expect(scrolled).toContain("Low 100.00% 2019-01-01");
  expect(scrolled).toContain("20Y");
  expect(scrolled).toContain("All");
  if (partial) expect(scrolled).toContain("CPIAUCNS");
});
