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

test("the selected yield cites its latest observation while other statistics still cite their own series", async () => {
  const series = spyOn(apiClient, "getCloudFredSeries").mockImplementation(async (id) => ({ observations: [
    { date: "2026-11-17", value: 4.2 },
    { date: "2026-11-18", value: 4.21 },
    { date: "2026-11-19", value: 4.25, ...(id === "DGS10" ? { publisher: "U.S. Treasury", publishedAt: "2026-11-20" } : {}) },
  ], info: null }));
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-ecst-attribution-unused", {
    instanceId: "ecst:attribution", paneId: "econ-statistics", settings: { stat: "ten-year" },
  }));
  initial.focusedPaneId = "ecst:attribution";
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, initial);
    return <TestPaneFrame state={state} dispatch={dispatch} paneId="ecst:attribution" pluginId="market-overview" runtime={createTestPluginRuntime()} width={160} height={38}>
      {(body) => <EconStatisticsPane paneId="ecst:attribution" paneType="econ-statistics" focused {...body} />}
    </TestPaneFrame>;
  }
  try {
    await act(async () => { await tui.render(<Harness />, { width: 160, height: 38 }); });
    await tui.waitForFrameToContain("U.S. Treasury, published 2026-11-20");
    expect(tui.frame()).toContain("reading for 19 Nov 2026 15:30 ET");
    await tui.emitKeypress({ name: "down" });
    await tui.waitForFrameToContain("Federal Reserve Board via FRED");
    expect(tui.frame()).not.toContain("published 2026-11-20");
  } finally {
    series.mockRestore();
  }
});

test("housing chart ticks use the table's millions and the period keeps its year", async () => {
  statsCache.hydrate(STATS.map((stat) => [stat.seriesId, Array.from({ length: 25 }, (_, index) => ({
    date: new Date(Date.UTC(2024, index, 1)).toISOString().slice(0, 10), value: 500 + index * 50,
  }))] as const));
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-ecst-axis", {
    instanceId: "ecst:axis", paneId: "econ-statistics", settings: { stat: "housing-starts" },
  }));
  await act(async () => {
    await tui.render(<TestPaneFrame state={state} dispatch={() => {}} paneId="ecst:axis" pluginId="market-overview" runtime={createTestPluginRuntime()} width={240} height={60}>
      {(body) => <EconStatisticsPane paneId="ecst:axis" paneType="econ-statistics" focused {...body} />}
    </TestPaneFrame>, { width: 240, height: 60 });
  });
  for (let frame = 0; frame < 4; frame++) await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0)); await tui.setup().renderOnce();
  });
  expect(tui.frame()).toContain("1.700M");
  expect(tui.frame()).toContain("1.000M");
  expect(tui.frame()).toContain("Jan 2026");
  expect(tui.frame()).not.toContain("1.0K");
  expect(tui.frame()).toContain("Rates & Money");
});

test("the selected Michigan series labels publication lag without warning on the next indicator", async () => {
  statsCache.hydrate(STATS.map((stat) => [stat.seriesId, Array.from({ length: 25 }, (_, index) => ({
    date: new Date(Date.UTC(2024, index, 1)).toISOString().slice(0, 10), value: 100 + index,
  }))] as const));
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-ecst-lag", {
    instanceId: "ecst:lag", paneId: "econ-statistics", settings: { stat: "consumer-sentiment" },
  }));
  state.focusedPaneId = "ecst:lag";
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneFrame state={current} dispatch={dispatch} paneId="ecst:lag" pluginId="market-overview" runtime={createTestPluginRuntime()} width={240} height={48}>
      {(body) => <EconStatisticsPane paneId="ecst:lag" paneType="econ-statistics" focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => {
    await tui.render(<Harness />, { width: 240, height: 48 });
  });
  for (let frame = 0; frame < 4; frame++) await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0)); await tui.setup().renderOnce();
  });
  expect(tui.frame()).toContain("delayed one month");
  await tui.emitKeypress({ name: "down" });
  await act(async () => { await tui.setup().renderOnce(); });
  expect(tui.frame()).not.toContain("delayed one month");
});

test("GDPNow renders its current reading before the previous update arrives", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof apiClient.getCloudEconomicCalendarFrom>>>();
  const calendar = spyOn(apiClient, "getCloudEconomicCalendarFrom").mockReturnValue(pending.promise);
  const fred = spyOn(apiClient, "getCloudFredSeries").mockImplementation(async (series) => ({ info: null,
    observations: series === "GDPNOW" ? [{ date: "2026-10-01", value: 3.2093, revisedOn: "2026-11-18" }] : [],
  }));
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-ecst-previous", {
    instanceId: "ecst:previous", paneId: "econ-statistics", settings: { stat: "gdpnow", range: "ALL" },
  }));
  try {
    await tui.render(<TestPaneFrame state={state} dispatch={() => {}} paneId="ecst:previous" pluginId="market-overview" runtime={createTestPluginRuntime()} width={160} height={36}>
      {(body) => <EconStatisticsPane paneId="ecst:previous" paneType="econ-statistics" focused {...body} />}
    </TestPaneFrame>, { width: 160, height: 36 });
    await tui.waitForFrameToContain("3.2%");
    expect(calendar).toHaveBeenCalledWith("2026-11-18", { signal: expect.any(AbortSignal) });
    expect(tui.frame()).not.toContain("3.4%");

    await act(async () => {
      pending.resolve({ storedFrom: null, events: [{ id: "atlanta-fed-gdpnow-2026-11-18-2026-Q4",
        event: "Atlanta Fed GDPNow", date: "2026-11-18T00:00:00.000Z", time: "All Day", country: "US", impact: "medium",
        referencePeriod: "2026 Q4", actual: "3.2093%", forecast: null, prior: "3.3842%", priorAsOf: "2026-11-17" }] });
    });
    await tui.waitForFrameToContain("3.4%");
  } finally {
    pending.resolve({ storedFrom: null, events: [] });
    calendar.mockRestore();
    fred.mockRestore();
  }
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
  expect(tui.frame()).toMatch(/High\s+124\.00%\s+Jan 2021/);
  await scroll(7);
  const scrolled = tui.frame();
  expect(scrolled).toContain("FRED T10Y2Y");
  expect(scrolled).toContain("10Y minus 2Y");
  expect(scrolled).toMatch(/Low\s+100\.00%\s+Jan 2019/);
  // Two years of readings under the 20Y range: the figures say where the history starts.
  expect(scrolled).toMatch(/History\s+01 Jan 2019\s+to 01 Jan 2021/);
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
