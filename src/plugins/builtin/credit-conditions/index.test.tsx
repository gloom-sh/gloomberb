import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import {
  attachFredSeriesPersistence,
  resetFredSeriesPersistence,
  type FredSeriesCacheEntry,
} from "../../../data/fred-series";
import { testRender } from "../../../renderers/opentui/test-utils";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import {
  AppContext,
  createInitialState,
  PaneInstanceProvider,
} from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import { CREDIT_SERIES } from "./model";
import { CreditConditionsPane } from "./index";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

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
  const persistence = new MemoryPluginPersistence();
  for (const [index, { seriesId }] of CREDIT_SERIES.entries()) {
    persistence.seedResource(
      "fred-series",
      `${seriesId}:limit=45:sort=desc`,
      entry(seriesId, index).data,
      { sourceKey: "gloomberb-cloud", schemaVersion: 1 },
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
});

describe("CreditConditionsPane", () => {
  test("selects credit rows with keyboard and mouse", async () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-credit-test"));
    setup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <PaneInstanceProvider paneId="credit:test">
          <PaneFooterProvider>
            {() => <CreditConditionsPane paneId="credit:test" paneType="credit-conditions" focused width={72} height={18} />}
          </PaneFooterProvider>
        </PaneInstanceProvider>
      </AppContext>,
      { width: 72, height: 18 },
    );
    await settle();

    expect(setup.captureCharFrame()).toContain(`${CREDIT_SERIES[0].seriesId} Option-Adjusted Spread`);

    await act(async () => {
      setup!.mockInput.pressArrow("up");
      setup!.mockInput.pressEnter();
      await setup!.renderOnce();
    });
    await settle();
    const keyboardTitle = `${CREDIT_SERIES[5].seriesId} Option-Adjusted Spread`;
    expect(setup.captureCharFrame()).toContain(keyboardTitle);

    let mouseSelected = false;
    for (let row = 3; row < 9 && !mouseSelected; row += 1) {
      await act(async () => {
        await setup!.mockMouse.click(2, row);
        await setup!.renderOnce();
      });
      mouseSelected = !setup.captureCharFrame().includes(keyboardTitle);
    }
    expect(mouseSelected).toBe(true);
  });
});
