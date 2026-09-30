import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient } from "../../../api-client";
import {
  attachFredSeriesPersistence,
  resetFredSeriesPersistence,
  type FredSeriesCacheEntry,
} from "../../../data/fred-series";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { CREDIT_SERIES } from "./model";
import { CreditConditionsPane } from "./index";

const tui = createOpenTuiTestHarness();
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
      await tui.setup().renderOnce();
    }
  });
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await tui.setup().renderOnce();
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

afterEach(() => {
  resetFredSeriesPersistence();
  requestSpy?.mockRestore();
  requestSpy = undefined;
});

function Harness({ width }: { width: number }) {
  const config = createTestPaneConfig("/tmp/gloomberb-credit-test", { instanceId: "credit:test", paneId: "credit-conditions", binding: { kind: "none" } });
  const [state, dispatch] = useReducer(appReducer, createInitialState(config));
  return <TestPaneFrame state={state} dispatch={dispatch} paneId="credit:test" pluginId="macro" runtime={createTestPluginRuntime()} width={width} height={18}>
    {(body) => <CreditConditionsPane paneId="credit:test" paneType="credit-conditions" focused {...body} />}
  </TestPaneFrame>;
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
  await tui.render(<Harness width={width} />, { width, height: 18 });
  await settle();

  const rowLine = (frame: string, label: string) => frame.split("\n").find((line) => line.includes(label));
  const mixed = tui.frame();
  expect(mixed).toContain("AS OF");
  expect(rowLine(mixed, "BBB")).toContain("08-17");
  expect(rowLine(mixed, "AAA")).toContain("08-18");
  expect(requestSpy).not.toHaveBeenCalled();

  await act(async () => { tui.setup().mockInput.pressKey("r"); });
  await settle();
  const common = tui.frame();
  expect(requestSpy).toHaveBeenCalledTimes(CREDIT_SERIES.length);
  expect(rowLine(common, "BBB")).toContain("08-18");
});
