import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ApiRequestError } from "../../../api-client/errors";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import {
  attachFredSeriesPersistence,
  loadCachedFredSeries,
  resetFredSeriesPersistence,
  type FredSeriesData,
} from "../../../sources/gloomberb-cloud/fred-series";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { outage } from "../../../test-support/outage";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { ChartSnapshotContext } from "../../../time-series/hooks";
import { useChartResolution } from "../../../time-series/use-chart-resolution";
import { ChartComposerPane } from "./pane";
import { buildCustomChartPreset } from "./presets";

const tui = createOpenTuiTestHarness();
afterEach(resetFredSeriesPersistence);

const CPI: FredSeriesData = {
  observations: Array.from({ length: 13 }, (_, month) => ({
    date: new Date(Date.UTC(2025, 2 + month, 1)).toISOString().slice(0, 10), value: 310 + month,
  })),
  info: null,
};

/** The chart with its footer bar, its FRED series read through the shared cache from `fetch`. */
async function renderChart(fetch: () => Promise<FredSeriesData>) {
  const spec = buildCustomChartPreset("FRED:CPIAUCSL");
  spec.viewport.dateWindow = { start: "2025-03-01", end: "2026-03-31" };
  const provider = createTestDataProvider();
  const sources = {
    dataProvider: provider,
    now: new Date("2026-03-31T00:00:00Z"),
    loadFredSeries: (request: Parameters<typeof loadCachedFredSeries>[0]) => loadCachedFredSeries(request, fetch),
  };
  const paneId = "chart-saved-copy";
  const state = createInitialState(createTestPaneConfig("/tmp/chart-saved-copy-unused", {
    instanceId: paneId, paneId: "chart-composer", settings: { chartSpec: spec },
  }));
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  function Harness() {
    const resolution = useChartResolution(spec, sources, { liveRefreshIntervalMs: 0 });
    return <ChartSnapshotContext value={resolution}>
      <TestPaneFrame state={state} paneId={paneId} pluginId="charts" runtime={runtime} width={120} height={24}>
        {(body) => <ChartComposerPane paneId={paneId} paneType="chart-composer" focused {...body} />}
      </TestPaneFrame>
    </ChartSnapshotContext>;
  }
  await tui.render(<Harness />, { width: 120, height: 24 });
  for (let index = 0; index < 20; index += 1) {
    await act(async () => { await Bun.sleep(5); await tui.setup().renderOnce(); });
  }
}

const footer = () => tui.frame().replace(/\n+$/, "").split("\n").at(-1)!.replace(/^└\s*|┘$/g, "").trim();

// A FRED series Gloom Cloud stopped serving, or a refused session, charted its saved copy as "saved copy from".
test("a FRED series a failed refresh left leads the chart's footer with when it was saved; a refusal is the chart's error", async () => {
  // What the chart saves, saved again as a copy past its refresh time.
  const fresh = new MemoryPluginPersistence();
  const saves: Array<Parameters<MemoryPluginPersistence["setResource"]>> = [];
  const setResource = fresh.setResource.bind(fresh);
  fresh.setResource = ((...args: Parameters<MemoryPluginPersistence["setResource"]>) => { saves.push(args); return setResource(...args); }) as never;
  attachFredSeriesPersistence(fresh);
  await renderChart(async () => CPI);
  expect(footer()).not.toContain("saved copy");
  const [kind, key, value, options] = saves[0]!;
  const saved = new MemoryPluginPersistence();
  saved.seedResource(kind, key, value, { sourceKey: options.sourceKey, schemaVersion: options.schemaVersion, stale: true });
  resetFredSeriesPersistence();
  attachFredSeriesPersistence(saved);

  await renderChart(async () => { throw outage(); });
  expect(footer()).toMatch(/^saved copy from \d\d:\d\d/);

  for (const refusal of [new ApiRequestError("Series not found", 404), new ApiRequestError("Sign in to continue", 401)]) {
    await renderChart(async () => { throw refusal; });
    expect(tui.frame()).toContain(refusal.message);
    expect(tui.frame()).not.toContain("saved copy");
  }
});
