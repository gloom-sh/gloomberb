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
import { cloneLayout, createDefaultConfig } from "../../../types/config";
import { MarketValuationPane } from "./pane";

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

const wilshireData = payload("WILL5000PRFC", [
  { date: "2024-01-02", value: 40_000 },
  { date: "2024-07-01", value: 42_000 },
  { date: "2025-01-02", value: 43_500 },
  { date: "2025-07-01", value: 44_000 },
  { date: "2026-01-02", value: 44_500 },
  { date: "2026-06-15", value: 45_000 },
]);

const gdpData = payload("GDP", [
  { date: "2024-01-01", value: 28_000 },
  { date: "2024-04-01", value: 28_500 },
  { date: "2024-07-01", value: 29_000 },
  { date: "2025-01-01", value: 30_000 },
  { date: "2025-07-01", value: 31_000 },
  { date: "2026-01-01", value: 31_400 },
  { date: "2026-04-01", value: 31_700 },
]);

// Z.1 legs arrive in millions; the last pair is 38.0T / 40.0T = 0.95, inside the fair band.
const equitiesData = payload("NCBEILQ027S", [
  { date: "2024-01-01", value: 30_000_000 },
  { date: "2024-07-01", value: 33_000_000 },
  { date: "2025-01-01", value: 35_000_000 },
  { date: "2025-07-01", value: 36_500_000 },
  { date: "2026-01-01", value: 38_000_000 },
]);

const netWorthData = payload("TNWMVBSNNCB", [
  { date: "2024-01-01", value: 38_000_000 },
  { date: "2024-07-01", value: 38_600_000 },
  { date: "2025-01-01", value: 39_200_000 },
  { date: "2025-07-01", value: 39_600_000 },
  { date: "2026-01-01", value: 40_000_000 },
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

const TEST_PANE_ID = "valuation:test";

async function renderPane(settings: Record<string, unknown> = {}) {
  const layout = {
    dockRoot: { kind: "pane" as const, instanceId: TEST_PANE_ID },
    instances: [{ instanceId: TEST_PANE_ID, paneId: "market-valuation", settings }],
    floating: [],
    detached: [],
  };
  const state = createInitialState({
    ...createDefaultConfig("/tmp/gloomberb-valuation-test"),
    layout,
    layouts: [{ name: "Default", layout: cloneLayout(layout) }],
  });
  setup = await testRender(
    <AppContext value={{ state, dispatch: () => {} }}>
      <PaneInstanceProvider paneId={TEST_PANE_ID}>
        <PaneFooterProvider>
          {() => (
            <MarketValuationPane
              paneId={TEST_PANE_ID}
              paneType="market-valuation"
              focused
              width={92}
              height={40}
            />
          )}
        </PaneFooterProvider>
      </PaneInstanceProvider>
    </AppContext>,
    { width: 92, height: 40 },
  );
  await settle();
  return setup.captureCharFrame();
}

beforeEach(() => {
  resetFredSeriesPersistence();
  const persistence = new MemoryPluginPersistence();
  persistence.seedResource("fred-series", "WILL5000PRFC:limit=10000:sort=desc", wilshireData, FRED_SEED_META);
  persistence.seedResource("fred-series", "GDP:limit=340:sort=desc", gdpData, FRED_SEED_META);
  persistence.seedResource("fred-series", "NCBEILQ027S:limit=400:sort=desc", equitiesData, FRED_SEED_META);
  persistence.seedResource("fred-series", "TNWMVBSNNCB:limit=400:sort=desc", netWorthData, FRED_SEED_META);
  attachFredSeriesPersistence(persistence);
});

afterEach(async () => {
  if (setup) {
    await act(async () => setup?.renderer.destroy());
    setup = undefined;
  }
  resetFredSeriesPersistence();
});

describe("MarketValuationPane", () => {
  test("summarizes every indicator in one table, each in its own units", async () => {
    const frame = await renderPane();
    expect(frame).toContain("Buffett");
    expect(frame).toContain("Tobin Q");
    expect(frame).toContain("142%");
    expect(frame).toContain("0.95");
    expect(frame).toContain("Sig. over");
    expect(frame).toContain("Fair");
  });

  test("detail follows the selected indicator without repeating the row", async () => {
    const frame = await renderPane({ indicator: "tobins-q" });
    // Tobin's own leg labels and reference line, not Buffett's.
    expect(frame).toContain("Equities");
    expect(frame).toContain("Net worth");
    expect(frame).toContain("replacement cost");
    expect(frame).not.toContain("Mkt cap");
    // The table row already names the indicator and its zone, so the body must not repeat them.
    expect(frame).not.toContain("Fair Valued");
  });

  test("draws the mean apart from the reference line", async () => {
    const frame = await renderPane();
    expect(frame).toContain("parity");
    expect(frame).toContain("mean");
  });
});
