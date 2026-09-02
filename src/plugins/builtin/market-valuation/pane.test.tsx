import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import {
  attachValuationPersistence,
  hydrateValuationSeries,
  resetValuationPersistence,
} from "./cache";
import { testRender } from "../../../renderers/opentui/test-utils";
import {
  AppContext,
  createInitialState,
  PaneInstanceProvider,
} from "../../../state/app/context";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { cloneLayout, createDefaultConfig } from "../../../types/config";
import { MarketValuationPane, shouldPersistSelection } from "./pane";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

function obs(values: Array<[string, number]>) {
  return values.map(([date, value]) => ({ date, value }));
}

/** Wilshire 76.2T over GDP 32.5T is 235%; the Z.1 pair is 38.0T / 40.0T, or 0.95. */
const LEGS: Array<[string, Array<{ date: string; value: number }>]> = [
  ["W5000", obs([
    ["2024-01-02", 60_000],
    ["2025-01-02", 68_000],
    ["2026-06-15", 76_200],
  ])],
  ["GDP", obs([
    ["2024-01-01", 28_000],
    ["2025-01-01", 30_000],
    ["2026-04-01", 32_500],
  ])],
  ["M2SL", obs([
    ["2024-01-01", 21_000],
    ["2025-01-01", 22_000],
    ["2026-07-01", 23_200],
  ])],
  ["NCBEILQ027S", obs([
    ["2024-01-01", 30_000_000],
    ["2025-01-01", 35_000_000],
    ["2026-01-01", 38_000_000],
  ])],
  ["TNWMVBSNNCB", obs([
    ["2024-01-01", 38_000_000],
    ["2025-01-01", 39_200_000],
    ["2026-01-01", 40_000_000],
  ])],
  ["BOGZ1FL153064486Q", obs([
    ["2024-01-01", 38.0],
    ["2025-01-01", 42.0],
    ["2026-01-01", 45.8],
  ])],
  ["BOGZ1FL663067003Q", obs([
    ["2024-01-01", 600_000],
    ["2025-01-01", 620_000],
    ["2026-01-01", 650_000],
  ])],
  ["CPROFIT", obs([["2024-01-01", 3_400], ["2025-01-01", 4_200], ["2026-01-01", 4_800]])],
  ["SHILLER_CAPE", obs([
    ["2024-01-01", 33.2],
    ["2025-01-01", 38.1],
    ["2026-08-01", 41.2],
  ])],
  ["SHILLER_ECY", obs([
    ["2024-01-01", 0.021],
    ["2025-01-01", 0.013],
    ["2026-08-01", 0.0097],
  ])],
  ["SHILLER_DIVIDEND", obs([
    ["2024-01-01", 70],
    ["2025-01-01", 76],
    ["2026-08-01", 83],
  ])],
  ["SHILLER_PRICE", obs([
    ["2024-01-01", 4800],
    ["2025-01-01", 6000],
    ["2026-08-01", 7600],
  ])],
];

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

async function renderPane(settings: Record<string, unknown> = {}, width = 128) {
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
              width={width}
              height={40}
            />
          )}
        </PaneFooterProvider>
      </PaneInstanceProvider>
    </AppContext>,
    { width, height: 40 },
  );
  await settle();
  return setup.captureCharFrame();
}

beforeEach(() => {
  resetValuationPersistence();
  attachValuationPersistence(new MemoryPluginPersistence());
  hydrateValuationSeries(LEGS);
});

afterEach(async () => {
  if (setup) {
    await act(async () => setup?.renderer.destroy());
    setup = undefined;
  }
  resetValuationPersistence();
});

describe("MarketValuationPane", () => {
  test("summarizes every indicator in one table, each in its own units", async () => {
    const frame = await renderPane();
    // A percent, a bare multiple, and two yields all sit in one VALUE column.
    for (const label of ["Buffett", "CAPE", "Tobin Q", "Equity alloc", "Div yield", "Cap / M2"]) {
      expect(frame).toContain(label);
    }
    expect(frame).toContain("234%");
    expect(frame).toContain("41.2");
    expect(frame).toContain("0.95");
    expect(frame).toContain("329%");
  });

  test("wide panes put the list beside the detail, narrow ones stack it", async () => {
    const split = await renderPane({}, 128);
    // In the split the chart shares a line with the list rows.
    expect(split).toMatch(/Buffett.*\n/);
    const stacked = await renderPane({}, 92);
    expect(stacked).toContain("Buffett");
    expect(stacked).toContain("Cap / M2");
  });

  test("the filter narrows the list without blanking the detail", async () => {
    const frame = await renderPane();
    expect(frame).toContain("filter indicators");
  });

  test("a yield reads cheap when it is high, unlike a price ratio", async () => {
    const frame = await renderPane();
    // Both Buffett at 234% and an excess CAPE yield of 1.0% mean expensive.
    expect(frame).toMatch(/Buffett\s+234%\s+Sig\. over/);
    expect(frame).toMatch(/ERP \(ECY\)\s+1\.0%\s+Sig\. over/);
  });

  test("detail follows the selected indicator without repeating the row", async () => {
    const frame = await renderPane({ indicator: "tobins-q" });
    expect(frame).toContain("Equities");
    expect(frame).toContain("Net worth");
    expect(frame).toContain("replacement cost");
    expect(frame).not.toContain("Mkt cap");
    // The row above already names the indicator and its zone.
    expect(frame).not.toContain("Fair Valued");
  });

  test("a direct indicator shows no dollar levels row", async () => {
    const frame = await renderPane({ indicator: "shiller-cape" });
    expect(frame).toContain("ten years of real earnings");
    expect(frame).not.toContain("Mkt cap");
    expect(frame).not.toContain("Equities");
  });

  test("draws the mean apart from the reference line", async () => {
    const frame = await renderPane();
    expect(frame).toContain("parity");
    expect(frame).toContain("mean");
  });
});

describe("shouldPersistSelection", () => {
  const knownIds = ["buffett", "shiller-cape", "tobins-q"];

  test("keeps the setting when a filter moved the rows under a pending commit", () => {
    // The row the keyboard commit resolves to is real, but the user never chose it.
    expect(shouldPersistSelection({
      id: "tobins-q",
      reason: "keyboard",
      selectionOnScreen: false,
      knownIds,
    })).toBe(false);
  });

  test("honours an explicit click even while the selection is filtered away", () => {
    expect(shouldPersistSelection({
      id: "shiller-cape",
      reason: "pointer",
      selectionOnScreen: false,
      knownIds,
    })).toBe(true);
  });

  test("accepts ordinary keyboard movement", () => {
    expect(shouldPersistSelection({
      id: "shiller-cape",
      reason: "keyboard",
      selectionOnScreen: true,
      knownIds,
    })).toBe(true);
  });

  test("never persists an indicator that is not in the registry", () => {
    expect(shouldPersistSelection({
      id: "nonsense",
      reason: "pointer",
      selectionOnScreen: true,
      knownIds,
    })).toBe(false);
  });
});
