import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import {
  attachFredSeriesPersistence,
  resetFredSeriesPersistence,
  type FredSeriesCacheEntry,
} from "../../../data/fred-series";
import { createTestControls, testRender } from "../../../renderers/opentui/test-utils";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import {
  AppContext,
  createInitialState,
  PaneInstanceProvider,
} from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
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
      `${seriesId}:limit=45:sort=desc`,
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

test.each([80, 120])("mixed cached observation dates stay attached to credit values at %i columns", async (width) => {
  const old = entry("BAMLC0A4CBBB", 4).data;
  old.observations = old.observations.slice(0, 1);
  persistence.seedResource("fred-series", "BAMLC0A4CBBB:limit=45:sort=desc", old,
    { sourceKey: "gloomberb-cloud", schemaVersion: 2 });
  requestSpy = spyOn(apiClient, "getCloudFredSeries").mockImplementation(async (seriesId) => {
    const index = CREDIT_SERIES.findIndex((definition) => definition.seriesId === seriesId);
    if (index < 0) throw new Error("Unknown fixture series");
    return entry(seriesId, index).data;
  });
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-credit-test"));
  setup = await testRender(
    <AppContext value={{ state, dispatch: () => {} }}>
      <PaneInstanceProvider paneId="credit:test">
        <PaneFooterProvider>
          {(footer) => <Box width={width} height={18} flexDirection="column">
            <Box width={width} height={17}>
              <CreditConditionsPane paneId="credit:test" paneType="credit-conditions" focused width={width} height={17} />
            </Box>
            <PaneFooterBar footer={footer} focused width={width} />
          </Box>}
        </PaneFooterProvider>
      </PaneInstanceProvider>
    </AppContext>,
    { width, height: 18 },
  );
  await settle();

  const mixed = setup.captureCharFrame();
  expect(mixed).toContain("mixed dates");
  expect(mixed).not.toContain("as of 2026-08-18");
  expect(mixed).toContain("AS OF");
  expect(mixed.split("\n").find((line) => line.includes("BBB"))).toContain("2026-08-17");
  expect(mixed.split("\n").find((line) => line.includes("AAA"))).toContain("2026-08-18");
  expect(requestSpy).not.toHaveBeenCalled();

  const controls = createTestControls(() => setup!);
  await controls.clickFrameText("AS OF");
  await settle();
  await controls.clickFrameText("AS OF");
  await settle();
  const sorted = setup.captureCharFrame();
  expect(sorted.indexOf("BBB")).toBeLessThan(sorted.indexOf("AAA"));

  await act(async () => { setup!.mockInput.pressKey("r"); });
  await settle();
  const common = setup.captureCharFrame();
  expect(requestSpy).toHaveBeenCalledTimes(CREDIT_SERIES.length);
  expect(common).toContain("as of 2026-08-18");
  expect(common).not.toContain("mixed dates");
  expect(common).not.toContain("AS OF");
});
