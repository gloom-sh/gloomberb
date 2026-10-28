import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient } from "../../../api-client";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { DataServiceUnreachableError } from "../../../utils/network-failure";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { statsCache } from "./cache";
import { EconStatisticsPane } from "./pane";
import { STATS } from "./stats";

const tui = createOpenTuiTestHarness();
afterEach(() => {
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
    await tui.render(
      <TestPaneProvider state={state} paneId="ecst:test" pluginId="market-overview" runtime={createTestPluginRuntime()}>
        <PaneFooterProvider>{() => <Box width={width} height={36}>
          <EconStatisticsPane paneId="ecst:test" paneType="econ-statistics" width={width} height={36} focused />
        </Box>}</PaneFooterProvider>
      </TestPaneProvider>,
      { width, height: 36 },
    );
  });
  for (let frame = 0; frame < 4; frame++) await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tui.setup().renderOnce();
  });
  expect(tui.frame()).toContain("2s10s");
  const scroll = (ticks: number) => act(async () => {
    for (let tick = 0; tick < ticks; tick++) await tui.setup().mockMouse.scroll(width - 1, 34, "down");
    await tui.setup().renderOnce();
  });
  // The High row passes on the way down; the History row under Low pushes it off the last screen at 48 columns.
  await scroll(1);
  expect(tui.frame()).toMatch(/High\s+124\.00%\s+2021-01-01/);
  await scroll(7);
  const scrolled = tui.frame();
  expect(scrolled).toContain("FRED T10Y2Y");
  expect(scrolled).toContain("10Y minus 2Y");
  expect(scrolled).toMatch(/Low\s+100\.00%\s+2019-01-01/);
  // Two years of readings under the 20Y range: the figures say where the history starts.
  expect(scrolled).toMatch(/History\s+2019-01-01\s+to 2021-01-01/);
  expect(scrolled).toContain("20Y");
  expect(scrolled).toContain("All");
  if (partial) {
    expect(scrolled).not.toContain("CPIAUCNS");
    await tui.emitKeypress({ name: "!", sequence: "!", shift: true }, { trackPropagation: true });
    await act(async () => { await tui.setup().renderOnce(); });
    expect(tui.frame()).toContain("CPIAUCNS");
    await tui.emitKeypress({ name: "escape" }, { trackPropagation: true });
    await act(async () => { await tui.setup().renderOnce(); });
    expect(tui.frame()).toContain("FRED T10Y2Y");
  }
});

test("offline, the statistic stays and its footer says when the saved copy is from, not the refresh error", async () => {
  statsCache.attach(new MemoryPluginPersistence());
  const observations = Array.from({ length: 25 }, (_, index) => ({
    date: new Date(Date.UTC(2019, index, 1)).toISOString().slice(0, 10), value: 100 + index,
  })).reverse();
  const series = spyOn(apiClient, "getCloudFredSeries").mockImplementation(async () => ({ observations, info: null }));
  function Harness() {
    const initial = createInitialState(createTestPaneConfig("/tmp/gloom-ecst-saved", {
      instanceId: "ecst:saved", paneId: "econ-statistics", settings: { stat: "curve-spread" },
    }));
    initial.focusedPaneId = "ecst:saved";
    const [state, dispatch] = useReducer(appReducer, initial);
    return <TestPaneFrame state={state} dispatch={dispatch} paneId="ecst:saved" pluginId="market-overview" runtime={createTestPluginRuntime()} width={120} height={36}>
      {(body) => <EconStatisticsPane paneId="ecst:saved" paneType="econ-statistics" focused {...body} />}
    </TestPaneFrame>;
  }
  const settle = async () => {
    for (let frame = 0; frame < 8; frame++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); await tui.setup().renderOnce(); });
    }
  };
  try {
    await act(async () => { await tui.render(<Harness />, { width: 120, height: 36 }); });
    await settle();
    expect(tui.frame()).toContain("FRED T10Y2Y");
    expect(tui.frame()).not.toContain("saved copy");

    series.mockRejectedValue(new DataServiceUnreachableError(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" })));
    await tui.emitKeypress({ name: "r" });
    await settle();
    expect(tui.frame()).toContain("FRED T10Y2Y");
    expect(tui.frame()).toMatch(/saved copy from \d\d:\d\d/);
    expect(tui.frame()).not.toMatch(/couldn't reach/i);
  } finally {
    series.mockRestore();
  }
});
