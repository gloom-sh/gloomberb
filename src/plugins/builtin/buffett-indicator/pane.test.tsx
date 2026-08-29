import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import {
  attachFredSeriesPersistence,
  resetFredSeriesPersistence,
} from "../../../data/fred-series";
import { testRender } from "../../../renderers/opentui/test-utils";
import {
  AppContext,
  createInitialState,
  PaneInstanceProvider,
} from "../../../state/app/context";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createDefaultConfig } from "../../../types/config";
import { BuffettIndicatorPane } from "./pane";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

const FRED_SEED_META = { sourceKey: "gloomberb-cloud", schemaVersion: 1 } as const;

function payload(seriesId: string, observations: Array<{ date: string; value: number }>) {
  return {
    observations,
    info: {
      id: seriesId,
      title: seriesId,
      units: "Billions of Dollars",
      frequency: "Daily",
      seasonalAdjustment: "Not Seasonally Adjusted",
      source: "FRED",
      notes: "",
    },
  };
}

// Wilshire ≈ $45T against GDP ≈ $31.7T → ~142%
const wilshireData = payload("WILL5000PRFC", [
  { date: "2024-01-02", value: 40_000 },
  { date: "2024-07-01", value: 42_000 },
  { date: "2025-01-02", value: 43_500 },
  { date: "2025-07-01", value: 44_000 },
  { date: "2026-01-02", value: 44_500 },
  { date: "2026-06-15", value: 45_000 },
]);

const z1Data = payload("NCBEILQ027S", [
  { date: "2024-01-01", value: 40_000_000 },
  { date: "2024-04-01", value: 42_000_000 },
  { date: "2025-01-01", value: 43_000_000 },
  { date: "2025-04-01", value: 44_000_000 },
  { date: "2026-01-01", value: 44_500_000 },
  { date: "2026-04-01", value: 45_000_000 },
]);

const gdpData = payload("GDP", [
  { date: "2024-01-01", value: 28_000 },
  { date: "2024-04-01", value: 28_500 },
  { date: "2024-07-01", value: 29_000 },
  { date: "2024-10-01", value: 29_500 },
  { date: "2025-01-01", value: 30_000 },
  { date: "2025-04-01", value: 30_500 },
  { date: "2025-07-01", value: 31_000 },
  { date: "2025-10-01", value: 31_200 },
  { date: "2026-01-01", value: 31_400 },
  { date: "2026-04-01", value: 31_700 },
]);

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
  persistence.seedResource("fred-series", "WILL5000PRFC:limit=10000:sort=desc", wilshireData, FRED_SEED_META);
  persistence.seedResource("fred-series", "NCBEILQ027S:limit=340:sort=desc", z1Data, FRED_SEED_META);
  persistence.seedResource("fred-series", "GDP:limit=340:sort=desc", gdpData, FRED_SEED_META);
  attachFredSeriesPersistence(persistence);
});

afterEach(async () => {
  if (setup) {
    await act(async () => setup?.renderer.destroy());
    setup = undefined;
  }
  resetFredSeriesPersistence();
});

describe("BuffettIndicatorPane", () => {
  test("renders ratio and valuation zone from seeded FRED cache", async () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-buffett-test"));
    setup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <PaneInstanceProvider paneId="buffett:test">
          <PaneFooterProvider>
            {() => (
              <BuffettIndicatorPane
                paneId="buffett:test"
                paneType="buffett-indicator"
                focused
                width={84}
                height={40}
              />
            )}
          </PaneFooterProvider>
        </PaneInstanceProvider>
      </AppContext>,
      { width: 84, height: 40 },
    );
    await settle();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("142%");
    expect(frame).toContain("Significantly Overvalued");
    expect(frame).not.toContain("SignifModestly");
    expect(frame).toContain("Cheap");
    expect(frame).toContain("Rich");
    expect(frame).toContain("equals one year of output");
    expect(frame).toContain("Wilshire is daily");
  });
});
