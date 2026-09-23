import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient } from "../../../api-client";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import {
  attachFredSeriesPersistence,
  resetFredSeriesPersistence,
  type FredSeriesCacheEntry,
} from "../../../data/fred-series";
import { testRender } from "../../../renderers/opentui/test-utils";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import {
  AppContext,
  appReducer,
  createInitialState,
  PaneInstanceProvider,
} from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { cloneLayout, createDefaultConfig } from "../../../types/config";
import { PluginRenderProvider } from "../../runtime";
import { Box } from "../../../ui";
import { CREDIT_SERIES } from "./model";
import { CreditConditionsPane } from "./index";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let persistence: MemoryPluginPersistence;
let requestSpy: ReturnType<typeof spyOn> | undefined;

function entry(seriesId: string, index: number): FredSeriesCacheEntry {
  return {
    fetchedAt: Date.now(),
    stale: false,
    data: {
      observations: [
        { date: "2026-08-17", value: 0.8 + index / 10 },
        { date: "2026-08-18", value: 0.81 + index / 10 },
      ],
      info: {
        id: seriesId,
        title: `${seriesId} Option-Adjusted Spread`,
        units: "Percent",
        frequency: "Daily, Close",
        seasonalAdjustment: "Not Seasonally Adjusted",
        source: "FRED",
        notes: "",
      },
    },
  };
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
      await setup!.renderOnce();
    }
  });
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await setup!.renderOnce();
    });
  }
}

beforeEach(() => {
  resetFredSeriesPersistence();
  persistence = new MemoryPluginPersistence();
  for (const [index, { seriesId }] of CREDIT_SERIES.entries()) {
    persistence.seedResource(
      "fred-series",
      `${seriesId}:limit=300:sort=desc`,
      entry(seriesId, index).data,
      { sourceKey: "gloomberb-cloud", schemaVersion: 2 },
    );
  }
  attachFredSeriesPersistence(persistence);
});

afterEach(async () => {
  if (setup) {
    await act(async () => setup?.renderer.destroy());
    setup = undefined;
  }
  resetFredSeriesPersistence();
  requestSpy?.mockRestore();
  requestSpy = undefined;
});

function Harness({ width }: { width: number }) {
  const config = createDefaultConfig("/tmp/gloomberb-credit-test");
  config.layout = { dockRoot: { kind: "pane", instanceId: "credit:test" }, instances: [{ instanceId: "credit:test", paneId: "credit-conditions", binding: { kind: "none" } }], floating: [], detached: [] };
  config.layouts = [{ name: "Default", layout: cloneLayout(config.layout) }];
  const [state, dispatch] = useReducer(appReducer, createInitialState(config));
  return <AppContext value={{ state, dispatch }}>
    <PaneInstanceProvider paneId="credit:test">
      <PluginRenderProvider pluginId="macro" runtime={createTestPluginRuntime()}>
        <PaneFooterProvider>
          {(footer) => <Box width={width} height={18} flexDirection="column">
            <Box width={width} height={17}>
              <CreditConditionsPane paneId="credit:test" paneType="credit-conditions" focused width={width} height={17} />
            </Box>
            <PaneFooterBar footer={footer} focused width={width} />
          </Box>}
        </PaneFooterProvider>
      </PluginRenderProvider>
    </PaneInstanceProvider>
  </AppContext>;
}

test.each([80, 120])("mixed cached observation dates stay attached to credit values at %i columns", async (width) => {
  const old = entry("BAMLC0A4CBBB", 4).data;
  old.observations = old.observations.slice(0, 1);
  persistence.seedResource("fred-series", "BAMLC0A4CBBB:limit=300:sort=desc", old,
    { sourceKey: "gloomberb-cloud", schemaVersion: 2 });
  requestSpy = spyOn(apiClient, "getCloudFredSeries").mockImplementation(async (seriesId) => {
    const index = CREDIT_SERIES.findIndex((definition) => definition.seriesId === seriesId);
    if (index < 0) throw new Error("Unknown fixture series");
    return entry(seriesId, index).data;
  });
  setup = await testRender(<Harness width={width} />, { width, height: 18 });
  await settle();

  const rowLine = (frame: string, label: string) => frame.split("\n").find((line) => line.includes(label));
  const mixed = setup.captureCharFrame();
  expect(mixed).toContain("AS OF");
  expect(rowLine(mixed, "BBB")).toContain("08-17");
  expect(rowLine(mixed, "AAA")).toContain("08-18");
  expect(requestSpy).not.toHaveBeenCalled();

  await act(async () => { setup!.mockInput.pressKey("r"); });
  await settle();
  const common = setup.captureCharFrame();
  expect(requestSpy).toHaveBeenCalledTimes(CREDIT_SERIES.length);
  expect(rowLine(common, "BBB")).toContain("08-18");
});
